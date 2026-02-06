/**
 * Shared sandbox utilities: default write paths, dangerous files, glob handling, proxy env vars.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { getPlatform } from "./platform.js";

// ── Dangerous Files & Directories ───────────────────────────────────────────

export const DANGEROUS_FILES = [
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zprofile",
	".profile",
	".ripgreprc",
	".mcp.json",
] as const;

export const DANGEROUS_DIRECTORIES = [".git", ".vscode", ".idea"] as const;

export function getDangerousDirectories(): string[] {
	return [...DANGEROUS_DIRECTORIES.filter((d) => d !== ".git"), ".claude/commands", ".claude/agents"];
}

// ── Path Normalization ──────────────────────────────────────────────────────

export function containsGlobChars(pathPattern: string): boolean {
	return (
		pathPattern.includes("*") || pathPattern.includes("?") || pathPattern.includes("[") || pathPattern.includes("]")
	);
}

export function removeTrailingGlobSuffix(pathPattern: string): string {
	return pathPattern.replace(/\/\*\*$/, "");
}

export function isSymlinkOutsideBoundary(originalPath: string, resolvedPath: string): boolean {
	const normalizedOriginal = normalize(originalPath);
	const normalizedResolved = normalize(resolvedPath);

	if (normalizedResolved === normalizedOriginal) return false;

	// macOS /tmp → /private/tmp and /var → /private/var
	if (normalizedOriginal.startsWith("/tmp/") && normalizedResolved === `/private${normalizedOriginal}`) return false;
	if (normalizedOriginal.startsWith("/var/") && normalizedResolved === `/private${normalizedOriginal}`) return false;
	if (normalizedOriginal.startsWith("/private/tmp/") && normalizedResolved === normalizedOriginal) return false;
	if (normalizedOriginal.startsWith("/private/var/") && normalizedResolved === normalizedOriginal) return false;

	if (normalizedResolved === "/") return true;

	const resolvedParts = normalizedResolved.split("/").filter(Boolean);
	if (resolvedParts.length <= 1) return true;

	if (normalizedOriginal.startsWith(`${normalizedResolved}/`)) return true;

	let canonicalOriginal = normalizedOriginal;
	if (normalizedOriginal.startsWith("/tmp/")) {
		canonicalOriginal = `/private${normalizedOriginal}`;
	} else if (normalizedOriginal.startsWith("/var/")) {
		canonicalOriginal = `/private${normalizedOriginal}`;
	}

	if (canonicalOriginal !== normalizedOriginal && canonicalOriginal.startsWith(`${normalizedResolved}/`)) return true;

	const resolvedStartsWithOriginal = normalizedResolved.startsWith(`${normalizedOriginal}/`);
	const resolvedStartsWithCanonical =
		canonicalOriginal !== normalizedOriginal && normalizedResolved.startsWith(`${canonicalOriginal}/`);
	const resolvedIsCanonical = canonicalOriginal !== normalizedOriginal && normalizedResolved === canonicalOriginal;
	const resolvedIsSame = normalizedResolved === normalizedOriginal;

	if (!resolvedIsSame && !resolvedIsCanonical && !resolvedStartsWithOriginal && !resolvedStartsWithCanonical) {
		return true;
	}

	return false;
}

export function normalizePathForSandbox(pathPattern: string): string {
	const cwd = process.cwd();
	let normalizedPath = pathPattern;

	if (pathPattern === "~") {
		normalizedPath = homedir();
	} else if (pathPattern.startsWith("~/")) {
		normalizedPath = homedir() + pathPattern.slice(1);
	} else if (pathPattern.startsWith("./") || pathPattern.startsWith("../")) {
		normalizedPath = resolve(cwd, pathPattern);
	} else if (!isAbsolute(pathPattern)) {
		normalizedPath = resolve(cwd, pathPattern);
	}

	if (containsGlobChars(normalizedPath)) {
		const staticPrefix = normalizedPath.split(/[*?[\]]/)[0];
		if (staticPrefix && staticPrefix !== "/") {
			const baseDir = staticPrefix.endsWith("/") ? staticPrefix.slice(0, -1) : dirname(staticPrefix);
			try {
				const resolvedBaseDir = realpathSync(baseDir);
				if (!isSymlinkOutsideBoundary(baseDir, resolvedBaseDir)) {
					const patternSuffix = normalizedPath.slice(baseDir.length);
					return resolvedBaseDir + patternSuffix;
				}
			} catch {
				// Path doesn't exist
			}
		}
		return normalizedPath;
	}

	try {
		const resolvedPath = realpathSync(normalizedPath);
		if (!isSymlinkOutsideBoundary(normalizedPath, resolvedPath)) {
			normalizedPath = resolvedPath;
		}
	} catch {
		// Path doesn't exist
	}

	return normalizedPath;
}

// ── Default Write Paths ─────────────────────────────────────────────────────

export function getDefaultWritePaths(): string[] {
	const homeDir = homedir();
	return [
		"/dev/stdout",
		"/dev/stderr",
		"/dev/null",
		"/dev/tty",
		"/dev/dtracehelper",
		"/dev/autofs_nowait",
		"/tmp/phi",
		"/private/tmp/phi",
		join(homeDir, ".npm/_logs"),
		join(homeDir, ".claude/debug"),
	];
}

// ── Proxy Environment Variables ─────────────────────────────────────────────

export function generateProxyEnvVars(httpProxyPort?: number, socksProxyPort?: number): string[] {
	const tmpdir = process.env.PHI_TMPDIR || "/tmp/phi";
	const envVars: string[] = ["SANDBOX_RUNTIME=1", `TMPDIR=${tmpdir}`];

	if (!httpProxyPort && !socksProxyPort) return envVars;

	const noProxyAddresses = [
		"localhost",
		"127.0.0.1",
		"::1",
		"*.local",
		".local",
		"169.254.0.0/16",
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
	].join(",");

	envVars.push(`NO_PROXY=${noProxyAddresses}`);
	envVars.push(`no_proxy=${noProxyAddresses}`);

	if (httpProxyPort) {
		envVars.push(`HTTP_PROXY=http://localhost:${httpProxyPort}`);
		envVars.push(`HTTPS_PROXY=http://localhost:${httpProxyPort}`);
		envVars.push(`http_proxy=http://localhost:${httpProxyPort}`);
		envVars.push(`https_proxy=http://localhost:${httpProxyPort}`);
	}

	if (socksProxyPort) {
		envVars.push(`ALL_PROXY=socks5h://localhost:${socksProxyPort}`);
		envVars.push(`all_proxy=socks5h://localhost:${socksProxyPort}`);
		if (getPlatform() === "macos") {
			envVars.push(`GIT_SSH_COMMAND=ssh -o ProxyCommand='nc -X 5 -x localhost:${socksProxyPort} %h %p'`);
		}
		envVars.push(`FTP_PROXY=socks5h://localhost:${socksProxyPort}`);
		envVars.push(`ftp_proxy=socks5h://localhost:${socksProxyPort}`);
		envVars.push(`RSYNC_PROXY=localhost:${socksProxyPort}`);
		envVars.push(`DOCKER_HTTP_PROXY=http://localhost:${httpProxyPort || socksProxyPort}`);
		envVars.push(`DOCKER_HTTPS_PROXY=http://localhost:${httpProxyPort || socksProxyPort}`);
		if (httpProxyPort) {
			envVars.push("CLOUDSDK_PROXY_TYPE=https");
			envVars.push("CLOUDSDK_PROXY_ADDRESS=localhost");
			envVars.push(`CLOUDSDK_PROXY_PORT=${httpProxyPort}`);
		}
		envVars.push(`GRPC_PROXY=socks5h://localhost:${socksProxyPort}`);
		envVars.push(`grpc_proxy=socks5h://localhost:${socksProxyPort}`);
	}

	return envVars;
}

// ── Command Encoding ────────────────────────────────────────────────────────

export function encodeSandboxedCommand(command: string): string {
	const truncatedCommand = command.slice(0, 100);
	return Buffer.from(truncatedCommand).toString("base64");
}

export function decodeSandboxedCommand(encodedCommand: string): string {
	return Buffer.from(encodedCommand, "base64").toString("utf8");
}

// ── Glob Expansion ──────────────────────────────────────────────────────────

export function globToRegex(globPattern: string): string {
	return (
		"^" +
		globPattern
			.replace(/[.^$+{}()|\\]/g, "\\$&")
			.replace(/\[([^\]]*?)$/g, "\\[$1")
			.replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
			.replace(/\*\*/g, "__GLOBSTAR__")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]")
			.replace(/__GLOBSTAR_SLASH__/g, "(.*/)?")
			.replace(/__GLOBSTAR__/g, ".*") +
		"$"
	);
}

export function expandGlobPattern(globPath: string): string[] {
	const normalizedPattern = normalizePathForSandbox(globPath);
	const staticPrefix = normalizedPattern.split(/[*?[\]]/)[0];
	if (!staticPrefix || staticPrefix === "/") {
		return [];
	}

	const baseDir = staticPrefix.endsWith("/") ? staticPrefix.slice(0, -1) : dirname(staticPrefix);

	if (!existsSync(baseDir)) {
		return [];
	}

	const regex = new RegExp(globToRegex(normalizedPattern));
	const results: string[] = [];

	try {
		const entries = readdirSync(baseDir, { recursive: true, withFileTypes: true });
		for (const entry of entries) {
			const parentDir =
				(entry as { parentPath?: string }).parentPath ?? (entry as { path?: string }).path ?? baseDir;
			const fullPath = join(parentDir, entry.name);
			if (regex.test(fullPath)) {
				results.push(fullPath);
			}
		}
	} catch {
		// Error reading directory
	}

	return results;
}
