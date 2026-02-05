/**
 * System prompt construction and project context loading
 */

import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { getAgentDir } from "../config.js";
import type { SkillsSettings } from "./settings-manager.js";
import { formatSkillsForPrompt, loadSkills, type Skill } from "./skills.js";
import type { ToolName } from "./tools/index.js";

/** Tool descriptions for system prompt */
const toolDescriptions: Record<ToolName, string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, rg, fd, etc.)",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	ls: "List directory contents",
};

/** Resolve input as file path or literal string */
export function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

/** Look for AGENTS.md or CLAUDE.md in a directory (prefers AGENTS.md) */
function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global context. Default: from getAgentDir() */
	agentDir?: string;
}

/**
 * Load all project context files in order:
 * 1. Global: agentDir/AGENTS.md or CLAUDE.md
 * 2. Parent directories (top-most first) down to cwd
 * Each returns {path, content} for separate messages
 */
export function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Array<{ path: string; content: string }> {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getAgentDir();

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	// 1. Load global context from agentDir
	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	// 2. Walk up from cwd to root, collecting all context files
	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			// Add to beginning so we get top-most parent first
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		// Stop if we've reached root
		if (currentDir === root) break;

		// Move up one directory
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break; // Safety check
		currentDir = parentDir;
	}

	// Add ancestor files in order (top-most → cwd)
	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: ToolName[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills (skips discovery if provided). */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		appendSystemPrompt,
		skillsSettings,
		cwd,
		agentDir,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const resolvedCustomPrompt = resolvePromptInput(customPrompt, "system prompt");
	const resolvedAppendPrompt = resolvePromptInput(appendSystemPrompt, "append system prompt");

	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	const appendSection = resolvedAppendPrompt ? `\n\n${resolvedAppendPrompt}` : "";

	// Resolve context files: use provided or discover
	const contextFiles = providedContextFiles ?? loadProjectContextFiles({ cwd: resolvedCwd, agentDir });

	// Resolve skills: use provided or discover
	const skills =
		providedSkills ??
		(skillsSettings?.enabled !== false ? loadSkills({ ...skillsSettings, cwd: resolvedCwd, agentDir }).skills : []);

	if (resolvedCustomPrompt) {
		let prompt = resolvedCustomPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date/time and working directory last
		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${resolvedCwd}`;

		return prompt;
	}

	// Build tools list based on selected tools
	const tools = selectedTools || (["read", "bash", "edit", "write"] as ToolName[]);
	const toolsList = tools.length > 0 ? tools.map((t) => `- ${t}: ${toolDescriptions[t]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];

	const hasBash = tools.includes("bash");
	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");
	const hasRead = tools.includes("read");

	// Bash without edit/write = read-only bash mode
	if (hasBash && !hasEdit && !hasWrite) {
		guidelinesList.push(
			"Use bash ONLY for read-only operations (git log, gh issue view, curl, etc.) - do NOT modify any files",
		);
	}

	// File exploration guidelines
	if (hasBash) {
		guidelinesList.push("Use bash for file operations like ls, rg, fd, sg");
		guidelinesList.push(
			"**ALWAYS use ast-grep (sg) for code search** — NEVER use rg/grep for searching code patterns. " +
				"ast-grep understands code structure (AST), not just text. " +
				"Pattern syntax: $VAR (single node), $$$ARGS (multiple nodes). " +
				"Examples: `sg -p 'console.log($$$)'`, `sg -p 'import { $$$NAMES } from \"$MOD\"'`, " +
				"`sg -p 'async function $NAME($$$ARGS)' -l typescript`, " +
				"`sg -p 'try { $$$BODY } catch { $$$HANDLER }'`, `sg -p 'await $EXPR'`. " +
				"Use rg/grep ONLY for non-code text (logs, configs, docs, comments)",
		);
	}

	// Read before edit guideline
	if (hasRead && hasEdit) {
		guidelinesList.push("Use read to examine files before editing. You must use this tool instead of cat or sed.");
	}

	// Edit guideline
	if (hasEdit) {
		guidelinesList.push("Use edit for precise changes (old text must match exactly)");
	}

	// Write guideline
	if (hasWrite) {
		guidelinesList.push("Use write only for new files or complete rewrites");
	}

	// Always include these
	guidelinesList.push("Be extremeley concise in your responses");
	guidelinesList.push("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside phi, a coding agent harness.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Agent delegation:
You have access to specialized subagents via the subagent tool. You MUST delegate to them instead of doing the work yourself when the situation matches. Do NOT attempt these tasks inline.

| Agent      | When to use                                                                 | Example                                                                                          |
|------------|-----------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| committer  | Committing changes. NEVER run git commit directly.                          | subagent({ agent: "committer", task: "Commit the current session changes" })                     |
| explorer   | You need to understand an unfamiliar codebase, module, or feature area.     | subagent({ agent: "explorer", task: "Map the auth module structure and key types" })              |
| planner    | A task involves 3+ files or needs a step-by-step plan before coding.        | subagent({ agent: "planner", task: "Plan adding OAuth2 support to the auth module" })            |
| reviewer   | Code changes are complete and need review before committing.                | subagent({ agent: "reviewer", task: "Review the changes in packages/ai/src/providers/" })        |

Rules:
- ALWAYS delegate commits to committer. Never run git commit yourself.
- ALWAYS delegate to explorer when you are unfamiliar with a codebase area and need orientation before making changes.
- ALWAYS delegate to planner when the user asks to plan, or when a task touches 3+ files and you have not yet planned.
- ALWAYS delegate to reviewer when the user asks for review, or before committing multi-file changes.
- You may skip explorer/planner for trivial single-file changes where you already have full context.
- Subagents run in isolated contexts. Pass them all the context they need in the task description.`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date/time and working directory last
	prompt += `\nCurrent date and time: ${dateTime}`;
	prompt += `\nCurrent working directory: ${resolvedCwd}`;

	return prompt;
}
