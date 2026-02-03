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
	 * Calculate the actual height based on editor content.
	 */
	private calculateHeight(width: number): number {
		const borderWidth = this.options.borderStyle === "none" ? 0 : 2;
		const paddingY = this.options.paddingY ?? 0;
		const paddingX = this.options.paddingX ?? 0;

		// Get editor's preferred height with clamped width
		const editorWidth = Math.max(1, width - borderWidth - paddingX * 2);
		const editorLines = this.editor.render(editorWidth);
		const contentHeight = editorLines.length;

		// Calculate total height with borders and padding
		const totalHeight = contentHeight + borderWidth + paddingY * 2;

		// Clamp to min/max
		return Math.max(this.options.minHeight ?? 3, Math.min(this.options.maxHeight ?? 8, totalHeight));
	}

	/**
	 * Get current height (cached if available).
	 */
	getHeight(width: number): number {
		if (this.cachedHeight === undefined) {
			this.cachedHeight = this.calculateHeight(width);
		}
		return this.cachedHeight;
	}

	handleInput(data: string): void {
		if (this.editor.handleInput) {
			this.editor.handleInput(data);
		}
	}

	render(width: number): string[] {
		const height = this.calculateHeight(width);
		this.cachedHeight = height;

		if (this.options.borderStyle === "none") {
			return this.renderWithoutBorders(width, height);
		}

		return this.renderWithBorders(width, height);
	}

	private renderWithBorders(width: number, height: number): string[] {
		const borderStyle = this.options.borderStyle ?? "single";
		if (borderStyle === "none") {
			return this.renderWithoutBorders(width, height);
		}
		const chars = BORDER_CHARS[borderStyle];
		// Clamp dimensions to prevent negative values on small terminals
		const contentWidth = Math.max(0, width - 2); // Subtract borders
		const contentHeight = Math.max(0, height - 2); // Subtract borders

		// Render editor content
		const paddingX = this.options.paddingX ?? 0;
		const editorWidth = Math.max(1, contentWidth - paddingX * 2);
		let editorLines = this.editor.render(editorWidth);

		// Truncate to fit
		editorLines = editorLines.slice(0, contentHeight);

		// Build lines
		const lines: string[] = [];

		// Top border
		lines.push(chars.topLeft + chars.horizontal.repeat(Math.max(0, contentWidth)) + chars.topRight);

		// Content lines with padding
		for (let i = 0; i < contentHeight; i++) {
			const content = editorLines[i] ?? "";
			const leftPad = " ".repeat(Math.max(0, paddingX));
			// Use visibleWidth for ANSI-safe padding calculation
			const rightPadSize = Math.max(0, contentWidth - paddingX - visibleWidth(content));
			const rightPad = " ".repeat(rightPadSize);
			lines.push(chars.vertical + leftPad + content + rightPad + chars.vertical);
		}

		// Bottom border
		lines.push(chars.bottomLeft + chars.horizontal.repeat(Math.max(0, contentWidth)) + chars.bottomRight);

		return lines;
	}

	private renderWithoutBorders(width: number, height: number): string[] {
		const paddingX = this.options.paddingX ?? 0;
		const editorWidth = Math.max(1, width - paddingX * 2);
		let editorLines = this.editor.render(editorWidth);

		// Truncate to fit
		editorLines = editorLines.slice(0, Math.max(0, height));

		// Pad if needed
		while (editorLines.length < height) {
			editorLines.push("");
		}

		return editorLines.map((line) => {
			const leftPad = " ".repeat(Math.max(0, paddingX));
			// Use visibleWidth for ANSI-safe padding calculation
			const rightPadSize = Math.max(0, width - paddingX - visibleWidth(line));
			const rightPad = " ".repeat(rightPadSize);
			return leftPad + line + rightPad;
		});
	}

	invalidate(): void {
		this.cachedHeight = undefined;
		this.editor.invalidate?.();
	}
}
