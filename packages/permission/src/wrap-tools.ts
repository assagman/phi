/**
 * Tool wrapping for permission-aware validation.
 *
 * ALL tools (builtin, extension, MCP):
 *   - Network domain check: scans all string args for URLs/domains
 *
 * File tools (read/write/edit):
 *   - File-level permission check (safe files → directory grant)
 *
 * Directory tools (ls):
 *   - Directory permission check
 *
 * Bash:
 *   - Filesystem enforced by OS sandbox (seatbelt/bwrap)
 *   - Network domains extracted from command string (bash-specific patterns)
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "agent";
import { extractHostsFromCommand } from "./bash-domain-extractor.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PermissionAction } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	return p;
}

function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandTilde(filePath);
	if (isAbsolute(expanded)) return expanded;
	return resolvePath(cwd, expanded);
}

// ── Network Domain Extraction ───────────────────────────────────────────────

const URL_RE = /(?:https?|ftp|ssh|git):\/\/[^\s;|&)<>"']+/g;
const LOCALHOST = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Extract hostnames from a URL string. Returns null for localhost/invalid.
 */
function extractHostFromUrl(urlStr: string): string | null {
	try {
		const url = new URL(urlStr);
		const host = url.hostname.toLowerCase();
		if (host && !LOCALHOST.has(host)) return host;
	} catch {
		// Not a valid URL
	}
	return null;
}

/**
 * Recursively extract all string values from an object/array.
 */
function collectStrings(value: unknown, out: string[]): void {
	if (typeof value === "string") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			collectStrings(item, out);
		}
	} else if (value !== null && typeof value === "object") {
		for (const v of Object.values(value)) {
			collectStrings(v, out);
		}
	}
}

/**
 * Extract unique hostnames from all string values in tool arguments.
 * Scans for URL patterns (http(s)://, ftp://, ssh://, git://).
 */
function extractHostsFromArgs(args: unknown): string[] {
	const strings: string[] = [];
	collectStrings(args, strings);

	const hosts = new Set<string>();
	for (const str of strings) {
		URL_RE.lastIndex = 0;
		let match = URL_RE.exec(str);
		while (match !== null) {
			const host = extractHostFromUrl(match[0]);
			if (host) hosts.add(host);
			match = URL_RE.exec(str);
		}
	}
	return [...hosts];
}

// ── File/Directory Permission Checks ────────────────────────────────────────

function getToolAction(toolName: string): PermissionAction {
	switch (toolName) {
		case "write":
		case "edit":
			return "fs_write";
		default:
			return "fs_read";
	}
}

function extractLsDirectoryPath(args: Record<string, unknown>, cwd: string): string {
	const p = args.path;
	if (typeof p === "string") {
		return resolveToCwd(p, cwd);
	}
	return resolveToCwd(".", cwd);
}

async function checkDirectoryPermission(
	dirPath: string,
	toolName: string,
	action: PermissionAction,
	permissionManager: PermissionManager,
): Promise<string | undefined> {
	if (permissionManager.isWithinCwd(dirPath)) {
		return undefined;
	}

	const result = await permissionManager.requestDirectory(dirPath, toolName, action);
	if (result.status === "denied") {
		return result.userMessage
			? `Permission denied: access to ${dirPath} was rejected by user.\nUser message: ${result.userMessage}`
			: `Permission denied: access to ${dirPath} is outside the workspace (${permissionManager.cwd}). The user rejected the access request.`;
	}
	return undefined;
}

/**
 * Check file-level permission for read/write/edit tools.
 * Uses requestFile() which checks safe files before falling through to directory.
 */
async function checkFilePermission(
	filePath: string,
	toolName: string,
	action: PermissionAction,
	permissionManager: PermissionManager,
): Promise<string | undefined> {
	const resolved = resolveToCwd(filePath, permissionManager.cwd);

	if (permissionManager.isWithinCwd(resolved)) {
		return undefined;
	}

	const result = await permissionManager.requestFile(resolved, toolName, action);
	if (result.status === "denied") {
		return result.userMessage
			? `Permission denied: access to ${resolved} was rejected by user.\nUser message: ${result.userMessage}`
			: `Permission denied: access to ${resolved} is outside the workspace (${permissionManager.cwd}). The user rejected the access request.`;
	}
	return undefined;
}

// ── Network Permission Check (all tools) ────────────────────────────────────

async function checkNetworkPermission(
	toolName: string,
	args: unknown,
	permissionManager: PermissionManager,
): Promise<string | undefined> {
	// For bash, use the specialized command parser (handles implicit rules like npm→registry.npmjs.org)
	const hosts =
		toolName === "bash" && typeof (args as Record<string, unknown>)?.command === "string"
			? extractHostsFromCommand((args as Record<string, unknown>).command as string)
			: extractHostsFromArgs(args);

	for (const host of hosts) {
		const result = await permissionManager.requestNetwork(host, toolName);
		if (result.status === "denied") {
			return result.userMessage
				? `Permission denied: network access to ${host} was rejected by user.\nUser message: ${result.userMessage}`
				: `Permission denied: network access to ${host} was rejected by user.`;
		}
	}
	return undefined;
}

// ── Tool Wrapping ───────────────────────────────────────────────────────────

/** Tools that have additional file/directory permission checks */
const FILE_TOOLS = new Set(["read", "write", "edit"]);
const DIR_TOOLS = new Set(["ls"]);

function wrapTool(tool: AgentTool, permissionManager: PermissionManager): AgentTool {
	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback,
		): Promise<AgentToolResult<unknown>> => {
			const args = (params ?? {}) as Record<string, unknown>;
			const toolName = tool.name;

			// ── Network check (ALL tools) ──────────────────────────────
			const networkError = await checkNetworkPermission(toolName, args, permissionManager);
			if (networkError) {
				return { content: [{ type: "text", text: networkError }], details: {} };
			}

			// ── File permission check (read/write/edit) ────────────────
			if (FILE_TOOLS.has(toolName)) {
				const action = getToolAction(toolName);
				const filePath = typeof args.path === "string" ? args.path : undefined;
				if (filePath) {
					const error = await checkFilePermission(filePath, toolName, action, permissionManager);
					if (error) {
						return { content: [{ type: "text", text: error }], details: {} };
					}
				}
			}

			// ── Directory permission check (ls) ────────────────────────
			if (DIR_TOOLS.has(toolName)) {
				const dirPath = extractLsDirectoryPath(args, permissionManager.cwd);
				const error = await checkDirectoryPermission(dirPath, toolName, "fs_read", permissionManager);
				if (error) {
					return { content: [{ type: "text", text: error }], details: {} };
				}
			}

			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

/**
 * Wrap all tools in the array with permission checking.
 * Network domain check applies to ALL tools.
 * File/directory checks apply to read/write/edit/ls only.
 */
export function wrapToolsWithPermissions(tools: AgentTool[], permissionManager: PermissionManager): AgentTool[] {
	return tools.map((tool) => wrapTool(tool, permissionManager));
}

/**
 * Wrap all tools in a registry map with permission checking.
 */
export function wrapToolRegistryWithPermissions(
	registry: Map<string, AgentTool>,
	permissionManager: PermissionManager,
): Map<string, AgentTool> {
	const wrapped = new Map<string, AgentTool>();
	for (const [name, tool] of registry) {
		wrapped.set(name, wrapTool(tool, permissionManager));
	}
	return wrapped;
}
