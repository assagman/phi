/**
 * Tool History Selector — Popup for viewing tool execution history.
 *
 * Shows a scrollable list of tool executions with the ability to view
 * full output for any execution.
 *
 * Features:
 * - Scrollable content view with keyboard navigation (#62)
 * - Text wrapping for long lines (#59)
 * - Markdown rendering for structured content (#60)
 * - Syntax highlighting for code (#61)
 */

import * as os from "node:os";
import stripAnsi from "strip-ansi";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "tui";
import type { ToolExecution, ToolExecutionStorage } from "../../../core/tool-execution-storage.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { getLanguageFromPath, getMarkdownTheme, highlightCode, theme } from "../theme/theme.js";
import { rawKeyHint } from "./keybinding-hints.js";

// ============ Types ============

type ViewMode = "list" | "detail";

// ============ Pre-compiled Patterns ============

// Combined regex for markdown detection (hoisted for performance)
const MARKDOWN_PATTERN = /^#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+\.\s+|```[\s\S]*```|\[.*?\]\(.*?\)|^\s*>/m;

// ============ Icons & Colors ============

const ICONS: Record<string, string> = {
	read: "\uf02d", // nf-fa-book
	edit: "\uf044", // nf-fa-pencil_square_o
	write: "\uf0f6", // nf-fa-file_text_o
	bash: "\uf120", // nf-fa-terminal
	ls: "\uf07c", // nf-fa-folder_open
	find: "\uf002", // nf-fa-search
	grep: "\uf0b0", // nf-fa-filter
};

function getIcon(toolName: string): string {
	return ICONS[toolName] ?? "\uf013"; // nf-fa-cog
}

// ============ Helpers ============

function shorten(path: string): string {
	const home = os.homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - timestamp;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	return date.toLocaleDateString();
}

function tryParseJsonString(value: string): unknown | null {
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

function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
	let changed = false;
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string") {
			const parsed = tryParseJsonString(value);
			if (parsed !== null) {
				normalized[key] = parsed;
				changed = true;
				continue;
			}
		}
		normalized[key] = value;
	}
	return changed ? normalized : args;
}

function formatArgsJson(args: Record<string, unknown>): string | null {
	if (Object.keys(args).length === 0) return null;
	const normalized = normalizeArgs(args);
	const json = JSON.stringify(normalized, null, 2);
	return json ?? null;
}

function formatArgsSummary(args: Record<string, unknown>): string {
	const formatted = formatArgsJson(args);
	if (!formatted) return "";
	return formatted.replace(/\s+/g, " ").substring(0, 40);
}

function getResultText(execution: ToolExecution): string {
	const texts = execution.resultContent
		.filter((c) => c.type === "text" && c.text)
		.map((c) => sanitizeBinaryOutput(stripAnsi(c.text!)).replace(/\r/g, ""));
	return texts.join("\n").trim();
}

function getSummary(execution: ToolExecution): string {
	const args = execution.args;

	switch (execution.toolName) {
		case "read": {
			const path = shorten(String(args.path ?? ""));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let range = "";
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit ? start + limit - 1 : "";
				range = `:${start}${end ? `-${end}` : ""}`;
			}
			return `${path}${range}`;
		}

		case "edit":
		case "write":
			return shorten(String(args.path ?? ""));

		case "bash":
			return String(args.command ?? "")
				.split("\n")[0]
				.substring(0, 50);

		case "ls":
			return shorten(String(args.path ?? "."));

		case "find":
		case "grep":
			return String(args.pattern ?? "");

		default:
			return formatArgsSummary(args);
	}
}

// ============ Header Component ============

class ToolHistoryHeader implements Component {
	private viewMode: ViewMode = "list";
	private count = 0;
	private selectedExecution: ToolExecution | null = null;

	setViewMode(mode: ViewMode): void {
		this.viewMode = mode;
	}

	setCount(count: number): void {
		this.count = count;
	}

	setSelectedExecution(execution: ToolExecution | null): void {
		this.selectedExecution = execution;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.viewMode === "detail" && this.selectedExecution) {
			const exec = this.selectedExecution;
			const icon = getIcon(exec.toolName);
			const status = exec.isError ? theme.fg("error", "✗ Error") : theme.fg("success", "✓ Success");
			const duration = theme.fg("muted", formatDuration(exec.durationMs));
			const time = theme.fg("muted", formatTime(exec.createdAt));

			const title = `${icon} ${theme.bold(exec.toolName)} ${status} ${duration} ${time}`;
			const hint = theme.fg(
				"muted",
				`${rawKeyHint("h", "back")} · ${rawKeyHint("j/k", "scroll")} · ${rawKeyHint("enter", "copy")}`,
			);

			const availableLeft = Math.max(0, width - visibleWidth(hint) - 1);
			const left = truncateToWidth(title, availableLeft, "…");
			const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(hint));

			return [left + " ".repeat(spacing) + hint, ""];
		}

		// List mode
		const title = theme.bold("Tool Execution History");
		const countText = theme.fg("muted", `(${this.count} executions)`);
		const hint = theme.fg("muted", `${rawKeyHint("enter", "view")} · ${rawKeyHint("esc", "close")}`);

		const leftText = `${title} ${countText}`;
		const availableLeft = Math.max(0, width - visibleWidth(hint) - 1);
		const left = truncateToWidth(leftText, availableLeft, "…");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(hint));

		return [left + " ".repeat(spacing) + hint, ""];
	}
}

// ============ List Component ============

/** Pre-computed searchable text for an execution */
interface SearchableExecution {
	execution: ToolExecution;
	searchText: string; // Pre-computed lowercased searchable text
}

class ToolHistoryList implements Component, Focusable {
	private executions: ToolExecution[] = [];
	private searchableExecutions: SearchableExecution[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private filteredExecutions: ToolExecution[] = [];
	private maxVisible = 8;

	onSelect?: (execution: ToolExecution) => void;
	onCancel?: () => void;

	// Focusable
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(executions: ToolExecution[]) {
		this.setExecutions(executions);
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			if (this.filteredExecutions[this.selectedIndex]) {
				this.onSelect?.(this.filteredExecutions[this.selectedIndex]);
			}
		};
	}

	setExecutions(executions: ToolExecution[]): void {
		this.executions = executions;
		// Pre-compute searchable text once on load
		this.searchableExecutions = executions.map((e) => ({
			execution: e,
			searchText: [e.toolName, getSummary(e), getResultText(e)].join(" ").toLowerCase(),
		}));
		this.filterExecutions(this.searchInput?.getValue() ?? "");
	}

	private filterExecutions(query: string): void {
		if (!query.trim()) {
			this.filteredExecutions = this.executions;
		} else {
			const q = query.toLowerCase();
			// Use pre-computed searchable text for O(n) filtering with minimal work per item
			this.filteredExecutions = this.searchableExecutions
				.filter((se) => se.searchText.includes(q))
				.map((se) => se.execution);
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredExecutions.length - 1));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Search input
		lines.push(...this.searchInput.render(width));
		lines.push("");

		if (this.filteredExecutions.length === 0) {
			lines.push(theme.fg("muted", "  No tool executions found"));
			return lines;
		}

		// Calculate visible range
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.filteredExecutions.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredExecutions.length);

		// Render visible executions
		for (let i = startIndex; i < endIndex; i++) {
			const exec = this.filteredExecutions[i];
			const isSelected = i === this.selectedIndex;

			const icon = getIcon(exec.toolName);
			const status = exec.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const summary = getSummary(exec);
			const duration = theme.fg("muted", formatDuration(exec.durationMs));
			const time = theme.fg("muted", formatTime(exec.createdAt));

			// First line: cursor + icon + tool name + summary
			const toolPart = isSelected ? theme.bold(exec.toolName) : exec.toolName;
			const summaryPart = summary ? theme.fg("accent", ` ${summary}`) : "";
			const mainLine = `${cursor}${icon} ${toolPart}${summaryPart}`;
			const truncatedMain = truncateToWidth(mainLine, width - 20, "…");
			const mainRight = ` ${status} ${duration} ${time}`;
			const mainWidth = visibleWidth(truncatedMain);
			const rightWidth = visibleWidth(mainRight);
			const padding = Math.max(0, width - mainWidth - rightWidth);
			lines.push(truncatedMain + " ".repeat(padding) + mainRight);

			// Second line: result preview (dimmed)
			const resultText = getResultText(exec);
			if (resultText) {
				const firstLine = resultText.split("\n")[0];
				const preview = truncateToWidth(`  ${firstLine}`, width, "…");
				lines.push(theme.fg("dim", preview));
			} else {
				lines.push(theme.fg("dim", "  (no output)"));
			}

			lines.push(""); // Blank between items
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.filteredExecutions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredExecutions.length})`;
			lines.push(theme.fg("muted", scrollText));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		// Navigation
		if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
			}
			return;
		}

		if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
			if (this.selectedIndex < this.filteredExecutions.length - 1) {
				this.selectedIndex++;
			}
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			this.selectedIndex = Math.min(this.filteredExecutions.length - 1, this.selectedIndex + this.maxVisible);
			return;
		}

		if (matchesKey(keyData, "home") || matchesKey(keyData, "ctrl+home")) {
			this.selectedIndex = 0;
			return;
		}

		if (matchesKey(keyData, "end") || matchesKey(keyData, "ctrl+end")) {
			this.selectedIndex = Math.max(0, this.filteredExecutions.length - 1);
			return;
		}

		// Select
		if (matchesKey(keyData, "enter")) {
			if (this.filteredExecutions[this.selectedIndex]) {
				this.onSelect?.(this.filteredExecutions[this.selectedIndex]);
			}
			return;
		}

		// Cancel
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
			this.onCancel?.();
			return;
		}

		// Pass to search input
		this.searchInput.handleInput(keyData);
		this.filterExecutions(this.searchInput.getValue());
	}
}

// ============ Detail View Component ============

/**
 * Enhanced detail view with:
 * - Scrollable content (#62)
 * - Text wrapping (#59)
 * - Markdown rendering (#60)
 * - Syntax highlighting (#61)
 */
class ToolHistoryDetail implements Component, Focusable {
	private execution: ToolExecution;
	private scrollOffset = 0;
	private viewportHeight = 20;

	// Render cache
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private markdownComponent: Markdown | null = null;

	onBack?: () => void;
	onCopy?: (text: string) => void;

	// Focusable
	focused = false;

	constructor(execution: ToolExecution) {
		this.execution = execution;
	}

	setMaxVisibleLines(lines: number): void {
		this.viewportHeight = Math.max(5, lines);
	}

	invalidate(): void {
		this.cachedLines = [];
		this.cachedWidth = 0;
		this.markdownComponent = null;
	}

	/**
	 * Detect language for syntax highlighting based on tool and args.
	 */
	private detectLanguage(): string | undefined {
		const exec = this.execution;
		const path = String(exec.args.path ?? "");

		switch (exec.toolName) {
			case "read":
			case "edit":
			case "write":
				return getLanguageFromPath(path);
			case "bash":
				return "bash";
			case "grep":
			case "find":
			case "ls":
				return undefined; // Plain text output
			default:
				return getLanguageFromPath(path);
		}
	}

	/**
	 * Check if content looks like markdown.
	 * Uses pre-compiled combined regex for performance.
	 */
	private isMarkdownContent(text: string): boolean {
		return MARKDOWN_PATTERN.test(text);
	}

	/**
	 * Render content with appropriate formatting.
	 */
	private renderContent(width: number): string[] {
		// Use cache if valid
		if (this.cachedWidth === width && this.cachedLines.length > 0) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const exec = this.execution;
		const contentWidth = Math.max(20, width - 4); // Leave margin

		const argsJson = formatArgsJson(exec.args);
		if (argsJson) {
			// ─── Arguments Section ───
			lines.push(theme.fg("accent", `┌─ Arguments ─${"─".repeat(Math.max(0, contentWidth - 13))}`));
			const highlightedArgs = highlightCode(argsJson, "json");
			for (const line of highlightedArgs) {
				const wrapped = wrapTextWithAnsi(`  ${line}`, contentWidth);
				lines.push(...wrapped);
			}
			lines.push("");
		}

		// ─── Output Section ───
		const resultText = getResultText(exec);
		const outputLabel = exec.isError ? "Error Output" : "Output";
		const lang = this.detectLanguage();
		const langLabel = lang ? ` (${lang})` : "";
		lines.push(
			theme.fg(
				exec.isError ? "error" : "accent",
				`┌─ ${outputLabel}${langLabel} ─` +
					"─".repeat(Math.max(0, contentWidth - outputLabel.length - langLabel.length - 5)),
			),
		);

		if (!resultText) {
			lines.push(theme.fg("muted", "  (no output)"));
		} else if (exec.isError) {
			// Error output: red, wrapped
			for (const line of resultText.split("\n")) {
				const wrapped = wrapTextWithAnsi(`  ${line}`, contentWidth);
				for (const w of wrapped) {
					lines.push(theme.fg("error", w));
				}
			}
		} else if (this.isMarkdownContent(resultText)) {
			// Markdown rendering
			if (!this.markdownComponent) {
				this.markdownComponent = new Markdown(resultText, 2, 0, getMarkdownTheme());
			}
			const mdLines = this.markdownComponent.render(contentWidth);
			lines.push(...mdLines);
		} else if (lang) {
			// Syntax highlighted code
			const highlighted = highlightCode(resultText, lang);
			for (const line of highlighted) {
				const wrapped = wrapTextWithAnsi(`  ${line}`, contentWidth);
				lines.push(...wrapped);
			}
		} else {
			// Plain text with wrapping
			for (const line of resultText.split("\n")) {
				const wrapped = wrapTextWithAnsi(`  ${line}`, contentWidth);
				lines.push(...wrapped);
			}
		}

		// Cache results
		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}

	/**
	 * Render scroll indicator bar.
	 */
	private renderScrollIndicator(width: number, totalLines: number): string {
		const viewable = Math.min(this.viewportHeight - 1, totalLines); // -1 for indicator line
		const scrollable = Math.max(0, totalLines - viewable);

		if (scrollable === 0) {
			return theme.fg("muted", "─".repeat(width));
		}

		const progress = scrollable > 0 ? this.scrollOffset / scrollable : 0;
		const percent = Math.round(progress * 100);

		// Build scroll bar
		const barWidth = Math.max(10, Math.min(30, width - 25));
		const thumbPos = Math.round(progress * (barWidth - 1));
		const bar = `${"░".repeat(thumbPos)}█${"░".repeat(Math.max(0, barWidth - thumbPos - 1))}`;

		const upArrow = this.scrollOffset > 0 ? "▲" : " ";
		const downArrow = this.scrollOffset < scrollable ? "▼" : " ";

		const lineInfo = `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewable, totalLines)}/${totalLines}`;
		const scrollText = ` ${upArrow} ${bar} ${downArrow}  ${lineInfo} (${percent}%)`;

		// Pad/truncate to width
		const padded = truncateToWidth(scrollText, width, "…");
		const padding = Math.max(0, width - visibleWidth(padded));

		return theme.fg("muted", padded + " ".repeat(padding));
	}

	render(width: number): string[] {
		const allLines = this.renderContent(width);
		const totalLines = allLines.length;

		// Calculate visible range
		const viewable = Math.min(this.viewportHeight - 1, totalLines); // Reserve 1 line for scroll indicator
		const maxScroll = Math.max(0, totalLines - viewable);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		// Slice visible portion
		const visibleLines = allLines.slice(this.scrollOffset, this.scrollOffset + viewable);

		// Pad to viewport height if needed
		while (visibleLines.length < viewable) {
			visibleLines.push("");
		}

		// Add scroll indicator
		visibleLines.push(this.renderScrollIndicator(width, totalLines));

		return visibleLines;
	}

	handleInput(keyData: string): void {
		const totalLines = this.cachedLines.length;
		const viewable = Math.min(this.viewportHeight - 1, totalLines);
		const maxScroll = Math.max(0, totalLines - viewable);

		// Single line scroll
		if (matchesKey(keyData, "up") || matchesKey(keyData, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}

		if (matchesKey(keyData, "down") || matchesKey(keyData, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			return;
		}

		// Page scroll
		if (matchesKey(keyData, "pageUp") || matchesKey(keyData, "ctrl+u")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewable);
			return;
		}

		if (matchesKey(keyData, "pageDown") || matchesKey(keyData, "ctrl+d")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewable);
			return;
		}

		// Half-page scroll (vim style)
		if (matchesKey(keyData, "ctrl+b")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - Math.floor(viewable / 2));
			return;
		}

		if (matchesKey(keyData, "ctrl+f")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + Math.floor(viewable / 2));
			return;
		}

		// Jump to top/bottom
		if (matchesKey(keyData, "home") || matchesKey(keyData, "g")) {
			this.scrollOffset = 0;
			return;
		}

		if (matchesKey(keyData, "end") || matchesKey(keyData, "shift+g")) {
			this.scrollOffset = maxScroll;
			return;
		}

		// Copy to clipboard
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "y")) {
			const resultText = getResultText(this.execution);
			const argsJson = formatArgsJson(this.execution.args);
			this.onCopy?.(resultText || argsJson || "");
			return;
		}

		// Back (h = vim-style left/back)
		if (
			matchesKey(keyData, "escape") ||
			matchesKey(keyData, "q") ||
			matchesKey(keyData, "h") ||
			matchesKey(keyData, "ctrl+c")
		) {
			this.onBack?.();
			return;
		}
	}
}

// ============ Main Selector Component ============

export class ToolHistorySelectorComponent extends Container implements Focusable {
	private header: ToolHistoryHeader;
	private list: ToolHistoryList;
	private detail: ToolHistoryDetail | null = null;
	private viewMode: ViewMode = "list";

	onCancel?: () => void;
	onCopy?: (text: string) => void;

	// Focusable
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.viewMode === "list") {
			this.list.focused = value;
		} else if (this.detail) {
			this.detail.focused = value;
		}
	}

	constructor(storage: ToolExecutionStorage) {
		super();

		// Load executions
		const executions = storage.listExecutions({ limit: 200 });
		const count = storage.getCount();

		// Create components
		this.header = new ToolHistoryHeader();
		this.header.setCount(count);

		this.list = new ToolHistoryList(executions);
		this.list.onSelect = (exec) => this.showDetail(exec);
		this.list.onCancel = () => this.onCancel?.();

		this.addChild(this.header);
		this.addChild(this.list);
	}

	private showDetail(execution: ToolExecution): void {
		this.viewMode = "detail";

		this.header.setViewMode("detail");
		this.header.setSelectedExecution(execution);

		// Remove list, add detail
		this.removeChild(this.list);

		this.detail = new ToolHistoryDetail(execution);
		this.detail.onBack = () => this.showList();
		this.detail.onCopy = (text) => this.onCopy?.(text);
		this.detail.focused = this._focused;

		this.addChild(this.detail);
	}

	private showList(): void {
		this.viewMode = "list";

		this.header.setViewMode("list");
		this.header.setSelectedExecution(null);

		// Remove detail, add list back
		if (this.detail) {
			this.removeChild(this.detail);
			this.detail = null;
		}

		this.addChild(this.list);
		this.list.focused = this._focused;
	}

	getFocusTarget(): Component {
		return this.viewMode === "list" ? this.list : (this.detail ?? this.list);
	}

	handleInput(keyData: string): void {
		if (this.viewMode === "list") {
			this.list.handleInput(keyData);
		} else if (this.detail) {
			this.detail.handleInput(keyData);
		}
	}
}
