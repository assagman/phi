/**
 * Linux bubblewrap (bwrap) sandbox wrapping.
 *
 * Uses bwrap for filesystem namespace isolation and network unsharing.
 * Uses socat for bridging network proxy sockets into the namespace.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { quote } from "shell-quote";
import { getPlatform } from "./platform.js";
import {
	containsGlobChars,
	DANGEROUS_FILES,
	expandGlobPattern,
	generateProxyEnvVars,
	getDangerousDirectories,
	normalizePathForSandbox,
} from "./sandbox-utils.js";
import type { FsReadRestrictionConfig, FsWriteRestrictionConfig, SandboxDependencyCheck } from "./types.js";
import { whichSync } from "./which.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LinuxNetworkBridgeContext {
	httpSocketPath: string;
	socksSocketPath: string;
	httpBridgeProcess: ChildProcess;
	socksBridgeProcess: ChildProcess;
	httpProxyPort: number;
	socksProxyPort: number;
}

export interface LinuxSandboxParams {
	command: string;
	needsNetworkRestriction: boolean;
	httpSocketPath?: string;
	socksSocketPath?: string;
	httpProxyPort?: number;
	socksProxyPort?: number;
	readConfig?: FsReadRestrictionConfig;
	writeConfig?: FsWriteRestrictionConfig;
	enableWeakerNestedSandbox?: boolean;
	allowAllUnixSockets?: boolean;
	binShell?: string;
	mandatoryDenySearchDepth?: number;
	allowGitConfig?: boolean;
}

// ── Dependency checking ─────────────────────────────────────────────────────

export function checkLinuxDependencies(): SandboxDependencyCheck {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (whichSync("bwrap") === null) errors.push("bubblewrap (bwrap) not installed");
	if (whichSync("socat") === null) errors.push("socat not installed");

	return { warnings, errors };
}

// ── Network bridge ──────────────────────────────────────────────────────────

export async function initializeLinuxNetworkBridge(
	httpProxyPort: number,
	socksProxyPort: number,
): Promise<LinuxNetworkBridgeContext> {
	const socketId = randomBytes(8).toString("hex");
	const httpSocketPath = join(tmpdir(), `phi-http-${socketId}.sock`);
	const socksSocketPath = join(tmpdir(), `phi-socks-${socketId}.sock`);

	const httpBridgeProcess = spawn(
		"socat",
		[
			`UNIX-LISTEN:${httpSocketPath},fork,reuseaddr`,
			`TCP:localhost:${httpProxyPort},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
		],
		{ stdio: "ignore" },
	);

	if (!httpBridgeProcess.pid) {
		throw new Error("Failed to start HTTP bridge process");
	}

	const socksBridgeProcess = spawn(
		"socat",
		[
			`UNIX-LISTEN:${socksSocketPath},fork,reuseaddr`,
			`TCP:localhost:${socksProxyPort},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
		],
		{ stdio: "ignore" },
	);

	if (!socksBridgeProcess.pid) {
		if (httpBridgeProcess.pid) {
			try {
				process.kill(httpBridgeProcess.pid, "SIGTERM");
			} catch {
				// Best effort
			}
		}
		throw new Error("Failed to start SOCKS bridge process");
	}

	// Wait for sockets to appear
	const maxAttempts = 5;
	for (let i = 0; i < maxAttempts; i++) {
		if (!httpBridgeProcess.pid || httpBridgeProcess.killed || !socksBridgeProcess.pid || socksBridgeProcess.killed) {
			throw new Error("Linux bridge process died unexpectedly");
		}

		try {
			if (existsSync(httpSocketPath) && existsSync(socksSocketPath)) {
				break;
			}
		} catch {
			// Socket not ready yet
		}

		if (i === maxAttempts - 1) {
			if (httpBridgeProcess.pid) {
				try {
					process.kill(httpBridgeProcess.pid, "SIGTERM");
				} catch {
					// Best effort
				}
			}
			if (socksBridgeProcess.pid) {
				try {
					process.kill(socksBridgeProcess.pid, "SIGTERM");
				} catch {
					// Best effort
				}
			}
			throw new Error(`Failed to create bridge sockets after ${maxAttempts} attempts`);
		}
		await new Promise((resolve) => setTimeout(resolve, i * 100));
	}

	return {
		httpSocketPath,
		socksSocketPath,
		httpBridgeProcess,
		socksBridgeProcess,
		httpProxyPort,
		socksProxyPort,
	};
}

// ── Mandatory deny paths ────────────────────────────────────────────────────

function linuxGetMandatoryDenyPaths(allowGitConfig = false): string[] {
	const cwd = process.cwd();
	const dangerousDirectories = getDangerousDirectories();
	const denyPaths = [
		...DANGEROUS_FILES.map((f) => resolvePath(cwd, f)),
		...dangerousDirectories.map((d) => resolvePath(cwd, d)),
		resolvePath(cwd, ".git/hooks"),
	];

	if (!allowGitConfig) {
		denyPaths.push(resolvePath(cwd, ".git/config"));
	}

	return denyPaths;
}

// ── Filesystem args ─────────────────────────────────────────────────────────

function generateFilesystemArgs(
	readConfig: FsReadRestrictionConfig | undefined,
	writeConfig: FsWriteRestrictionConfig | undefined,
	allowGitConfig = false,
): string[] {
	const args: string[] = [];

	if (writeConfig) {
		args.push("--ro-bind", "/", "/");

		for (const pathPattern of writeConfig.allowOnly || []) {
			const normalizedPath = normalizePathForSandbox(pathPattern);
			if (getPlatform() === "linux" && containsGlobChars(normalizedPath)) {
				continue;
			}

			try {
				const resolved = realpathSync(normalizedPath);
				if (existsSync(resolved)) {
					args.push("--bind", resolved, resolved);
				}
			} catch {
				// Path doesn't exist yet — bind the path as-is
				if (existsSync(normalizedPath)) {
					args.push("--bind", normalizedPath, normalizedPath);
				}
			}
		}

		// Deny write within allow: overlay-mount as read-only
		const denyPaths = [...(writeConfig.denyWithinAllow || []), ...linuxGetMandatoryDenyPaths(allowGitConfig)];
		for (const pathPattern of denyPaths) {
			const normalizedPath = normalizePathForSandbox(pathPattern);
			if (containsGlobChars(normalizedPath)) {
				const expanded = expandGlobPattern(pathPattern);
				for (const p of expanded) {
					if (existsSync(p)) {
						args.push("--ro-bind", p, p);
					}
				}
			} else if (existsSync(normalizedPath)) {
				args.push("--ro-bind", normalizedPath, normalizedPath);
			}
		}
	}

	// Read deny: overlay denied paths with empty tmpfs
	if (readConfig) {
		for (const pathPattern of readConfig.denyOnly) {
			const normalizedPath = normalizePathForSandbox(pathPattern);
			if (containsGlobChars(normalizedPath)) {
				const expanded = expandGlobPattern(pathPattern);
				for (const p of expanded) {
					if (existsSync(p)) {
						args.push("--tmpfs", p);
					}
				}
			} else if (existsSync(normalizedPath)) {
				args.push("--tmpfs", normalizedPath);
			}
		}
	}

	return args;
}

// ── Build sandbox command ───────────────────────────────────────────────────

function buildSandboxCommand(
	httpSocketPath: string,
	socksSocketPath: string,
	userCommand: string,
	shell?: string,
): string {
	const shellPath = shell || "bash";
	const socatCommands = [
		`socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:${httpSocketPath} >/dev/null 2>&1 &`,
		`socat TCP-LISTEN:1080,fork,reuseaddr UNIX-CONNECT:${socksSocketPath} >/dev/null 2>&1 &`,
		'trap "kill %1 %2 2>/dev/null; exit" EXIT',
	];

	const innerScript = [...socatCommands, `eval ${quote([userCommand])}`].join("\n");
	return `${shellPath} -c ${quote([innerScript])}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function wrapCommandWithSandboxLinux(params: LinuxSandboxParams): string {
	const {
		command,
		needsNetworkRestriction,
		httpSocketPath,
		socksSocketPath,
		httpProxyPort,
		socksProxyPort,
		readConfig,
		writeConfig,
		enableWeakerNestedSandbox,
		binShell,
		allowGitConfig = false,
	} = params;

	const hasReadRestrictions = readConfig && readConfig.denyOnly.length > 0;
	const hasWriteRestrictions = writeConfig !== undefined;

	if (!needsNetworkRestriction && !hasReadRestrictions && !hasWriteRestrictions) {
		return command;
	}

	const bwrapArgs: string[] = ["--new-session", "--die-with-parent"];

	if (needsNetworkRestriction) {
		bwrapArgs.push("--unshare-net");
		if (httpSocketPath && socksSocketPath) {
			if (!existsSync(httpSocketPath)) {
				throw new Error(`Linux HTTP bridge socket does not exist: ${httpSocketPath}`);
			}
			if (!existsSync(socksSocketPath)) {
				throw new Error(`Linux SOCKS bridge socket does not exist: ${socksSocketPath}`);
			}
			bwrapArgs.push("--bind", httpSocketPath, httpSocketPath);
			bwrapArgs.push("--bind", socksSocketPath, socksSocketPath);

			const proxyEnv = generateProxyEnvVars(3128, 1080);
			bwrapArgs.push(
				...proxyEnv.flatMap((env: string) => {
					const firstEq = env.indexOf("=");
					const key = env.slice(0, firstEq);
					const value = env.slice(firstEq + 1);
					return ["--setenv", key, value];
				}),
			);

			if (httpProxyPort !== undefined) {
				bwrapArgs.push("--setenv", "PHI_HOST_HTTP_PROXY_PORT", String(httpProxyPort));
			}
			if (socksProxyPort !== undefined) {
				bwrapArgs.push("--setenv", "PHI_HOST_SOCKS_PROXY_PORT", String(socksProxyPort));
			}
		}
	}

	const fsArgs = generateFilesystemArgs(readConfig, writeConfig, allowGitConfig);
	bwrapArgs.push(...fsArgs);

	bwrapArgs.push("--dev", "/dev");
	bwrapArgs.push("--unshare-pid");

	if (!enableWeakerNestedSandbox) {
		bwrapArgs.push("--proc", "/proc");
	}

	const shellName = binShell || "bash";
	const shell = whichSync(shellName);
	if (!shell) {
		throw new Error(`Shell '${shellName}' not found in PATH`);
	}

	bwrapArgs.push("--", shell, "-c");

	if (needsNetworkRestriction && httpSocketPath && socksSocketPath) {
		const sandboxCommand = buildSandboxCommand(httpSocketPath, socksSocketPath, command, shell);
		bwrapArgs.push(sandboxCommand);
	} else {
		bwrapArgs.push(command);
	}

	return quote(["bwrap", ...bwrapArgs]);
}
