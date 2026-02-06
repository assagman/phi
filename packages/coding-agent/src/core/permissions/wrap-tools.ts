/**
 * Tool wrapping for permission-aware path validation.
 *
 * Wraps file/directory tools (read, write, edit, ls, bash) to check
 * directory permissions before execution. Paths within CWD are always
 * allowed. Paths outside CWD require an explicit permission grant.
 *
 * For file tools (read, write, edit), the *containing directory* is
 * checked — granting access to a directory covers all files within it.
 */

import { dirname } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "agent";
import { resolveToCwd } from "../tools/path-utils.js";
import type { PermissionManager } from "./permission-manager.js";

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
		case "bash": {
			// Bash commands execute in CWD — we can't statically analyze
			// all paths a command might access. The CWD itself is the boundary.
			// Bash tool already runs with cwd set, so no path extraction needed.
			return [];
		}
		default:
			return [];
	}
}

/**
 * Wrap a single tool with permission checking.
 * Returns the same tool if it doesn't need path validation.
 */
function wrapTool(tool: AgentTool, permissionManager: PermissionManager): AgentTool {
	const toolName = tool.name;

	// Only wrap tools that access the filesystem
	if (!["read", "write", "edit", "ls"].includes(toolName)) {
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
			const dirPaths = extractDirectoryPaths(toolName, args, permissionManager.cwd);

			for (const dirPath of dirPaths) {
				if (permissionManager.isWithinCwd(dirPath)) {
					continue;
				}

				const result = await permissionManager.requestDirectory(dirPath, toolName);

				if (result.status === "denied") {
					const message = result.userMessage
						? `Permission denied: access to ${dirPath} was rejected by user.\nUser message: ${result.userMessage}`
						: `Permission denied: access to ${dirPath} is outside the workspace (${permissionManager.cwd}). The user rejected the access request.`;

					return {
						content: [{ type: "text", text: message }],
						details: {},
					};
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
