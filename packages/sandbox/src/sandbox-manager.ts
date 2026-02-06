/**
 * SandboxManager — orchestrates OS-level sandbox enforcement.
 *
 * Manages the HTTP and SOCKS proxy servers for network domain filtering,
 * Linux network bridge setup, macOS Seatbelt profile generation,
 * and bubblewrap wrapping on Linux.
 */

import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { createHttpProxyServer } from "./http-proxy.js";
import type { LinuxNetworkBridgeContext } from "./linux-sandbox.js";
import { checkLinuxDependencies, initializeLinuxNetworkBridge, wrapCommandWithSandboxLinux } from "./linux-sandbox.js";
import { startMacOSSandboxLogMonitor, wrapCommandWithSandboxMacOS } from "./macos-sandbox.js";
import { getPlatform, getWslVersion } from "./platform.js";
import {
	containsGlobChars,
	expandGlobPattern,
	getDefaultWritePaths,
	removeTrailingGlobSuffix,
} from "./sandbox-utils.js";
import { createSocksProxyServer, type SocksProxyWrapper } from "./socks-proxy.js";
import type {
	FsReadRestrictionConfig,
	FsWriteRestrictionConfig,
	SandboxDependencyCheck,
	SandboxRuntimeConfig,
} from "./types.js";
import { SandboxViolationStore } from "./violation-store.js";
import { whichSync } from "./which.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type IgnoreViolationsConfig = Record<string, string[]>;

interface HostNetworkManagerContext {
	httpProxyPort: number;
	socksProxyPort: number;
	linuxBridge: LinuxNetworkBridgeContext | undefined;
}

// ── Module state ────────────────────────────────────────────────────────────

let config: SandboxRuntimeConfig | undefined;
let httpProxyServer: Server | undefined;
let socksProxyServer: SocksProxyWrapper | undefined;
let managerContext: HostNetworkManagerContext | undefined;
let initializationPromise: Promise<HostNetworkManagerContext> | undefined;
let cleanupRegistered = false;
let logMonitorShutdown: (() => void) | undefined;
const sandboxViolationStore = new SandboxViolationStore();

// ── Cleanup ─────────────────────────────────────────────────────────────────

function registerCleanup(): void {
	if (cleanupRegistered) return;
	const cleanupHandler = () =>
		reset().catch(() => {
			// Best effort
		});
	process.once("exit", cleanupHandler);
	process.once("SIGINT", cleanupHandler);
	process.once("SIGTERM", cleanupHandler);
	cleanupRegistered = true;
}

// ── Domain matching ─────────────────────────────────────────────────────────

function matchesDomainPattern(hostname: string, pattern: string): boolean {
	if (pattern.startsWith("*.")) {
		const baseDomain = pattern.substring(2);
		return hostname.toLowerCase().endsWith(`.${baseDomain.toLowerCase()}`);
	}
	return hostname.toLowerCase() === pattern.toLowerCase();
}

async function filterNetworkRequest(_port: number, host: string): Promise<boolean> {
	if (!config) return false;

	for (const deniedDomain of config.network.deniedDomains) {
		if (matchesDomainPattern(host, deniedDomain)) return false;
	}

	for (const allowedDomain of config.network.allowedDomains) {
		if (matchesDomainPattern(host, allowedDomain)) return true;
	}

	return false;
}

// ── Proxy servers ───────────────────────────────────────────────────────────

async function startHttpProxyServer(): Promise<number> {
	httpProxyServer = createHttpProxyServer({
		filter: (port: number, host: string) => filterNetworkRequest(port, host),
	});

	return new Promise<number>((resolve, reject) => {
		if (!httpProxyServer) {
			reject(new Error("HTTP proxy server undefined before listen"));
			return;
		}
		const server = httpProxyServer;
		server.once("error", reject);
		server.once("listening", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				server.unref();
				resolve(address.port);
			} else {
				reject(new Error("Failed to get proxy server address"));
			}
		});
		server.listen(0, "127.0.0.1");
	});
}

async function startSocksProxyServer(): Promise<number> {
	socksProxyServer = createSocksProxyServer({
		filter: (port: number, host: string) => filterNetworkRequest(port, host),
	});

	return socksProxyServer.listen(0, "127.0.0.1");
}

// ── Config accessors ────────────────────────────────────────────────────────

function getFsReadConfig(): FsReadRestrictionConfig {
	if (!config) return { denyOnly: [] };

	const denyPaths: string[] = [];
	for (const p of config.filesystem.denyRead) {
		const stripped = removeTrailingGlobSuffix(p);
		if (getPlatform() === "linux" && containsGlobChars(stripped)) {
			denyPaths.push(...expandGlobPattern(p));
		} else {
			denyPaths.push(stripped);
		}
	}
	return { denyOnly: denyPaths };
}

function getFsWriteConfig(): FsWriteRestrictionConfig {
	if (!config) {
		return { allowOnly: getDefaultWritePaths(), denyWithinAllow: [] };
	}

	const allowPaths = config.filesystem.allowWrite
		.map((path) => removeTrailingGlobSuffix(path))
		.filter((path) => !(getPlatform() === "linux" && containsGlobChars(path)));

	const denyPaths = config.filesystem.denyWrite
		.map((path) => removeTrailingGlobSuffix(path))
		.filter((path) => !(getPlatform() === "linux" && containsGlobChars(path)));

	return {
		allowOnly: [...getDefaultWritePaths(), ...allowPaths],
		denyWithinAllow: denyPaths,
	};
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function initialize(runtimeConfig: SandboxRuntimeConfig): Promise<void> {
	if (initializationPromise) {
		await initializationPromise;
		return;
	}

	config = runtimeConfig;
	const deps = checkDependencies();
	if (deps.errors.length > 0) {
		throw new Error(`Sandbox dependencies not available: ${deps.errors.join(", ")}`);
	}

	if (getPlatform() === "macos") {
		logMonitorShutdown = startMacOSSandboxLogMonitor(sandboxViolationStore.addViolation.bind(sandboxViolationStore));
	}

	registerCleanup();

	initializationPromise = (async () => {
		try {
			const httpProxyPort = await startHttpProxyServer();
			const socksProxyPort = await startSocksProxyServer();

			let linuxBridge: LinuxNetworkBridgeContext | undefined;
			if (getPlatform() === "linux") {
				linuxBridge = await initializeLinuxNetworkBridge(httpProxyPort, socksProxyPort);
			}

			const context: HostNetworkManagerContext = {
				httpProxyPort,
				socksProxyPort,
				linuxBridge,
			};
			managerContext = context;
			return context;
		} catch (error) {
			initializationPromise = undefined;
			managerContext = undefined;
			reset().catch(() => {});
			throw error;
		}
	})();

	await initializationPromise;
}

export function isSupportedPlatform(): boolean {
	const platform = getPlatform();
	if (platform === "linux") {
		return getWslVersion() !== "1";
	}
	return platform === "macos";
}

export function isSandboxingEnabled(): boolean {
	return config !== undefined;
}

export function checkDependencies(): SandboxDependencyCheck {
	if (!isSupportedPlatform()) {
		return { errors: ["Unsupported platform"], warnings: [] };
	}

	const errors: string[] = [];
	const warnings: string[] = [];

	if (whichSync("rg") === null) {
		warnings.push("ripgrep (rg) not found — some features may be limited");
	}

	const platform = getPlatform();
	if (platform === "linux") {
		const linuxDeps = checkLinuxDependencies();
		errors.push(...linuxDeps.errors);
		warnings.push(...linuxDeps.warnings);
	}

	return { errors, warnings };
}

export async function wrapWithSandbox(command: string): Promise<string> {
	const platform = getPlatform();

	const writeConfig = getFsWriteConfig();
	const readConfig = getFsReadConfig();
	const hasNetworkConfig = config?.network?.allowedDomains !== undefined;
	const needsNetworkRestriction = hasNetworkConfig;

	if (needsNetworkRestriction) {
		// Ensure proxy is ready
		if (initializationPromise) {
			await initializationPromise;
		}
	}

	switch (platform) {
		case "macos":
			return wrapCommandWithSandboxMacOS({
				command,
				needsNetworkRestriction,
				httpProxyPort: needsNetworkRestriction ? managerContext?.httpProxyPort : undefined,
				socksProxyPort: needsNetworkRestriction ? managerContext?.socksProxyPort : undefined,
				readConfig,
				writeConfig,
			});
		case "linux":
			return wrapCommandWithSandboxLinux({
				command,
				needsNetworkRestriction,
				httpSocketPath: needsNetworkRestriction ? managerContext?.linuxBridge?.httpSocketPath : undefined,
				socksSocketPath: needsNetworkRestriction ? managerContext?.linuxBridge?.socksSocketPath : undefined,
				httpProxyPort: needsNetworkRestriction ? managerContext?.httpProxyPort : undefined,
				socksProxyPort: needsNetworkRestriction ? managerContext?.socksProxyPort : undefined,
				readConfig,
				writeConfig,
			});
		default:
			throw new Error(`Sandbox configuration is not supported on platform: ${platform}`);
	}
}

export function getConfig(): SandboxRuntimeConfig | undefined {
	return config;
}

export function updateConfig(newConfig: SandboxRuntimeConfig): void {
	config = { ...newConfig };
}

export function getSandboxViolationStore(): SandboxViolationStore {
	return sandboxViolationStore;
}

export function annotateStderrWithSandboxFailures(command: string, stderr: string): string {
	return sandboxViolationStore.annotateStderr(command, stderr);
}

export async function reset(): Promise<void> {
	if (logMonitorShutdown) {
		logMonitorShutdown();
		logMonitorShutdown = undefined;
	}

	if (managerContext?.linuxBridge) {
		const { httpSocketPath, socksSocketPath, httpBridgeProcess, socksBridgeProcess } = managerContext.linuxBridge;

		const exitPromises: Promise<void>[] = [];

		if (httpBridgeProcess.pid && !httpBridgeProcess.killed) {
			try {
				process.kill(httpBridgeProcess.pid, "SIGTERM");
				exitPromises.push(
					new Promise<void>((resolve) => {
						httpBridgeProcess.once("exit", () => resolve());
						setTimeout(() => {
							if (!httpBridgeProcess.killed && httpBridgeProcess.pid) {
								try {
									process.kill(httpBridgeProcess.pid, "SIGKILL");
								} catch {
									// Already dead
								}
							}
							resolve();
						}, 5000);
					}),
				);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
					// Process doesn't exist
				}
			}
		}

		if (socksBridgeProcess.pid && !socksBridgeProcess.killed) {
			try {
				process.kill(socksBridgeProcess.pid, "SIGTERM");
				exitPromises.push(
					new Promise<void>((resolve) => {
						socksBridgeProcess.once("exit", () => resolve());
						setTimeout(() => {
							if (!socksBridgeProcess.killed && socksBridgeProcess.pid) {
								try {
									process.kill(socksBridgeProcess.pid, "SIGKILL");
								} catch {
									// Already dead
								}
							}
							resolve();
						}, 5000);
					}),
				);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
					// Process doesn't exist
				}
			}
		}

		await Promise.all(exitPromises);

		try {
			rmSync(httpSocketPath, { force: true });
		} catch {
			// Best effort
		}
		try {
			rmSync(socksSocketPath, { force: true });
		} catch {
			// Best effort
		}
	}

	const closePromises: Promise<void>[] = [];

	if (httpProxyServer) {
		const server = httpProxyServer;
		closePromises.push(
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
		);
	}

	if (socksProxyServer) {
		closePromises.push(socksProxyServer.close().catch(() => {}));
	}

	await Promise.all(closePromises);

	httpProxyServer = undefined;
	socksProxyServer = undefined;
	managerContext = undefined;
	initializationPromise = undefined;
}
