import type { Component } from "../tui.js";
import { sliceByColumn, visibleWidth } from "../utils.js";

/**
 * Box-drawing characters for borders
 */
const BORDER = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
} as const;

export interface BorderedBoxOptions {
	/** Title to display in the top border */
	title?: string;
	/** Horizontal padding inside the border (default: 1) */
	paddingX?: number;
	/** Vertical padding inside the border (default: 0) */
	paddingY?: number;
	/** Function to colorize border characters */
	borderColor?: (str: string) => string;
	/** Function to colorize title text */
	titleColor?: (str: string) => string;
}

/**
 * BorderedBox component - wraps child content with a box border.
 *
 * ```
 * ┌─ Title ──────────────┐
 * │ Content here         │
 * │ More content         │
 * └──────────────────────┘
 * ```
 */
export class BorderedBox implements Component {
	private child: Component;
	private title?: string;
	private paddingX: number;
	private paddingY: number;
	private borderColor: (str: string) => string;
	private titleColor: (str: string) => string;

	// Cache
	private cachedWidth?: number;
	private cachedChildLines?: string[];
	private cachedLines?: string[];

	constructor(child: Component, options: BorderedBoxOptions = {}) {
		this.child = child;
		this.title = options.title;
		this.paddingX = options.paddingX ?? 1;
		this.paddingY = options.paddingY ?? 0;
		this.borderColor = options.borderColor ?? ((s) => s);
		this.titleColor = options.titleColor ?? ((s) => s);
	}

	setTitle(title: string | undefined): void {
		if (this.title !== title) {
			this.title = title;
			this.invalidate();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedChildLines = undefined;
		this.cachedLines = undefined;
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		// Minimum width: 2 (borders) + 2 (min content) = 4
		const effectiveWidth = Math.max(4, width);

		// Content width = total - 2 borders - 2*paddingX
		const contentWidth = Math.max(1, effectiveWidth - 2 - this.paddingX * 2);

		// Render child
		const childLines = this.child.render(contentWidth);

		// Check cache
		const childKey = childLines.join("\n");
		if (this.cachedLines && this.cachedWidth === effectiveWidth && this.cachedChildLines?.join("\n") === childKey) {
			return this.cachedLines;
		}

		const bc = this.borderColor;
		const tc = this.titleColor;
		const pad = " ".repeat(this.paddingX);
		const innerWidth = effectiveWidth - 2; // Width between vertical borders

		// Build top border with optional title
		let topBorder: string;
		if (this.title) {
			const titleText = ` ${this.title} `;
			const titleLen = visibleWidth(titleText);
			const availableForLine = innerWidth - titleLen - 1; // -1 for left corner space
			if (availableForLine > 0) {
				// ┌─ Title ─────────┐
				topBorder =
					bc(BORDER.topLeft + BORDER.horizontal) +
					tc(titleText) +
					bc(BORDER.horizontal.repeat(availableForLine) + BORDER.topRight);
			} else {
				// Title too long, just show border
				topBorder = bc(BORDER.topLeft + BORDER.horizontal.repeat(innerWidth) + BORDER.topRight);
			}
		} else {
			topBorder = bc(BORDER.topLeft + BORDER.horizontal.repeat(innerWidth) + BORDER.topRight);
		}

		// Build bottom border
		const bottomBorder = bc(BORDER.bottomLeft + BORDER.horizontal.repeat(innerWidth) + BORDER.bottomRight);

		// Build content lines with vertical borders
		const result: string[] = [topBorder];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(bc(BORDER.vertical) + " ".repeat(innerWidth) + bc(BORDER.vertical));
		}

		// Content lines
		for (const line of childLines) {
			const lineWidth = visibleWidth(line);
			const rightPad = Math.max(0, contentWidth - lineWidth);
			// Truncate if line somehow exceeds content width
			const safeLine = lineWidth > contentWidth ? sliceByColumn(line, 0, contentWidth, true) : line;
			result.push(bc(BORDER.vertical) + pad + safeLine + " ".repeat(rightPad) + pad + bc(BORDER.vertical));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(bc(BORDER.vertical) + " ".repeat(innerWidth) + bc(BORDER.vertical));
		}

		result.push(bottomBorder);

		// Update cache
		this.cachedWidth = effectiveWidth;
		this.cachedChildLines = childLines;
		this.cachedLines = result;

		return result;
	}
}
