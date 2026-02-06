/**
 * Minimal SOCKS5 proxy server for network domain filtering.
 *
 * Implements just enough of RFC 1928 to handle CONNECT requests
 * with domain name resolution (ATYP 0x03). No auth required.
 */

import { connect, createServer, type Server, type Socket } from "node:net";

// SOCKS5 constants
const SOCKS_VERSION = 0x05;
const AUTH_NONE = 0x00;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_FAILURE = 0x01;
const REP_NOT_ALLOWED = 0x02;
const REP_ADDR_TYPE_NOT_SUPPORTED = 0x08;

export interface SocksProxyOptions {
	filter(port: number, host: string): Promise<boolean> | boolean;
}

export interface SocksProxyWrapper {
	server: Server;
	getPort(): number | undefined;
	listen(port: number, hostname: string): Promise<number>;
	close(): Promise<void>;
	unref(): void;
}

function buildReply(rep: number, bindAddr = "0.0.0.0", bindPort = 0): Buffer {
	const parts = bindAddr.split(".").map(Number);
	return Buffer.from([
		SOCKS_VERSION,
		rep,
		0x00, // RSV
		ATYP_IPV4,
		parts[0] ?? 0,
		parts[1] ?? 0,
		parts[2] ?? 0,
		parts[3] ?? 0,
		(bindPort >> 8) & 0xff,
		bindPort & 0xff,
	]);
}

function handleConnection(client: Socket, filter: SocksProxyOptions["filter"]): void {
	let phase: "greeting" | "request" | "connected" = "greeting";

	client.once("data", (greeting) => {
		// Greeting: VER NMETHODS METHODS...
		if (greeting[0] !== SOCKS_VERSION) {
			client.destroy();
			return;
		}

		// Reply: VER METHOD (no auth)
		client.write(Buffer.from([SOCKS_VERSION, AUTH_NONE]));
		phase = "request";

		client.once("data", async (request) => {
			// Request: VER CMD RSV ATYP DST.ADDR DST.PORT
			if (request[0] !== SOCKS_VERSION || request[1] !== CMD_CONNECT) {
				client.write(buildReply(REP_FAILURE));
				client.destroy();
				return;
			}

			const atyp = request[3];
			let hostname: string;
			let port: number;
			let addrEnd: number;

			if (atyp === ATYP_IPV4) {
				hostname = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
				addrEnd = 8;
			} else if (atyp === ATYP_DOMAIN) {
				const domainLen = request[4];
				hostname = request.subarray(5, 5 + domainLen).toString("ascii");
				addrEnd = 5 + domainLen;
			} else if (atyp === ATYP_IPV6) {
				// IPv6: 16 bytes
				const ipv6Parts: string[] = [];
				for (let i = 0; i < 8; i++) {
					ipv6Parts.push(request.readUInt16BE(4 + i * 2).toString(16));
				}
				hostname = ipv6Parts.join(":");
				addrEnd = 20;
			} else {
				client.write(buildReply(REP_ADDR_TYPE_NOT_SUPPORTED));
				client.destroy();
				return;
			}

			port = (request[addrEnd] << 8) | request[addrEnd + 1];

			try {
				const allowed = await filter(port, hostname);
				if (!allowed) {
					client.write(buildReply(REP_NOT_ALLOWED));
					client.destroy();
					return;
				}
			} catch {
				client.write(buildReply(REP_FAILURE));
				client.destroy();
				return;
			}

			// Connect to target
			const target = connect(port, hostname, () => {
				phase = "connected";
				client.write(buildReply(REP_SUCCESS));
				target.pipe(client);
				client.pipe(target);
			});

			target.on("error", () => {
				if (phase !== "connected") {
					client.write(buildReply(REP_FAILURE));
				}
				client.destroy();
			});

			client.on("error", () => {
				target.destroy();
			});

			client.on("end", () => target.end());
			target.on("end", () => client.end());
		});
	});

	client.on("error", () => {
		// Swallow client errors
	});
}

export function createSocksProxyServer(options: SocksProxyOptions): SocksProxyWrapper {
	const server = createServer((client) => {
		handleConnection(client, options.filter);
	});

	return {
		server,
		getPort(): number | undefined {
			const address = server.address();
			if (address && typeof address === "object" && "port" in address) {
				return address.port;
			}
			return undefined;
		},
		listen(port: number, hostname: string): Promise<number> {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, hostname, () => {
					const address = server.address();
					if (address && typeof address === "object") {
						server.unref();
						resolve(address.port);
					} else {
						reject(new Error("Failed to get SOCKS proxy server port"));
					}
				});
			});
		},
		async close(): Promise<void> {
			return new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						const msg = error.message?.toLowerCase() || "";
						if (msg.includes("not running") || msg.includes("already closed") || msg.includes("not listening")) {
							resolve();
							return;
						}
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
		unref(): void {
			server.unref();
		},
	};
}
