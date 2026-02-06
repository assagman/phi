import * as os from "node:os";
import stripAnsi from "strip-ansi";
import { Container, LiveFeed, type LiveFeedItem, sliceByColumn, Text, type TUI, visibleWidth } from "tui";
import type {
	ParallelAgentProgress,
	SubagentDetails,
	SubagentStreamItem,
} from "../../../core/builtin-tools/subagent/index.js";
import type { BashToolDetails } from "../../../core/tools/bash.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { highlightCode, type ThemeColor, theme } from "../theme/theme.js";

/** Unified sliding-window line limit for all LiveFeed sections */
const MAX_FEED_LINES = 5;
const MAX_CMD_LINES = 5;
const MAX_SUBAGENT_BOX_LINES = 20;
const PULSE_PERIOD_MS = 1500; // Full pulse cycle duration
const BORDER_PULSE_PERIOD_MS = 3000; // Slow border pulse cycle
const PULSE_INTERVAL_MS = 100; // Pulse animation tick (~10fps, sufficient for smooth sine)

/** Per-agent hex color overrides (agent name → hex) */
const AGENT_COLORS: Record<string, string> = {
	reviewer: "#F54927",
	planner: "#57B5AD",
	committer: "#F5EE7D",
	explorer: "#6BEDE0",
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

/**
 * Detect likely output language from a bash command string.
 * Returns a language identifier for syntax highlighting, or undefined.
 */
function detectOutputLanguage(command: string): string | undefined {
	const cmd = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "");
	switch (cmd) {
		case "node":
		case "bun":
		case "deno":
			return "javascript";
		case "python":
		case "python3":
			return "python";
		case "ruby":
			return "ruby";
		case "cargo":
		case "rustc":
			return "rust";
		case "go":
			return "go";
		case "jq":
			return "json";
		case "curl":
		case "wget":
			// Often returns JSON/HTML
			if (command.includes("json") || command.includes("api")) return "json";
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Detect language from file path extension for syntax highlighting.
 */
function detectLanguageFromPath(filePath: string): string | undefined {
	if (!filePath) return undefined;
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	const extMap: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		json: "json",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		md: "markdown",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		css: "css",
		html: "html",
		xml: "xml",
		sql: "sql",
	};
	return extMap[ext];
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
	private pulseUnsubscribe?: () => void;
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
		if (this.pulseUnsubscribe || !this.ui) return;
		this.pulseUnsubscribe = this.ui.subscribeToAnimationTicks(() => {
			if (!this.running) return;
			this.update();
			this.onInvalidate?.();
		}, PULSE_INTERVAL_MS);
	}

	private stopPulse(): void {
		if (this.pulseUnsubscribe) {
			this.pulseUnsubscribe();
			this.pulseUnsubscribe = undefined;
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

		const indent = "   ";
		const label = theme.fg("muted", "args:");
		const feed = new LiveFeed({
			maxLines: MAX_FEED_LINES,
			overflowText: (n) => theme.fg("muted", `… ${n} lines above`),
		});
		// First line gets "args: " prefix, rest get continuation indent
		const continuation = " ".repeat(6);
		feed.addItem({ id: "args:0", text: `${label} ${highlighted[0] ?? ""}` });
		for (let i = 1; i < highlighted.length; i++) {
			feed.addItem({ id: `args:${i}`, text: `${continuation}${highlighted[i]}` });
		}
		return feed.render(200).map((l) => `${indent}${l}`);
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
				return `${i} ${this.pulsed("read")} ${this.formatPath(path)}${theme.fg("toolReadRange", range)}${stats} ${s}`;
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
				const highlighted = highlightCode(cmd, "bash");
				const n = this.lineCount();
				const stats = n > 0 ? theme.fg("muted", ` ${n} lines`) : "";

				if (highlighted.length === 1) {
					return `${i} ${this.pulsed("bash")} $ ${highlighted[0]}${stats} ${s}`;
				}
				// Multi-line: use LiveFeed for sliding window
				const indent = "   ";
				const cmdFeed = new LiveFeed({
					maxLines: MAX_CMD_LINES,
					overflowText: (count) => theme.fg("muted", `… ${count} lines above`),
				});
				cmdFeed.addItem({ id: "cmd:0", text: `${i} ${this.pulsed("bash")} $ ${highlighted[0]}` });
				for (let idx = 1; idx < highlighted.length; idx++) {
					cmdFeed.addItem({ id: `cmd:${idx}`, text: `${indent}${highlighted[idx]}` });
				}
				const feedLines = cmdFeed.render(200);
				feedLines.push(`${indent}${stats} ${s}`);
				return feedLines.join("\n");
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
					maxLines: MAX_FEED_LINES,
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

		// ── Parallel mode: stacked per-agent sections ───────────────────
		if (mode === "parallel" && details?.parallelAgents && details.parallelAgents.length > 0) {
			const contentWidth = this.lastContentWidth || 74;
			const sectionWidth = Math.max(1, contentWidth - 3); // subtract indent
			const agentLines: string[] = [];

			for (let idx = 0; idx < details.parallelAgents.length; idx++) {
				// Spacer between agent sections for visual separation
				if (idx > 0) agentLines.push("");
				agentLines.push(...this.formatParallelAgentSection(details.parallelAgents[idx], sectionWidth));
			}

			return [...fixedTop, ...agentLines, ...fixedBottom].join("\n");
		}

		// ── Left pane: tool calls + parallel/chain progress (LiveFeed items) ──
		const leftItems: LiveFeedItem[] = [];

		// Fallback parallel display (when parallelAgents is unavailable)
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
		// Use accumulated streamItems for persistent history across turns.
		// Each item becomes a separate LiveFeed entry so the sliding window
		// naturally scrolls older content out as new content arrives.
		const rightItems: LiveFeedItem[] = [];
		const items: SubagentStreamItem[] | undefined = details?.streamItems;

		if (items && items.length > 0) {
			for (const item of items) {
				const filtered = item.content
					.split("\n")
					.filter((l) => l.trim())
					.join("\n");
				if (!filtered) continue;
				if (item.type === "thinking") {
					rightItems.push({
						id: `stream:${item.seq}`,
						text: filtered
							.split("\n")
							.map((line) => theme.italic(theme.fg("thinkingText", line)))
							.join("\n"),
					});
				} else {
					rightItems.push({ id: `stream:${item.seq}`, text: filtered });
				}
			}
		}

		// Fallback: use currentThinking/currentText when streamItems is empty
		// or all items filtered to whitespace (e.g. parallel/chain modes)
		if (rightItems.length === 0) {
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

	/**
	 * Render a single parallel agent as a compact stacked section.
	 * Uses LiveFeed for both tool list and stream preview.
	 *
	 * Layout per agent:
	 *   ◐ agent_name "task description"              (header)
	 *      ✓  read src/auth.ts                      (tool list, LiveFeed)
	 *      ◐  bash rg "TODO" src/                   (tool list, LiveFeed)
	 *      › Looking at the authentication flow...   (stream preview, LiveFeed)
	 */
	private formatParallelAgentSection(agent: ParallelAgentProgress, width: number): string[] {
		const indent = "   ";
		const toolIndent = "      ";
		const lines: string[] = [];

		// ── Status icon ─────────────────────────────────────────────────
		let statusIcon: string;
		if (agent.result && agent.result.exitCode !== -1) {
			statusIcon = agent.result.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
		} else if (agent.result) {
			// exitCode === -1 means running
			statusIcon = theme.fg("warning", "◐");
		} else {
			statusIcon = theme.fg("muted", "○");
		}

		// ── Header: status + agent name + task ──────────────────────────
		const taskPreview = agent.task.length > 60 ? `${agent.task.slice(0, 57)}...` : agent.task;
		const headerLine = `${indent}${statusIcon} ${colorAgentName(agent.agentName)} ${theme.fg("muted", `"${taskPreview}"`)}`;
		lines.push(visibleWidth(headerLine) > width ? sliceByColumn(headerLine, 0, width, true) : headerLine);

		// ── Tool list via LiveFeed ──────────────────────────────────────
		const tools = agent.allTools;
		if (tools && tools.length > 0) {
			const toolFeed = new LiveFeed({
				maxLines: MAX_FEED_LINES,
				overflowText: (n) => theme.fg("muted", `… ${n} earlier tools`),
			});
			for (const tool of tools) {
				const toolIcon = ICONS[tool.toolName] ?? "\uf013";
				let toolStatus: string;
				if (tool.running) {
					toolStatus = theme.fg("warning", "◐");
				} else if (tool.isError) {
					toolStatus = theme.fg("error", "✗");
				} else {
					toolStatus = theme.fg("success", "✓");
				}
				const argSummary = formatSubagentToolArgs(tool.toolName, tool.args);
				toolFeed.addItem({
					id: `tool:${tool.toolCallId}`,
					text: `${toolStatus} ${toolIcon} ${theme.fg("muted", tool.toolName)} ${argSummary}`,
				});
			}
			const toolWidth = Math.max(1, width - 6); // subtract toolIndent
			for (const line of toolFeed.render(toolWidth)) {
				lines.push(`${toolIndent}${line}`);
			}
		}

		// ── Stream preview via LiveFeed ─────────────────────────────────
		const streamFeed = new LiveFeed({
			maxLines: MAX_FEED_LINES,
			overflowText: (n) => theme.fg("muted", `… ${n} lines above`),
		});
		const streamItemsList = agent.streamItems;

		if (streamItemsList && streamItemsList.length > 0) {
			for (const item of streamItemsList) {
				const filtered = item.content.split("\n").filter((l) => l.trim());
				if (filtered.length === 0) continue;
				for (let li = 0; li < filtered.length; li++) {
					const styled =
						item.type === "thinking" ? theme.italic(theme.fg("thinkingText", filtered[li])) : filtered[li];
					streamFeed.addItem({ id: `stream:${item.seq}:${li}`, text: styled });
				}
			}
		} else {
			const thinkLines = (agent.currentThinking ?? "").split("\n").filter((l) => l.trim());
			for (let i = 0; i < thinkLines.length; i++) {
				streamFeed.addItem({ id: `think:${i}`, text: theme.italic(theme.fg("thinkingText", thinkLines[i])) });
			}
			const textLines = (agent.currentText ?? "").split("\n").filter((l) => l.trim());
			for (let i = 0; i < textLines.length; i++) {
				streamFeed.addItem({ id: `text:${i}`, text: textLines[i] });
			}
		}

		if (streamFeed.length > 0) {
			const streamWidth = Math.max(1, width - 6); // subtract toolIndent
			for (const line of streamFeed.render(streamWidth)) {
				lines.push(`${toolIndent}${theme.fg("dim", "›")} ${line}`);
			}
		}

		return lines;
	}

	private errorLines(): string[] {
		if (!this.result?.isError) return [];
		const out = this.output();
		if (!out) return [];
		// Errors use head truncation: the most useful info (error type, file, line)
		// is typically at the top, while tail is often noisy stack frames.
		const allLines = out.split("\n");
		const lines = allLines.slice(0, MAX_FEED_LINES);
		if (allLines.length > MAX_FEED_LINES) {
			lines.push(theme.fg("muted", `… ${allLines.length - MAX_FEED_LINES} more`));
		}
		return lines.map((l) => `   ${theme.fg("error", l)}`);
	}

	/**
	 * Lines to show when force-expanded by bash command rules.
	 * Only applies to successful bash results with displayHints.forceExpand.
	 * Uses LiveFeed sliding window with syntax highlighting.
	 */
	private expandedOutputLines(): string[] {
		if (this.result?.isError) return [];
		if (!this.expanded) return [];
		const details = this.result?.details;
		const hints = isBashDetails(details) ? details.displayHints : undefined;
		if (!hints?.forceExpand) return [];
		const out = this.output();
		if (!out) return [];
		// Respect displayHints.maxOutputLines when explicitly provided
		const effectiveMax = hints.maxOutputLines ?? MAX_FEED_LINES;
		const allLines = out.split("\n");
		// Only highlight the visible tail to avoid O(n) work on full output
		const tailStart = Math.max(0, allLines.length - effectiveMax);
		const tailLines = allLines.slice(tailStart);
		const lang = detectOutputLanguage(String(this.args.command ?? ""));
		const highlighted = lang ? highlightCode(tailLines.join("\n"), lang) : tailLines;
		// Skip feeding placeholder items — use tailStart directly in overflowText
		const hiddenCount = tailStart;
		const feed = new LiveFeed({
			maxLines: effectiveMax,
			overflowText: () => theme.fg("muted", `… ${hiddenCount} lines above`),
		});
		for (let i = 0; i < highlighted.length; i++) {
			feed.addItem({ id: `exp:${i}`, text: highlighted[i] });
		}
		return feed.render(200).map((l) => `   ${l}`);
	}

	/**
	 * Streaming output preview for all non-subagent tools while running.
	 * Uses LiveFeed to show a sliding window of the latest output lines
	 * with syntax highlighting based on tool context.
	 */
	private streamingOutputLines(): string[] {
		// Only show for running tools with partial output, not subagent (it has its own display)
		if (!this.running || this.toolName === "subagent") return [];
		const out = this.output();
		if (!out) return [];
		const allLines = out.split("\n");
		if (allLines.length === 0) return [];

		// Detect language from context for syntax highlighting.
		// Only highlight the visible tail to avoid O(n) highlighting on full output.
		const lang =
			this.toolName === "bash"
				? detectOutputLanguage(String(this.args.command ?? ""))
				: detectLanguageFromPath(String(this.args.path ?? ""));
		const tailStart = Math.max(0, allLines.length - MAX_FEED_LINES);
		const tailLines = allLines.slice(tailStart);
		const highlighted = lang ? highlightCode(tailLines.join("\n"), lang) : null;

		// Skip feeding placeholder items — use tailStart directly in overflowText
		const hiddenCount = tailStart;
		const feed = new LiveFeed({
			maxLines: MAX_FEED_LINES,
			overflowText: () => theme.fg("muted", `… ${hiddenCount} lines above`),
		});
		for (let idx = 0; idx < tailLines.length; idx++) {
			const text = highlighted ? (highlighted[idx] ?? tailLines[idx]) : theme.fg("dim", tailLines[idx]);
			feed.addItem({ id: `stream:${idx}`, text });
		}
		return feed.render(200).map((l) => `   ${l}`);
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
