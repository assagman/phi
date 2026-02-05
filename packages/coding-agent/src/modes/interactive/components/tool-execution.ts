import * as os from "node:os";
import stripAnsi from "strip-ansi";
import { Container, Text, type TUI } from "tui";
import type { SubagentDetails, SubagentToolEvent } from "../../../core/builtin-tools/subagent/index.js";
import type { BashToolDetails } from "../../../core/tools/bash.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { highlightCode, type ThemeColor, theme } from "../theme/theme.js";

const MAX_ERROR_LINES = 10;
const MAX_CMD_LINES = 10;
const MAX_ARG_LINES = 12;
const MAX_SUBAGENT_TOOLS = 8;
const MAX_SUBAGENT_TEXT_LINES = 2;
const MAX_EXPANDED_OUTPUT_LINES = 20;
const PULSE_PERIOD_MS = 1500; // Full pulse cycle duration

const ARG_TOOL_PREFIXES = ["agentsbox_", "delta_", "epsilon_"];

const ICONS: Record<string, string> = {
	read: "\uf02d", // nf-fa-book
	edit: "\uf044", // nf-fa-pencil_square_o
	write: "\uf0f6", // nf-fa-file_text_o
	bash: "\uf120", // nf-fa-terminal
	ls: "\uf07c", // nf-fa-folder_open
	find: "\uf002", // nf-fa-search
	grep: "\uf0b0", // nf-fa-filter
	subagent: "\uf0c0", // nf-fa-users
};

const COLORS: Record<string, ThemeColor> = {
	read: "toolRead",
	edit: "toolEdit",
	write: "toolWrite",
	bash: "toolBash",
	ls: "toolRead",
	find: "toolFind",
	subagent: "accent",
	grep: "toolGrep",
};

function shorten(path: string): string {
	const home = os.homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
	details?: { diff?: string } | SubagentDetails | BashToolDetails;
}

function isSubagentDetails(details: ToolResult["details"]): details is SubagentDetails {
	return details != null && "mode" in details && "results" in details;
}

function isBashDetails(details: ToolResult["details"]): details is BashToolDetails {
	return details != null && "displayHints" in details;
}

/** Format tool args for compact display in subagent tool list */
function formatSubagentToolArgs(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "read":
		case "edit":
		case "write":
			return args.path ? theme.fg("toolPath", shorten(String(args.path))) : "";
		case "bash": {
			const cmd = String(args.command ?? "");
			const firstLine = cmd.split("\n")[0];
			return theme.fg("dim", firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine);
		}
		default:
			return "";
	}
}

/** Build a directory tree node from a list of file paths */
interface TreeNode {
	name: string;
	children: Map<string, TreeNode>;
	isFile: boolean;
	isError?: boolean;
}

function buildFileTree(tools: Array<{ args: Record<string, unknown>; isError?: boolean }>): TreeNode {
	const root: TreeNode = { name: "", children: new Map(), isFile: false };
	for (const tool of tools) {
		const raw = String(tool.args.path ?? "");
		const path = shorten(raw);
		const parts = path.split("/").filter(Boolean);
		let node = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (!node.children.has(part)) {
				node.children.set(part, {
					name: part,
					children: new Map(),
					isFile: i === parts.length - 1,
					isError: i === parts.length - 1 ? tool.isError : undefined,
				});
			}
			node = node.children.get(part)!;
		}
	}
	return root;
}

/** Collapse single-child directory chains: a/ -> b/ -> c.ts becomes a/b/c.ts */
function collapseTree(node: TreeNode): TreeNode {
	if (node.isFile) return node;
	const collapsed = new Map<string, TreeNode>();
	for (const [key, child] of node.children) {
		let current = child;
		let prefix = key;
		while (!current.isFile && current.children.size === 1) {
			const [nextKey, nextChild] = current.children.entries().next().value!;
			prefix = `${prefix}/${nextKey}`;
			current = nextChild;
		}
		const collapsedChild = collapseTree({ ...current, name: prefix });
		collapsed.set(prefix, collapsedChild);
	}
	return { ...node, children: collapsed };
}

/** Render a file tree as indented lines with box-drawing connectors */
function renderFileTree(root: TreeNode, indent: string): string[] {
	const lines: string[] = [];
	const collapsed = collapseTree(root);

	function walk(node: TreeNode, prefix: string) {
		const entries = [...node.children.entries()];
		for (let i = 0; i < entries.length; i++) {
			const [, child] = entries[i];
			const isLast = i === entries.length - 1;
			const connector = isLast ? "└─ " : "├─ ";
			const childPrefix = isLast ? "   " : "│  ";

			if (child.isFile) {
				const color = child.isError ? "error" : "toolPath";
				const icon = child.isError ? "✗" : "✓";
				lines.push(`${prefix}${connector}${theme.fg("muted", icon)} ${theme.fg(color, child.name)}`);
			} else {
				lines.push(`${prefix}${connector}${theme.fg("muted", `${child.name}/`)}`);
				walk(child, `${prefix}${childPrefix}`);
			}
		}
	}

	walk(collapsed, indent);
	return lines;
}

// ─── Agent-specific summary renderers ────────────────────────────────────────

/** Helper: partition tools by type */
function partitionTools(allTools: SubagentToolEvent[]): {
	fileTools: SubagentToolEvent[];
	bashTools: SubagentToolEvent[];
} {
	const fileTools = allTools.filter(
		(t) => (t.toolName === "read" || t.toolName === "edit" || t.toolName === "write") && t.args.path,
	);
	const bashTools = allTools.filter((t) => t.toolName === "bash");
	return { fileTools, bashTools };
}

/** Render bash commands as compact list */
function renderBashSummary(bashTools: SubagentToolEvent[], indent: string, label: string): string[] {
	const lines: string[] = [];
	if (bashTools.length === 0) return lines;
	lines.push(`${indent}${theme.fg("muted", `${label} (${bashTools.length}):`)}`);
	for (const tool of bashTools) {
		const statusIcon = tool.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const cmd = String(tool.args.command ?? "");
		const firstLine = cmd.split("\n")[0];
		const preview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
		lines.push(`${indent}  ${statusIcon} ${theme.fg("dim", preview)}`);
	}
	return lines;
}

/** Default summary: file tree + commands (used for explorer + unknown agents) */
function renderDefaultSummary(allTools: SubagentToolEvent[], indent: string): string[] {
	const { fileTools, bashTools } = partitionTools(allTools);
	const lines: string[] = [];

	if (fileTools.length > 0) {
		lines.push(`${indent}${theme.fg("muted", `files (${fileTools.length}):`)}`);
		lines.push(...renderFileTree(buildFileTree(fileTools), indent));
	}
	lines.push(...renderBashSummary(bashTools, indent, "commands"));
	return lines;
}

/**
 * Planner summary: files explored + plan steps extracted from output.
 * While running, shows files being read. When done, shows the plan outline.
 */
function renderPlannerSummary(allTools: SubagentToolEvent[], indent: string, finalOutput?: string): string[] {
	const { fileTools } = partitionTools(allTools);
	const lines: string[] = [];

	if (fileTools.length > 0) {
		lines.push(`${indent}${theme.fg("muted", `explored (${fileTools.length}):`)}`);
		lines.push(...renderFileTree(buildFileTree(fileTools), indent));
	}

	// Extract plan steps from final output (### Step N: Title)
	if (finalOutput) {
		const stepPattern = /^###\s+Step\s+\d+[.:]\s*(.+)$/gm;
		const steps: string[] = [];
		let match = stepPattern.exec(finalOutput);
		while (match) {
			steps.push(match[1].trim());
			match = stepPattern.exec(finalOutput);
		}
		if (steps.length > 0) {
			lines.push(`${indent}${theme.fg("muted", `plan (${steps.length} steps):`)}`);
			for (let i = 0; i < steps.length; i++) {
				const isLast = i === steps.length - 1;
				const connector = isLast ? "└─" : "├─";
				lines.push(`${indent}${connector} ${theme.fg("accent", `${i + 1}.`)} ${theme.fg("dim", steps[i])}`);
			}
		}
	}

	return lines;
}

/**
 * Committer summary: extract git commit commands and show them.
 * Shows staged files + commit messages.
 */
function renderCommitterSummary(allTools: SubagentToolEvent[], indent: string): string[] {
	const { bashTools } = partitionTools(allTools);
	const lines: string[] = [];

	// Extract git add (staged files) and git commit commands
	const stagedFiles: string[] = [];
	const commits: Array<{ message: string; isError: boolean }> = [];

	for (const tool of bashTools) {
		const cmd = String(tool.args.command ?? "");
		// Extract files from git add commands
		const addMatch = cmd.match(/git\s+add\s+(.+)/);
		if (addMatch) {
			const files = addMatch[1].split(/\s+/).filter((f) => !f.startsWith("-") && f.trim());
			stagedFiles.push(...files);
		}
		// Extract commit messages
		const commitMatch = cmd.match(/git\s+commit\s+.*-m\s+["']([^"']+)["']/);
		if (commitMatch) {
			commits.push({ message: commitMatch[1], isError: tool.isError ?? false });
		}
	}

	if (commits.length > 0) {
		lines.push(`${indent}${theme.fg("muted", `commits (${commits.length}):`)}`);
		for (let i = 0; i < commits.length; i++) {
			const c = commits[i];
			const isLast = i === commits.length - 1;
			const connector = isLast ? "└─" : "├─";
			const icon = c.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			lines.push(`${indent}${connector} ${icon} ${theme.fg("dim", c.message)}`);
		}
	}

	if (stagedFiles.length > 0 && commits.length === 0) {
		// Show staged files if no commits happened yet (error case)
		lines.push(`${indent}${theme.fg("muted", `staged (${stagedFiles.length}):`)}`);
		for (const f of stagedFiles.slice(0, 20)) {
			lines.push(`${indent}  ${theme.fg("toolPath", shorten(f))}`);
		}
		if (stagedFiles.length > 20) {
			lines.push(`${indent}  ${theme.fg("muted", `… ${stagedFiles.length - 20} more`)}`);
		}
	}

	// Show other git commands that aren't add/commit
	const otherGit = bashTools.filter((t) => {
		const cmd = String(t.args.command ?? "");
		return cmd.includes("git") && !cmd.match(/git\s+(add|commit)\b/);
	});
	if (otherGit.length > 0) {
		lines.push(...renderBashSummary(otherGit, indent, "git ops"));
	}

	return lines;
}

/**
 * Reviewer summary: file tree of reviewed files + finding categories from output.
 */
function renderReviewerSummary(allTools: SubagentToolEvent[], indent: string, finalOutput?: string): string[] {
	const { fileTools, bashTools } = partitionTools(allTools);
	const lines: string[] = [];

	// Show what was reviewed (reads + diffs)
	const readFiles = fileTools.filter((t) => t.toolName === "read");
	const diffCommands = bashTools.filter((t) => {
		const cmd = String(t.args.command ?? "");
		return cmd.includes("git diff") || cmd.includes("git show");
	});

	if (readFiles.length > 0 || diffCommands.length > 0) {
		const total = readFiles.length + diffCommands.length;
		lines.push(`${indent}${theme.fg("muted", `reviewed (${total}):`)}`);
		if (readFiles.length > 0) {
			lines.push(...renderFileTree(buildFileTree(readFiles), indent));
		}
		for (const d of diffCommands) {
			const cmd = String(d.args.command ?? "");
			const firstLine = cmd.split("\n")[0];
			const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
			const icon = d.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			lines.push(`${indent}  ${icon} ${theme.fg("dim", preview)}`);
		}
	}

	// Extract finding counts from output sections
	if (finalOutput) {
		const sections: Array<{ label: string; color: ThemeColor; pattern: RegExp }> = [
			{ label: "critical", color: "error", pattern: /^## Critical\n([\s\S]*?)(?=\n## |\n---|Z)/m },
			{ label: "warnings", color: "warning", pattern: /^## Warnings\n([\s\S]*?)(?=\n## |\n---|Z)/m },
			{ label: "suggestions", color: "muted", pattern: /^## Suggestions\n([\s\S]*?)(?=\n## |\n---|Z)/m },
		];

		const findings: Array<{ label: string; color: ThemeColor; count: number }> = [];
		for (const section of sections) {
			const match = section.pattern.exec(finalOutput);
			if (match) {
				const body = match[1];
				// Count ### headings (each is a finding)
				const count = (body.match(/^### /gm) || []).length;
				if (count > 0) {
					findings.push({ label: section.label, color: section.color, count });
				}
			}
		}

		if (findings.length > 0) {
			const parts = findings.map((f) => theme.fg(f.color, `${f.count} ${f.label}`));
			lines.push(`${indent}${theme.fg("muted", "findings:")} ${parts.join(theme.fg("muted", " · "))}`);
		} else if (finalOutput.includes("No issues found")) {
			lines.push(`${indent}${theme.fg("success", "no issues found")}`);
		}
	}

	return lines;
}

/** Dispatch to agent-specific renderer */
function renderAgentSummary(
	agentName: string,
	allTools: SubagentToolEvent[],
	indent: string,
	finalOutput?: string,
): string[] {
	switch (agentName) {
		case "planner":
			return renderPlannerSummary(allTools, indent, finalOutput);
		case "committer":
			return renderCommitterSummary(allTools, indent);
		case "reviewer":
			return renderReviewerSummary(allTools, indent, finalOutput);
		default:
			return renderDefaultSummary(allTools, indent);
	}
}

/**
 * Compact single-line tool execution display with pulse animation
 */
export class ToolExecutionComponent extends Container {
	private text: Text;
	private toolName: string;
	private args: Record<string, unknown> = {};
	private result?: ToolResult;
	private expanded = false;
	private running = true;
	private startTime = Date.now();
	private pulseTimer?: ReturnType<typeof setInterval>;
	private ui?: TUI;
	private onInvalidate?: () => void;

	constructor(toolName: string, args: Record<string, unknown> = {}, ui?: TUI, onInvalidate?: () => void) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.ui = ui;
		this.onInvalidate = onInvalidate;
		this.text = new Text("", 1, 0);
		this.addChild(this.text);
		this.update();
		this.startPulse();
	}

	getArgs(): Record<string, unknown> {
		return this.args;
	}

	updateArgs(args: Record<string, unknown>): void {
		this.args = args;
		this.update();
	}

	updateResult(result: ToolResult, isPartial = false): void {
		this.result = result;
		this.running = isPartial;
		if (!this.running) {
			this.stopPulse();
		}
		this.update();
	}

	private startPulse(): void {
		if (this.pulseTimer || !this.ui) return;
		// 60fps = ~16ms intervals
		this.pulseTimer = setInterval(() => {
			if (this.running) {
				this.update();
				this.onInvalidate?.();
				this.ui?.requestRender();
			}
		}, 16);
	}

	private stopPulse(): void {
		if (this.pulseTimer) {
			clearInterval(this.pulseTimer);
			this.pulseTimer = undefined;
		}
	}

	/**
	 * Get pulsing color for tool name (fades between dim and bright)
	 */
	private pulseColor(baseColor: ThemeColor): string {
		if (!this.running) {
			return theme.getFgAnsi(baseColor);
		}

		// Get RGB from theme (single source of truth)
		const rgb = theme.getFgRgb(baseColor);
		if (!rgb) {
			return theme.getFgAnsi(baseColor);
		}

		const elapsed = Date.now() - this.startTime;
		// Sine wave: oscillates between 0.3 and 1.0 brightness
		const t = (Math.sin((elapsed / PULSE_PERIOD_MS) * Math.PI * 2) + 1) / 2;
		const brightness = 0.3 + t * 0.7;

		const [r, g, b] = rgb.map((c) => Math.round(c * brightness));
		return `\x1b[38;2;${r};${g};${b}m`;
	}

	private icon(): string {
		return ICONS[this.toolName] ?? "\uf013"; // nf-fa-cog
	}

	private color(): ThemeColor {
		return COLORS[this.toolName] ?? "toolTitle";
	}

	private iconColor(): ThemeColor {
		if (this.running) return this.color();
		return this.result?.isError ? "error" : "success";
	}

	private status(): string {
		if (this.running) return ""; // Pulse animation indicates running
		if (this.result?.isError) return theme.fg("error", "✗");
		return theme.fg("success", "✓");
	}

	private output(): string {
		if (!this.result) return "";
		const texts = this.result.content
			.filter((c) => c.type === "text" && c.text)
			.map((c) => sanitizeBinaryOutput(stripAnsi(c.text!)).replace(/\r/g, ""));
		return texts.join("\n").trim();
	}

	private lineCount(): number {
		const out = this.output();
		return out ? out.split("\n").length : 0;
	}

	private editStats(): { added: number; removed: number } | null {
		// Prefer actual diff from result
		const details = this.result?.details;
		const diff = details && !isSubagentDetails(details) && !isBashDetails(details) ? details.diff : undefined;
		if (diff) {
			let added = 0,
				removed = 0;
			for (const line of diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) added++;
				else if (line.startsWith("-") && !line.startsWith("---")) removed++;
			}
			return { added, removed };
		}

		// Preview stats from args (live, before completion)
		const oldText = this.args.oldText;
		const newText = this.args.newText;
		if (typeof oldText === "string" && typeof newText === "string") {
			const removed = oldText.split("\n").length;
			const added = newText.split("\n").length;
			return { added, removed };
		}

		return null;
	}

	/**
	 * Apply pulse color and bold to tool name
	 */
	private pulsed(text: string): string {
		const color = this.pulseColor(this.color());
		return `\x1b[1m${color}${text}\x1b[22;39m`;
	}

	/**
	 * Format file path with italic styling
	 */
	private formatPath(path: string): string {
		return `\x1b[3m${theme.fg("toolPath", path)}\x1b[23m`;
	}

	private hasArgs(): boolean {
		return Object.keys(this.args).length > 0;
	}

	private shouldRenderArgs(): boolean {
		return this.hasArgs() && ARG_TOOL_PREFIXES.some((prefix) => this.toolName.startsWith(prefix));
	}

	private tryParseJsonString(value: string): unknown | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return null;
		try {
			return JSON.parse(trimmed) as unknown;
		} catch {
			return null;
		}
	}

	private normalizeArgs(): Record<string, unknown> {
		let changed = false;
		const normalized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(this.args)) {
			if (typeof value === "string") {
				const parsed = this.tryParseJsonString(value);
				if (parsed !== null) {
					normalized[key] = parsed;
					changed = true;
					continue;
				}
			}
			normalized[key] = value;
		}
		return changed ? normalized : this.args;
	}

	private formatArgsLines(): string[] {
		if (!this.shouldRenderArgs()) return [];
		const argsJson = JSON.stringify(this.normalizeArgs(), null, 2);
		if (!argsJson) return [];
		const highlighted = highlightCode(argsJson, "json");
		if (highlighted.length === 0) return [];

		const label = theme.fg("muted", "args:");
		const indent = "   ";
		const continuation = " ".repeat(6);

		const maxLines = Math.min(highlighted.length, MAX_ARG_LINES);
		const lines = [`${indent}${label} ${highlighted[0] ?? ""}`];
		for (const line of highlighted.slice(1, maxLines)) {
			lines.push(`${indent}${continuation}${line}`);
		}
		if (highlighted.length > MAX_ARG_LINES) {
			lines.push(`${indent}${theme.fg("muted", `… ${highlighted.length - MAX_ARG_LINES} more lines`)}`);
		}
		return lines;
	}

	private formatLine(): string {
		const i = theme.fg(this.iconColor(), this.icon());
		const s = this.status();
		const path = shorten(String(this.args.path ?? ""));

		switch (this.toolName) {
			case "read": {
				const offset = this.args.offset as number | undefined;
				const limit = this.args.limit as number | undefined;
				let range = "";
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit ? start + limit - 1 : "";
					range = `:${start}${end ? `-${end}` : ""}`;
				}
				const n = this.lineCount();
				const stats = n > 0 ? theme.fg("muted", ` ${n} lines`) : "";
				return `${i} ${this.pulsed("read")} ${this.formatPath(path)}${theme.fg("warning", range)}${stats} ${s}`;
			}

			case "edit": {
				const es = this.editStats();
				let stats = "";
				if (es) {
					const parts: string[] = [];
					if (es.added > 0) parts.push(theme.fg("success", `+${es.added}`));
					if (es.removed > 0) parts.push(theme.fg("error", `-${es.removed}`));
					if (parts.length) stats = ` ${parts.join(" ")}`;
				}
				return `${i} ${this.pulsed("edit")} ${this.formatPath(path)}${stats} ${s}`;
			}

			case "write": {
				const content = String(this.args.content ?? "");
				const n = content ? content.split("\n").length : 0;
				const stats = n > 0 ? theme.fg("muted", ` ${n} lines`) : "";
				return `${i} ${this.pulsed("write")} ${this.formatPath(path)}${stats} ${s}`;
			}

			case "bash": {
				const cmd = String(this.args.command ?? "");
				const cmdLines = cmd.split("\n");
				const truncated = cmdLines.length > MAX_CMD_LINES;
				const displayLines = truncated ? cmdLines.slice(0, MAX_CMD_LINES) : cmdLines;
				const highlighted = highlightCode(displayLines.join("\n"), "bash");
				const n = this.lineCount();
				const stats = n > 0 ? theme.fg("muted", ` ${n} lines`) : "";

				if (highlighted.length === 1) {
					return `${i} ${this.pulsed("bash")} $ ${highlighted[0]}${stats} ${s}`;
				}
				// Multi-line: first line after $, rest indented
				const indent = "   ";
				const lines = [
					`${i} ${this.pulsed("bash")} $ ${highlighted[0]}`,
					...highlighted.slice(1).map((l) => `${indent}${l}`),
				];
				if (truncated) {
					lines.push(`${indent}${theme.fg("muted", `… ${cmdLines.length - MAX_CMD_LINES} more lines`)}`);
				}
				lines.push(`${indent}${stats} ${s}`);
				return lines.join("\n");
			}

			case "ls": {
				const n = this.lineCount();
				const stats = n > 0 ? theme.fg("muted", ` ${n} entries`) : "";
				return `${i} ${this.pulsed("ls")} ${theme.fg("accent", path || ".")}${stats} ${s}`;
			}

			case "find": {
				const pattern = String(this.args.pattern ?? "");
				const n = this.lineCount();
				const stats = n > 0 ? theme.fg("muted", ` ${n} matches`) : "";
				return `${i} ${this.pulsed("find")} ${theme.fg("accent", pattern)} ${theme.fg("muted", `in ${path || "."}`)}${stats} ${s}`;
			}

			case "grep": {
				const pattern = String(this.args.pattern ?? "");
				const n = this.lineCount();
				const stats = n > 0 ? theme.fg("muted", ` ${n} matches`) : "";
				return `${i} ${this.pulsed("grep")} ${theme.fg("accent", `/${pattern}/`)} ${theme.fg("muted", `in ${path || "."}`)}${stats} ${s}`;
			}

			case "subagent":
				return this.formatSubagentLine(i, s);

			default:
				return `${i} ${this.pulsed(this.toolName)} ${s}`;
		}
	}

	/**
	 * Rich rendering for subagent tool calls.
	 * Shows agent name, task, active subprocess tools, streaming text, and usage summary.
	 */
	private formatSubagentLine(i: string, s: string): string {
		const details = isSubagentDetails(this.result?.details) ? this.result!.details : undefined;
		const agentName = details?.agentName || String(this.args.agent ?? "");
		const taskText = details?.task || String(this.args.task ?? "");
		const mode = details?.mode;

		const lines: string[] = [];
		const indent = "   ";

		// Header: agent name + metadata inline, task text always on next line
		const modeLabel = mode && mode !== "single" ? theme.fg("muted", ` (${mode})`) : "";

		// Build agent info for header line
		const metaParts: string[] = [];
		if (details) {
			if (details.agentModel) metaParts.push(details.agentModel);
			if (details.agentThinkingLevel) metaParts.push(`thinking:${details.agentThinkingLevel}`);
			if (details.agentTemperature != null) metaParts.push(`temp:${details.agentTemperature}`);
			if (details.agentSource && details.agentSource !== "preset") metaParts.push(details.agentSource);
		}
		const metaSuffix = metaParts.length > 0 ? ` ${theme.fg("dim", metaParts.join(" · "))}` : "";

		if (agentName) {
			lines.push(`${i} ${this.pulsed("subagent")} ${theme.fg("accent", agentName)}${modeLabel}${metaSuffix} ${s}`);
		} else {
			lines.push(`${i} ${this.pulsed("subagent")}${modeLabel}${metaSuffix} ${s}`);
		}

		// Task text display:
		// - Streaming (subprocess hasn't produced tool events yet): sliding window of last 5 lines
		// - Subprocess active or done: single-line preview
		const subprocessActive = details?.allTools && details.allTools.length > 0;
		if (taskText.length > 0) {
			if (this.running && !subprocessActive) {
				// Args still streaming or subprocess just started — show sliding window
				const taskLines = taskText.split("\n").filter((l) => l.trim());
				const MAX_TASK_LINES = 5;
				const skipped = Math.max(0, taskLines.length - MAX_TASK_LINES);
				if (skipped > 0) {
					lines.push(`${indent}${theme.fg("muted", `… ${skipped} lines above`)}`);
				}
				const visible = taskLines.slice(-MAX_TASK_LINES);
				for (const tl of visible) {
					const trimmed = tl.length > 100 ? `${tl.slice(0, 97)}...` : tl;
					lines.push(`${indent}${theme.fg("dim", trimmed)}`);
				}
			} else {
				// Collapsed: single-line preview
				const firstLine = taskText.split("\n")[0] || "";
				const preview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
				if (preview) {
					lines.push(`${indent}${theme.fg("muted", `"${preview}"`)}`);
				}
			}
		}

		// Parallel mode: show per-agent progress
		if (mode === "parallel" && Array.isArray(this.args.parallel)) {
			const tasks = this.args.parallel as Array<{ agent: string; task: string }>;
			for (let idx = 0; idx < tasks.length; idx++) {
				const t = tasks[idx];
				const r = details?.results?.[idx];
				let taskStatus: string;
				if (r && r.exitCode !== -1) {
					taskStatus = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				} else {
					taskStatus = this.running ? theme.fg("warning", "◐") : theme.fg("muted", "○");
				}
				const pLine = t.task.split("\n")[0] || "";
				const preview = pLine.length > 80 ? `${pLine.slice(0, 77)}...` : pLine;
				lines.push(`${indent}${taskStatus} ${theme.fg("accent", t.agent)} ${theme.fg("muted", `"${preview}"`)}`);
			}
		}

		// Chain mode: show step progress
		if (mode === "chain" && Array.isArray(this.args.chain)) {
			const steps = this.args.chain as Array<{ agent: string; task: string }>;
			for (let idx = 0; idx < steps.length; idx++) {
				const step = steps[idx];
				const r = details?.results?.[idx];
				let stepStatus: string;
				if (r) {
					stepStatus = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				} else if (idx === (details?.results?.length ?? 0) && this.running) {
					stepStatus = theme.fg("warning", "◐");
				} else {
					stepStatus = theme.fg("muted", "○");
				}
				const sLine = step.task.split("\n")[0] || "";
				const preview = sLine.length > 80 ? `${sLine.slice(0, 77)}...` : sLine;
				lines.push(
					`${indent}${stepStatus} ${theme.fg("muted", `step ${idx + 1}:`)} ${theme.fg("accent", step.agent)} ${theme.fg("muted", `"${preview}"`)}`,
				);
			}
		}

		// When done: show agent-specific accumulated summary
		// When running: show active tools as live progress
		if (!this.running && details?.allTools && details.allTools.length > 0) {
			const finalOutput = this.result?.content?.find((c) => c.type === "text")?.text;
			lines.push(...renderAgentSummary(agentName, details.allTools, indent, finalOutput));
		} else if (details?.activeTools && details.activeTools.length > 0) {
			const tools = details.activeTools.slice(-MAX_SUBAGENT_TOOLS);
			for (const tool of tools) {
				const toolIcon = ICONS[tool.toolName] ?? "\uf013";
				let statusIcon: string;
				if (tool.running) {
					statusIcon = theme.fg("warning", "◐");
				} else if (tool.isError) {
					statusIcon = theme.fg("error", "✗");
				} else {
					statusIcon = theme.fg("success", "✓");
				}
				const argSummary = formatSubagentToolArgs(tool.toolName, tool.args);
				lines.push(`${indent}${statusIcon} ${toolIcon} ${theme.fg("muted", tool.toolName)} ${argSummary}`);
			}
			if (details.activeTools.length > MAX_SUBAGENT_TOOLS) {
				lines.push(`${indent}${theme.fg("muted", `… ${details.activeTools.length - MAX_SUBAGENT_TOOLS} more`)}`);
			}
		}

		// Streaming thinking: sliding window of last 5 lines (hidden when done)
		if (this.running && details?.currentThinking) {
			const thinkLines = details.currentThinking.split("\n").filter((l) => l.trim());
			const MAX_THINKING_LINES = 5;
			const skipped = Math.max(0, thinkLines.length - MAX_THINKING_LINES);
			if (skipped > 0) {
				lines.push(`${indent}${theme.fg("muted", `💭 … ${skipped} lines above`)}`);
			}
			const visible = thinkLines.slice(-MAX_THINKING_LINES);
			for (const line of visible) {
				lines.push(`${indent}${theme.fg("dim", `💭 ${line}`)}`);
			}
		}

		// Streaming text (while running)
		if (this.running && details?.currentText) {
			const textLines = details.currentText.split("\n").filter((l) => l.trim());
			const last = textLines.slice(-MAX_SUBAGENT_TEXT_LINES);
			for (const line of last) {
				const truncated = line.length > 80 ? `${line.slice(0, 77)}...` : line;
				lines.push(`${indent}${theme.fg("dim", truncated)}`);
			}
		}

		// Usage summary (when done)
		if (!this.running && details?.results && details.results.length > 0) {
			const totalTurns = details.results.reduce((sum, r) => sum + r.usage.turns, 0);
			const totalCost = details.results.reduce((sum, r) => sum + r.usage.cost, 0);
			const parts: string[] = [];
			if (totalTurns > 0) parts.push(`${totalTurns} turns`);
			if (totalCost > 0) parts.push(`$${totalCost.toFixed(4)}`);
			if (parts.length) {
				lines.push(`${indent}${theme.fg("muted", parts.join(" · "))}`);
			}
		}

		return lines.join("\n");
	}

	private errorLines(): string[] {
		if (!this.result?.isError) return [];
		const out = this.output();
		if (!out) return [];
		const allLines = out.split("\n");
		const lines = allLines.slice(0, MAX_ERROR_LINES);
		if (allLines.length > MAX_ERROR_LINES) {
			lines.push(theme.fg("muted", `… ${allLines.length - MAX_ERROR_LINES} more`));
		}
		return lines.map((l) => theme.fg("error", `   ${l}`));
	}

	/**
	 * Lines to show when force-expanded by bash command rules.
	 * Only applies to successful bash results with displayHints.forceExpand.
	 */
	private expandedOutputLines(): string[] {
		if (this.result?.isError) return [];
		if (!this.expanded) return [];
		const details = this.result?.details;
		const hints = isBashDetails(details) ? details.displayHints : undefined;
		if (!hints?.forceExpand) return [];
		const out = this.output();
		if (!out) return [];
		const maxLines = hints.maxOutputLines ?? MAX_EXPANDED_OUTPUT_LINES;
		const allLines = out.split("\n");
		const lines = allLines.slice(0, maxLines);
		if (allLines.length > maxLines) {
			lines.push(theme.fg("muted", `… ${allLines.length - maxLines} more`));
		}
		return lines.map((l) => `   ${l}`);
	}

	private update(): void {
		const main = this.formatLine();
		const argsLines = this.formatArgsLines();
		const expanded = this.expandedOutputLines();
		const errors = this.errorLines();
		const sections = [main];
		if (argsLines.length) sections.push(argsLines.join("\n"));
		if (expanded.length) sections.push(expanded.join("\n"));
		if (errors.length) sections.push(errors.join("\n"));
		this.text.setText(sections.join("\n"));
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.update();
		}
	}
	setShowImages(_show: boolean): void {}
	setArgsComplete(): void {}

	// Clean up timer on disposal
	dispose(): void {
		this.stopPulse();
	}
}
