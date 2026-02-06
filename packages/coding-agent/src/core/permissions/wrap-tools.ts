/**
 * Tool wrapping for permission-aware path validation.
 *
 * Wraps file/directory tools (read, write, edit, ls, bash) to check
 * directory permissions before execution. Paths within CWD are always
 * allowed. Paths outside CWD require an explicit permission grant.
 *
 * For file tools (read, write, edit), the *containing directory* is
 * checked — granting access to a directory covers all files within it.
 *
 * For bash, static path extraction identifies outside-CWD paths and
 * checks permissions per-directory before execution.
 */

import { dirname } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "agent";
import { resolveToCwd } from "../tools/path-utils.js";
import { extractHostsFromCommand } from "./bash-domain-extractor.js";
import { extractPathsFromCommand } from "./bash-path-extractor.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PermissionAction } from "./types.js";

// ── Action Mapping ──────────────────────────────────────────────────────────

/** Map tool names to their primary permission action */
function getToolAction(toolName: string): PermissionAction {
	switch (toolName) {
		case "write":
		case "edit":
			return "fs_write";
		case "read":
		case "ls":
			return "fs_read";
		case "bash":
			// Bash defaults to fs_read; specific paths may need fs_write
			// based on static analysis (handled in bash wrapping)
			return "fs_read";
		default:
			return "fs_read";
	}
}

/**
 * Extract directory paths from tool arguments that need permission checking.
 * For file-based tools, returns the containing directory.
 * For directory-based tools, returns the directory itself.
 */
function extractDirectoryPaths(toolName: string, args: Record<string, unknown>, cwd: string): string[] {
	switch (toolName) {
		case "read":
		case "write":
		case "edit": {
			const p = args.path;
			if (typeof p === "string") {
				// Permission is checked on the containing directory
				return [dirname(resolveToCwd(p, cwd))];
			}
			return [];
		}
		case "ls": {
			const p = args.path;
			if (typeof p === "string") {
				return [resolveToCwd(p, cwd)];
			}
			// Default "." — resolve against CWD to ensure we check correctly
			return [resolveToCwd(".", cwd)];
		}
		default:
			return [];
	}
}

/**
 * Check permission for a single directory path.
 * Returns an error message if denied, or undefined if granted.
 */
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
 * Wrap a single tool with permission checking.
 * Returns the same tool if it doesn't need path validation.
 */
function wrapTool(tool: AgentTool, permissionManager: PermissionManager): AgentTool {
	const toolName = tool.name;

	// Only wrap tools that access the filesystem
	if (!["read", "write", "edit", "ls", "bash"].includes(toolName)) {
		return tool;
	}

	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback,
		): Promise<AgentToolResult<unknown>> => {
			const args = (params ?? {}) as Record<string, unknown>;

			if (toolName === "bash") {
				// Bash: extract paths statically and check each
				const command = typeof args.command === "string" ? args.command : "";
				const outsidePaths = extractPathsFromCommand(command, permissionManager.cwd);

				for (const dirPath of outsidePaths) {
					// Bash commands may both read and write — check read first (most common)
					const error = await checkDirectoryPermission(dirPath, toolName, "fs_read", permissionManager);
					if (error) {
						return {
							content: [{ type: "text", text: error }],
							details: {},
						};
					}
				}

				// Bash: extract network hosts and check each
				const hosts = extractHostsFromCommand(command);
				for (const host of hosts) {
					const result = await permissionManager.requestNetwork(host, toolName);
					if (result.status === "denied") {
						const msg = result.userMessage
							? `Permission denied: network access to ${host} was rejected by user.\nUser message: ${result.userMessage}`
							: `Permission denied: network access to ${host} was rejected by user.`;
						return {
							content: [{ type: "text", text: msg }],
							details: {},
						};
					}
				}
			} else {
				// File tools: extract directory and check with tool-specific action
				const action = getToolAction(toolName);
				const dirPaths = extractDirectoryPaths(toolName, args, permissionManager.cwd);

				for (const dirPath of dirPaths) {
					const error = await checkDirectoryPermission(dirPath, toolName, action, permissionManager);
					if (error) {
						return {
							content: [{ type: "text", text: error }],
							details: {},
						};
					}
				}
			}

			// Permission granted — execute the original tool
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

/**
 * Wrap all tools in the array with permission checking.
 * Non-filesystem tools are returned unchanged.
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
