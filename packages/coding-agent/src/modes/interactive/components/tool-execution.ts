import * as os from "node:os";
import stripAnsi from "strip-ansi";
import { Container, Text, type TUI } from "tui";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { highlightCode, type ThemeColor, theme } from "../theme/theme.js";

const MAX_ERROR_LINES = 10;
const MAX_CMD_LINES = 10;
const PULSE_PERIOD_MS = 1500; // Full pulse cycle duration

const ICONS: Record<string, string> = {
	read: "\uf02d", // nf-fa-book
	edit: "\uf044", // nf-fa-pencil_square_o
	write: "\uf0f6", // nf-fa-file_text_o
	bash: "\uf120", // nf-fa-terminal
	ls: "\uf07c", // nf-fa-folder_open
	find: "\uf002", // nf-fa-search
	grep: "\uf0b0", // nf-fa-filter
};

const COLORS: Record<string, ThemeColor> = {
	read: "toolRead",
	edit: "toolEdit",
	write: "toolWrite",
	bash: "toolBash",
	ls: "toolRead",
	find: "toolFind",
	grep: "toolGrep",
};

function shorten(path: string): string {
	const home = os.homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
	details?: { diff?: string };
}

/**
 * Compact single-line tool execution display with pulse animation
 */
export class ToolExecutionComponent extends Container {
	private text: Text;
	private toolName: string;
	private args: Record<string, unknown> = {};
	private result?: ToolResult;
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
		const diff = this.result?.details?.diff;
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
	 * Apply pulse color to text
	 */
	private pulsed(text: string): string {
		const color = this.pulseColor(this.color());
		return `${color}${text}\x1b[39m`;
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
				return `${i} ${this.pulsed("read")} ${theme.fg("accent", path)}${theme.fg("warning", range)}${stats} ${s}`;
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
				return `${i} ${this.pulsed("edit")} ${theme.fg("accent", path)}${stats} ${s}`;
			}

			case "write": {
				const content = String(this.args.content ?? "");
				const n = content ? content.split("\n").length : 0;
				const stats = n > 0 ? theme.fg("muted", ` ${n} lines`) : "";
				return `${i} ${this.pulsed("write")} ${theme.fg("accent", path)}${stats} ${s}`;
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

			default:
				return `${i} ${this.pulsed(this.toolName)} ${s}`;
		}
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

	private update(): void {
		const main = this.formatLine();
		const errors = this.errorLines();
		this.text.setText(errors.length ? `${main}\n${errors.join("\n")}` : main);
	}

	// Compatibility stubs (no-op)
	setExpanded(_expanded: boolean): void {}
	setShowImages(_show: boolean): void {}
	setArgsComplete(): void {}

	// Clean up timer on disposal
	dispose(): void {
		this.stopPulse();
	}
}
