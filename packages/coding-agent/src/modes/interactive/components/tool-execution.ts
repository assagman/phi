import * as os from "node:os";
import stripAnsi from "strip-ansi";
import { Container, Text, type TUI } from "tui";
import type { SubagentDetails } from "../../../core/builtin-tools/subagent/index.js";
import type { BashToolDetails } from "../../../core/tools/bash.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { highlightCode, type ThemeColor, theme } from "../theme/theme.js";

const MAX_ERROR_LINES = 10;
const MAX_CMD_LINES = 10;
const MAX_ARG_LINES = 12;
const MAX_SUBAGENT_STREAM_LINES = 10;
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

		// Accumulated tool calls — always visible (running and done)
		if (details?.allTools && details.allTools.length > 0) {
			for (const tool of details.allTools) {
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
		}

		// Thinking + text: combined sliding window, always visible
		{
			const thinkLines = (details?.currentThinking ?? "")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => ({ type: "thinking" as const, text: l }));
			const textLines = (details?.currentText ?? "")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => ({ type: "text" as const, text: l }));
			const combined = [...thinkLines, ...textLines];
			if (combined.length > 0) {
				const visible = combined.slice(-MAX_SUBAGENT_STREAM_LINES);
				const skipped = combined.length - visible.length;
				if (skipped > 0) {
					lines.push(`${indent}${theme.fg("muted", `… ${skipped} lines above`)}`);
				}
				for (const entry of visible) {
					const truncated = entry.text.length > 80 ? `${entry.text.slice(0, 77)}...` : entry.text;
					if (entry.type === "thinking") {
						lines.push(`${indent}\x1b[3m${theme.fg("thinkingText", truncated)}\x1b[23m`);
					} else {
						lines.push(`${indent}${theme.fg("dim", truncated)}`);
					}
				}
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
