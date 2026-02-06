/**
 * HTTP CONNECT proxy for network domain filtering.
 *
 * Creates a local HTTP proxy that intercepts CONNECT requests and
 * filters them based on a domain allowlist callback.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { URL } from "node:url";

export interface HttpProxyOptions {
	filter(port: number, host: string, socket: Socket | Duplex): Promise<boolean> | boolean;
}

export function createHttpProxyServer(options: HttpProxyOptions): Server {
	const server = createServer();

	server.on("connect", async (req, socket: Socket) => {
		socket.on("error", () => {
			// Client disconnected
		});

		try {
			const [hostname, portStr] = req.url!.split(":");
			const port = portStr === undefined ? undefined : Number.parseInt(portStr, 10);

			if (!hostname || !port) {
				socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
				return;
			}

			const allowed = await options.filter(port, hostname, socket);
			if (!allowed) {
				socket.end(
					"HTTP/1.1 403 Forbidden\r\n" +
						"Content-Type: text/plain\r\n" +
						"X-Proxy-Error: blocked-by-allowlist\r\n" +
						"\r\n" +
						"Connection blocked by network allowlist",
				);
				return;
			}

			const serverSocket = connect(port, hostname, () => {
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				serverSocket.pipe(socket);
				socket.pipe(serverSocket);
			});

			serverSocket.on("error", () => {
				socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			});
			socket.on("error", () => {
				serverSocket.destroy();
			});
			socket.on("end", () => serverSocket.end());
			serverSocket.on("end", () => socket.end());
		} catch {
			socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
		}
	});

	server.on("request", async (req, res) => {
		try {
			const url = new URL(req.url!);
			const hostname = url.hostname;
			const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;

			const allowed = await options.filter(port, hostname, req.socket);
			if (!allowed) {
				res.writeHead(403, { "Content-Type": "text/plain", "X-Proxy-Error": "blocked-by-allowlist" });
				res.end("Connection blocked by network allowlist");
				return;
			}

			const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
			const proxyReq = requestFn(
				{
					hostname,
					port,
					path: url.pathname + url.search,
					method: req.method,
					headers: { ...req.headers, host: url.host },
				},
				(proxyRes) => {
					res.writeHead(proxyRes.statusCode!, proxyRes.headers);
					proxyRes.pipe(res);
				},
			);

			proxyReq.on("error", () => {
				if (!res.headersSent) {
					res.writeHead(502, { "Content-Type": "text/plain" });
					res.end("Bad Gateway");
				}
			});

			req.pipe(proxyReq);
		} catch {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Internal Server Error");
		}
	});

	return server;
}
