/**
 * Pinned input bar component for standalone TUI mode.
 * Fixed-height input bar that stays at bottom of screen.
 */

import type { EditorComponent } from "../editor-component.js";
import type { Component, Focusable } from "../tui.js";
import { visibleWidth } from "../utils.js";

export interface PinnedInputBarOptions {
	/** Minimum height in rows (including borders) */
	minHeight?: number;
	/** Maximum height in rows (including borders) */
	maxHeight?: number;
	/** Border style: 'single', 'double', 'none' */
	borderStyle?: "single" | "double" | "none";
	/** Padding inside borders */
	paddingX?: number;
	paddingY?: number;
}

const BORDER_CHARS = {
	single: {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
	},
	double: {
		topLeft: "╔",
		topRight: "╗",
		bottomLeft: "╚",
		bottomRight: "╝",
		horizontal: "═",
		vertical: "║",
	},
};

/**
 * PinnedInputBar wraps an editor component with fixed-height borders.
 * The editor content is constrained to fit within the bar.
 */
export class PinnedInputBar implements Component, Focusable {
	focused = false;
	private editor: EditorComponent;
	private options: PinnedInputBarOptions;
	private cachedHeight?: number;

	/** Callback when user submits input */
	onSubmit?: (text: string) => void;

	/** Callback when escape is pressed */
	onCancel?: () => void;

	constructor(editor: EditorComponent, options: PinnedInputBarOptions = {}) {
		this.editor = editor;
		this.options = {
			minHeight: 3,
			maxHeight: 8,
			borderStyle: "single",
			paddingX: 1,
			paddingY: 0,
			...options,
		};

		// Set up editor callbacks
		const originalSubmit = this.editor.onSubmit;
		this.editor.onSubmit = (text: string) => {
			if (originalSubmit) {
				originalSubmit(text);
			}
			this.onSubmit?.(text);
		};
	}

	/**
	 * Get the editor component.
	 */
	getEditor(): EditorComponent {
		return this.editor;
	}

	/**
	 * Replace the editor component.
	 * Used by extensions to swap in custom editors.
	 */
	setEditor(editor: EditorComponent): void {
		this.editor = editor;
		this.cachedHeight = undefined;
	}

	/**
	 * Calculate the actual height based on pre-rendered editor lines.
	 */
	private calculateHeight(editorLines: string[], borderWidth: number): number {
		const paddingY = this.options.paddingY ?? 0;
		const contentHeight = editorLines.length;

		// Calculate total height with borders and padding
		const totalHeight = contentHeight + borderWidth + paddingY * 2;

		// Clamp to min/max
		return Math.max(this.options.minHeight ?? 3, Math.min(this.options.maxHeight ?? 8, totalHeight));
	}

	/**
	 * Get current height (cached if available).
	 * Note: For accurate height, call render() first which caches the result.
	 */
	getHeight(width: number): number {
		if (this.cachedHeight === undefined) {
			// Render to calculate and cache height
			this.render(width);
		}
		return this.cachedHeight!;
	}

	handleInput(data: string): void {
		if (this.editor.handleInput) {
			this.editor.handleInput(data);
		}
	}

	render(width: number): string[] {
		const borderWidth = this.options.borderStyle === "none" ? 0 : 2;
		const paddingX = this.options.paddingX ?? 0;

		// Tell the editor how many content lines are available so its internal
		// scroll logic produces exactly the right window.  The editor adds 2
		// border lines (top/bottom separator) to its output, so we subtract
		// those from the budget that PinnedInputBar allows.
		const editorWidth = Math.max(1, width - borderWidth - paddingX * 2);
		const maxHeight = this.options.maxHeight ?? 8;
		const editorBorderCost = 2; // editor's own top + bottom separator lines
		const contentBudget = Math.max(1, maxHeight - borderWidth - editorBorderCost);
		this.editor.maxContentLines = contentBudget;

		// Render editor once and reuse for both height calculation and content
		const editorLines = this.editor.render(editorWidth);

		const height = this.calculateHeight(editorLines, borderWidth);
		this.cachedHeight = height;

		if (this.options.borderStyle === "none") {
			return this.renderWithoutBorders(width, height, editorLines);
		}

		return this.renderWithBorders(width, height, editorLines);
	}

	private renderWithBorders(width: number, height: number, editorLines: string[]): string[] {
		const borderStyle = this.options.borderStyle ?? "single";
		if (borderStyle === "none") {
			return this.renderWithoutBorders(width, height, editorLines);
		}
		const chars = BORDER_CHARS[borderStyle];
		// Clamp dimensions to prevent negative values on small terminals
		const contentWidth = Math.max(0, width - 2); // Subtract borders
		const contentHeight = Math.max(0, height - 2); // Subtract borders

		const paddingX = this.options.paddingX ?? 0;

		// Truncate pre-rendered editor lines to fit — take from the END so the
		// cursor area (which the editor scrolls to the bottom) stays visible
		const truncatedLines =
			editorLines.length > contentHeight
				? editorLines.slice(editorLines.length - contentHeight)
				: editorLines.slice(0, contentHeight);

		// Get border color function from editor (if available)
		const colorize = this.editor.borderColor ?? ((s: string) => s);

		// Pre-colorize border characters once to reduce ANSI state changes
		const coloredVertical = colorize(chars.vertical);

		// Build lines
		const lines: string[] = [];

		// Top border (single colorize call for entire line)
		const topBorder = chars.topLeft + chars.horizontal.repeat(Math.max(0, contentWidth)) + chars.topRight;
		lines.push(colorize(topBorder));

		// Content lines with padding
		for (let i = 0; i < contentHeight; i++) {
			const content = truncatedLines[i] ?? "";
			const leftPad = " ".repeat(Math.max(0, paddingX));
			// Use visibleWidth for ANSI-safe padding calculation
			const rightPadSize = Math.max(0, contentWidth - paddingX - visibleWidth(content));
			const rightPad = " ".repeat(rightPadSize);
			// Use pre-colorized vertical bars
			lines.push(coloredVertical + leftPad + content + rightPad + coloredVertical);
		}

		// Bottom border (single colorize call for entire line)
		const bottomBorder = chars.bottomLeft + chars.horizontal.repeat(Math.max(0, contentWidth)) + chars.bottomRight;
		lines.push(colorize(bottomBorder));

		return lines;
	}

	private renderWithoutBorders(width: number, height: number, editorLines: string[]): string[] {
		const paddingX = this.options.paddingX ?? 0;

		// Truncate pre-rendered editor lines to fit — take from the END so the
		// cursor area (which the editor scrolls to the bottom) stays visible
		const maxLines = Math.max(0, height);
		const truncatedLines =
			editorLines.length > maxLines
				? editorLines.slice(editorLines.length - maxLines)
				: editorLines.slice(0, maxLines);

		// Pad if needed
		while (truncatedLines.length < height) {
			truncatedLines.push("");
		}

		// Get background color from editor (if available)
		const bgColor = this.editor.backgroundColor;
		const bgStart = bgColor ? `\x1b[48;2;${bgColor[0]};${bgColor[1]};${bgColor[2]}m` : "";
		const bgEnd = bgColor ? "\x1b[49m" : "";

		return truncatedLines.map((line) => {
			const leftPad = " ".repeat(Math.max(0, paddingX));
			// Use visibleWidth for ANSI-safe padding calculation
			const rightPadSize = Math.max(0, width - paddingX - visibleWidth(line));
			const rightPad = " ".repeat(rightPadSize);
			if (bgColor) {
				// Apply background only to the editor content (box area), not outer padding
				return leftPad + bgStart + line + bgEnd + rightPad;
			}
			return leftPad + line + rightPad;
		});
	}

	invalidate(): void {
		this.cachedHeight = undefined;
		this.editor.invalidate?.();
	}
}
