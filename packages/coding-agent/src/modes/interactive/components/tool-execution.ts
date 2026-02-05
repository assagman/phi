import * as os from "node:os";
import stripAnsi from "strip-ansi";
import { Container, LiveFeed, type LiveFeedItem, sliceByColumn, Text, type TUI, visibleWidth } from "tui";
import type { SubagentDetails } from "../../../core/builtin-tools/subagent/index.js";
import type { BashToolDetails } from "../../../core/tools/bash.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { highlightCode, type ThemeColor, theme } from "../theme/theme.js";

const MAX_ERROR_LINES = 10;
const MAX_CMD_LINES = 10;
const MAX_ARG_LINES = 12;
const MAX_SUBAGENT_BOX_LINES = 20;
const MAX_EXPANDED_OUTPUT_LINES = 20;
const MAX_STREAMING_PREVIEW_LINES = 8;
const MAX_SUBAGENT_TASK_LINES = 6;
const PULSE_PERIOD_MS = 1500; // Full pulse cycle duration
const BORDER_PULSE_PERIOD_MS = 3000; // Slow border pulse cycle
const PULSE_INTERVAL_MS = 100; // Pulse animation tick (~10fps, sufficient for smooth sine)

/** Per-agent hex color overrides (agent name → hex) */
const AGENT_COLORS: Record<string, string> = {
	reviewer: "#5E27F5",
};

/**
 * Colorize agent name using per-agent override or toolSubagent theme color.
 */
function colorAgentName(name: string): string {
	const hex = AGENT_COLORS[name];
	if (hex) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `\x1b[38;2;${r};${g};${b}m${name}\x1b[39m`;
	}
	return theme.fg("toolSubagent", name);
}

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
	subagent: "toolSubagent",
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
			return theme.fg("dim", cmd);
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
	/** Last known content width from render(), used for split-pane column math. */
	private lastContentWidth = 0;
	/** Once split-pane layout is shown, preserve it even when right pane temporarily empties between turns. */
	private hadSplitLayout = false;
	/** Cached LiveFeed for subagent task summary (avoids re-creation every ~100ms render). */
	private subagentTaskFeed?: LiveFeed;

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
		this.pulseTimer = setInterval(() => {
			if (this.running) {
				this.update();
				this.onInvalidate?.();
				this.ui?.requestRender();
			}
		}, PULSE_INTERVAL_MS);
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
		return theme.italic(theme.fg("toolPath", path));
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
	 * Rich rendering for subagent tool calls — split-pane layout.
	 *
	 * Layout (inside bordered box):
	 *   Header:  icon + tool name + agent name + meta   (full width)
	 *   Task:    summary text                           (full width)
	 *   Split:   tool calls (left)  │  thinking+text (right)
	 *   Footer:  usage summary when done                (full width)
	 *
	 * Left pane: 40% width, tool call list (sliding window).
	 * Right pane: remaining width, thinking + assistant text (sliding window).
	 * Both panes independently scroll within MAX_SUBAGENT_BOX_LINES budget.
	 */
	private formatSubagentLine(i: string, s: string): string {
		const details = isSubagentDetails(this.result?.details) ? this.result!.details : undefined;
		const agentName = details?.agentName || String(this.args.agent ?? "");
		const taskText = details?.task || String(this.args.task ?? "");
		const mode = details?.mode;

		const indent = "   ";

		// ── Fixed: header ───────────────────────────────────────────────
		const fixedTop: string[] = [];

		const modeLabel = mode && mode !== "single" ? theme.fg("muted", ` (${mode})`) : "";
		const metaParts: string[] = [];
		if (details) {
			if (details.agentProvider) metaParts.push(`provider: ${details.agentProvider}`);
			if (details.agentModel) metaParts.push(`model: ${details.agentModel}`);
			if (details.agentThinkingLevel) metaParts.push(`thinking:${details.agentThinkingLevel}`);
			if (details.agentTemperature != null) metaParts.push(`temp:${details.agentTemperature}`);
		}
		const metaSuffix = metaParts.length > 0 ? ` ${theme.fg("dim", metaParts.join(" · "))}` : "";

		if (agentName) {
			fixedTop.push(`${i} ${this.pulsed("subagent")} ${colorAgentName(agentName)}${modeLabel}${metaSuffix} ${s}`);
		} else {
			fixedTop.push(`${i} ${this.pulsed("subagent")}${modeLabel}${metaSuffix} ${s}`);
		}

		// ── Fixed: task summary ─────────────────────────────────────────
		const subprocessActive = details?.allTools && details.allTools.length > 0;
		if (this.running && !subprocessActive && taskText.length > 0) {
			// Reuse cached LiveFeed to avoid re-allocation every ~100ms render tick
			if (!this.subagentTaskFeed) {
				this.subagentTaskFeed = new LiveFeed({
					maxLines: MAX_SUBAGENT_TASK_LINES,
					overflowText: (n) => theme.fg("muted", `… ${n} lines above`),
				});
			}
			const taskLines = taskText.split("\n").filter((l) => l.trim());
			const items: LiveFeedItem[] = taskLines.map((line, idx) => ({
				id: `task:${idx}`,
				text: theme.fg("dim", line),
			}));
			this.subagentTaskFeed.setItems(items);
			const contentWidth = this.lastContentWidth || 74;
			const taskWidth = Math.max(1, contentWidth - 3);
			for (const line of this.subagentTaskFeed.render(taskWidth)) {
				fixedTop.push(`${indent}${line}`);
			}
		} else {
			const summaryText = details?.summary ?? taskText;
			if (summaryText.length > 0) {
				for (const line of summaryText.split("\n").filter((l) => l.trim())) {
					fixedTop.push(`${indent}${theme.fg("muted", `"${line}"`)}`);
				}
			}
		}

		// ── Fixed: usage summary (bottom, when done) ────────────────────
		const fixedBottom: string[] = [];
		if (!this.running && details?.results && details.results.length > 0) {
			const totalTurns = details.results.reduce((sum, r) => sum + r.usage.turns, 0);
			const totalCost = details.results.reduce((sum, r) => sum + r.usage.cost, 0);
			const parts: string[] = [];
			if (totalTurns > 0) parts.push(`${totalTurns} turns`);
			if (totalCost > 0) parts.push(`$${totalCost.toFixed(4)}`);
			if (parts.length) {
				fixedBottom.push(`${indent}${theme.fg("muted", parts.join(" · "))}`);
			}
		}

		// ── Left pane: tool calls + parallel/chain progress (LiveFeed items) ──
		const leftItems: LiveFeedItem[] = [];

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
				leftItems.push({
					id: `parallel:${idx}`,
					text: `${taskStatus} ${colorAgentName(t.agent)} ${theme.fg("muted", `"${t.task}"`)}`,
				});
			}
		}

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
				leftItems.push({
					id: `chain:${idx}`,
					text: `${stepStatus} ${theme.fg("muted", `${idx + 1}:`)} ${colorAgentName(step.agent)} ${theme.fg("muted", `"${step.task}"`)}`,
				});
			}
		}

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
				leftItems.push({
					id: `tool:${tool.toolCallId}`,
					text: `${statusIcon} ${toolIcon} ${theme.fg("muted", tool.toolName)} ${argSummary}`,
				});
			}
		}

		// ── Right pane: thinking + text streams (LiveFeed items) ─────────
		const rightItems: LiveFeedItem[] = [];

		const thinkText = (details?.currentThinking ?? "")
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => theme.italic(theme.fg("thinkingText", line)))
			.join("\n");
		if (thinkText) {
			rightItems.push({ id: "thinking", text: thinkText });
		}

		const streamText = (details?.currentText ?? "")
			.split("\n")
			.filter((l) => l.trim())
			.join("\n");
		if (streamText) {
			rightItems.push({ id: "text", text: streamText });
		}

		// ── No split content? Return simple layout ──────────────────────
		const hasLeft = leftItems.length > 0;
		const hasRight = rightItems.length > 0;

		// Once split-pane has been shown, keep using it even when right pane
		// temporarily empties between turns (prevents layout flicker).
		if (hasLeft && hasRight) {
			this.hadSplitLayout = true;
		}
		const useSplit = (hasLeft && hasRight) || (this.hadSplitLayout && hasLeft && this.running);

		if (!hasLeft && !hasRight) {
			return [...fixedTop, ...fixedBottom].join("\n");
		}

		const paneBudget = Math.max(1, MAX_SUBAGENT_BOX_LINES - fixedTop.length - fixedBottom.length);
		const overflowFn = (n: number) => theme.fg("muted", `\u2026 ${n} lines above`);

		// If only one side has content and split isn't locked, use full-width single column
		if (!useSplit) {
			const items = hasLeft ? leftItems : rightItems;
			const feed = new LiveFeed({ maxLines: paneBudget, overflowText: overflowFn });
			feed.setItems(items);
			const contentWidth = this.lastContentWidth || 74;
			const feedWidth = Math.max(1, contentWidth - 3); // subtract indent
			const feedLines = feed.render(feedWidth).map((l) => `${indent}${l}`);
			return [...fixedTop, ...feedLines, ...fixedBottom].join("\n");
		}

		// ── Split-pane: merge left and right side-by-side ───────────────
		// Column widths derived from actual render width (stored by render()).
		// indent(3) + leftWidth + " │ "(3) + rightWidth = contentWidth
		const contentWidth = this.lastContentWidth || 74; // 74 = 80 - 6 fallback
		const divider = theme.fg("dim", "│");
		const indentWidth = 3;
		const dividerWidth = 3; // " │ "
		const paneSpace = Math.max(10, contentWidth - indentWidth - dividerWidth);
		const leftWidth = Math.max(10, Math.floor(paneSpace * 0.4));
		const rightWidth = Math.max(10, paneSpace - leftWidth);

		// Use LiveFeed for each pane's sliding window
		const leftFeed = new LiveFeed({ maxLines: paneBudget, overflowText: overflowFn });
		leftFeed.setItems(leftItems);
		const leftVisible = leftFeed.render(leftWidth);

		const rightFeed = new LiveFeed({ maxLines: paneBudget, overflowText: overflowFn });
		rightFeed.setItems(rightItems);
		const rightVisible = rightFeed.render(rightWidth);

		// Merge side-by-side, padding shorter side
		const maxRows = Math.max(leftVisible.length, rightVisible.length);
		const splitLines: string[] = [];
		for (let row = 0; row < maxRows; row++) {
			const lLine = leftVisible[row] ?? "";
			const rLine = rightVisible[row] ?? "";
			const lVis = visibleWidth(lLine);
			const lPad = Math.max(0, leftWidth - lVis);
			const lClamped = lVis > leftWidth ? sliceByColumn(lLine, 0, leftWidth, true) : lLine;
			const lPadded = lVis > leftWidth ? lClamped : `${lLine}${" ".repeat(lPad)}`;
			splitLines.push(`${indent}${lPadded} ${divider} ${rLine}`);
		}

		return [...fixedTop, ...splitLines, ...fixedBottom].join("\n");
	}

	private errorLines(): string[] {
		if (!this.result?.isError) return [];
		const out = this.output();
		if (!out) return [];
		// Errors show head (first lines) — LiveFeed shows tail, so use manual truncation here
		const allLines = out.split("\n");
		const lines = allLines.slice(0, MAX_ERROR_LINES);
		if (allLines.length > MAX_ERROR_LINES) {
			lines.push(theme.fg("muted", `\u2026 ${allLines.length - MAX_ERROR_LINES} more`));
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
			lines.push(theme.fg("muted", `\u2026 ${allLines.length - maxLines} more`));
		}
		return lines.map((l) => `   ${l}`);
	}

	/**
	 * Streaming output preview for all non-subagent tools while running.
	 * Uses LiveFeed to show a sliding window of the latest output lines.
	 */
	private streamingOutputLines(): string[] {
		// Only show for running tools with partial output, not subagent (it has its own display)
		if (!this.running || this.toolName === "subagent") return [];
		const out = this.output();
		if (!out) return [];
		const allLines = out.split("\n");
		if (allLines.length === 0) return [];

		const feed = new LiveFeed({
			maxLines: MAX_STREAMING_PREVIEW_LINES,
			overflowText: (n) => theme.fg("muted", `\u2026 ${n} lines above`),
		});
		for (let idx = 0; idx < allLines.length; idx++) {
			feed.addItem({ id: `stream:${idx}`, text: theme.fg("dim", allLines[idx]) });
		}
		// Use a reasonable width; actual width is applied by Text component wrapping
		const feedLines = feed.render(200);
		return feedLines.map((l) => `   ${l}`);
	}

	private update(): void {
		const main = this.formatLine();
		const argsLines = this.formatArgsLines();
		const streaming = this.streamingOutputLines();
		const expanded = this.expandedOutputLines();
		const errors = this.errorLines();
		const sections = [main];
		if (argsLines.length) sections.push(argsLines.join("\n"));
		if (streaming.length) sections.push(streaming.join("\n"));
		if (expanded.length) sections.push(expanded.join("\n"));
		if (errors.length) sections.push(errors.join("\n"));
		this.text.setText(sections.join("\n"));
	}

	/**
	 * Override render to wrap subagent output in a bordered box with pulsing border.
	 */
	render(width: number): string[] {
		if (this.toolName !== "subagent") return super.render(width);

		// Render children at reduced width: 2 for │ chars + 2 for inner padding
		const innerWidth = Math.max(1, width - 4);
		// Text component subtracts paddingX*2 (=2) for its content area.
		// Store this so formatSubagentLine() can size split-pane columns correctly.
		const contentWidth = Math.max(1, innerWidth - 2);
		if (this.lastContentWidth !== contentWidth) {
			this.lastContentWidth = contentWidth;
			this.update();
		}

		const innerLines: string[] = [];
		for (const child of this.children) {
			innerLines.push(...child.render(innerWidth));
		}
		if (innerLines.length === 0) return [];

		const bc = this.borderPulseColor();
		const reset = "\x1b[39m";
		const hBar = "─".repeat(width - 2);
		const result: string[] = [`${bc}┌${hBar}┐${reset}`];

		for (const line of innerLines) {
			const vis = visibleWidth(line);
			const pad = Math.max(0, innerWidth - vis);
			result.push(`${bc}│${reset} ${line}${" ".repeat(pad)} ${bc}│${reset}`);
		}

		result.push(`${bc}└${hBar}┘${reset}`);
		return result;
	}

	/**
	 * Slow-pulsing border color for subagent box.
	 * Uses toolSubagent RGB with a 3s sine wave cycle.
	 * Dims to 30% when done.
	 */
	private borderPulseColor(): string {
		const rgb = theme.getFgRgb("toolSubagent");
		if (!rgb) return theme.getFgAnsi("toolSubagent");

		if (!this.running) {
			const [r, g, b] = rgb.map((c) => Math.round(c * 0.3));
			return `\x1b[38;2;${r};${g};${b}m`;
		}

		const elapsed = Date.now() - this.startTime;
		const t = (Math.sin((elapsed / BORDER_PULSE_PERIOD_MS) * Math.PI * 2) + 1) / 2;
		const brightness = 0.2 + t * 0.8;
		const [r, g, b] = rgb.map((c) => Math.round(c * brightness));
		return `\x1b[38;2;${r};${g};${b}m`;
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
