export {
	type BashOperations,
	type BashToolDetails,
	type BashToolOptions,
	bashTool,
	createBashTool,
} from "./bash.js";
export {
	type CoopPhase,
	type CoopResult,
	type CoopToolDetails,
	type CoopToolOptions,
	createCoopTool,
	type LeadTaskEvent,
	type LeadToolEvent,
} from "./coop.js";
export { createEditTool, type EditOperations, type EditToolDetails, type EditToolOptions, editTool } from "./edit.js";
export { createLsTool, type LsOperations, type LsToolDetails, type LsToolOptions, lsTool } from "./ls.js";
export {
	createAnalyzeConfigsTool,
	createAnalyzeDependenciesTool,
	createAnalyzeLanguagesTool,
	createAnalyzeStructureTool,
	createProjectAnalyzerTools,
	getProjectAnalyzerToolsArray,
	type ProjectAnalyzerTools,
} from "./project-analyzer.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolOptions,
	readTool,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export { createWriteTool, type WriteOperations, type WriteToolOptions, writeTool } from "./write.js";

import type { AgentTool } from "agent";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { createEditTool, editTool } from "./edit.js";
import { createLsTool, lsTool } from "./ls.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createWriteTool, writeTool } from "./write.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

// Default tools for full access mode (using process.cwd())
export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];

// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools: Tool[] = [readTool, lsTool];

// All available tools (using process.cwd())
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	ls: lsTool,
};

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
}

/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
	];
}

/**
 * Create read-only tools configured for a specific working directory.
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createLsTool(cwd)];
}

/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		ls: createLsTool(cwd),
	};
}
