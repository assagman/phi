/**
 * Fixed layout container for standalone TUI mode.
 * Manages screen regions: header, scrollable chat, status area, pinned input, footer.
 */

import type { Terminal } from "../terminal.js";
import type { Component } from "../tui.js";
import type { ScrollableViewport } from "./scrollable-viewport.js";

export interface FixedLayoutOptions {
	/** Height of header in rows (0 to hide) */
	headerHeight?: number;
	/** Height of footer in rows */
	footerHeight: number;
	/** Minimum height for input bar */
	minInputHeight?: number;
	/** Maximum height for input bar */
	maxInputHeight?: number;
	/** Minimum height for status area (prevents chat from jumping when status appears/disappears) */
	minStatusHeight?: number;
	/** Maximum height for status area (caps dynamic content) */
	statusAreaMaxHeight?: number;
}

/**
 * FixedLayoutContainer manages a screen layout with fixed regions:
 * - Header (optional, fixed height at top)
 * - Chat viewport (flexible, scrollable, fills remaining space)
 * - Status area (dynamic height, between chat and input — loading indicators, pending messages)
 * - Input bar (fixed height at bottom, above footer)
 * - Footer (fixed height at very bottom)
 *
 * Total output always equals terminal.rows lines exactly.
 */
export class FixedLayoutContainer implements Component {
	private terminal: Terminal;
	private header: Component | null = null;
	private chatViewport: ScrollableViewport | null = null;
	private statusArea: Component | null = null;
	private inputBar: Component | null = null;
	private footer: Component | null = null;
	private options: Required<FixedLayoutOptions>;

	constructor(terminal: Terminal, options: FixedLayoutOptions) {
		this.terminal = terminal;
		this.options = {
			headerHeight: options.headerHeight ?? 0,
			footerHeight: options.footerHeight,
			minInputHeight: options.minInputHeight ?? 3,
			maxInputHeight: options.maxInputHeight ?? 10,
			minStatusHeight: options.minStatusHeight ?? 1,
			statusAreaMaxHeight: options.statusAreaMaxHeight ?? 8,
		};
	}

	setHeader(component: Component | null): void {
		this.header = component;
	}

	setChatViewport(viewport: ScrollableViewport | null): void {
		this.chatViewport = viewport;
	}

	setStatusArea(component: Component | null): void {
		this.statusArea = component;
	}

	setInputBar(component: Component | null): void {
		this.inputBar = component;
	}

	setFooter(component: Component | null): void {
		this.footer = component;
	}

	setOptions(options: Partial<FixedLayoutOptions>): void {
		this.options = { ...this.options, ...options };
	}

	render(width: number): string[] {
		const totalHeight = this.terminal.rows;

		// 1. Render fixed-size sections to determine their actual heights
		const headerLines = this.header ? this.header.render(width) : [];
		const statusLines = this.statusArea ? this.statusArea.render(width) : [];
		const inputLines = this.inputBar ? this.inputBar.render(width) : [];
		const footerLines = this.footer ? this.footer.render(width) : [];

		// 2. Priority-based height budgeting to ensure input/footer are never cut off
		// Priority: footer > input (min) > header > status > chat (flex)
		let remaining = totalHeight;

		// P1: Footer (required for UI feedback)
		const footerHeight = this.footer ? Math.min(footerLines.length, this.options.footerHeight, remaining) : 0;
		remaining -= footerHeight;

		// P2: Input bar minimum (required for typing)
		const inputMin = this.inputBar ? Math.min(this.options.minInputHeight, remaining) : 0;
		remaining -= inputMin;

		// P3: Header (nice to have) - use headerHeight directly, 0 means hidden
		const headerMax = this.header ? this.options.headerHeight : 0;
		const headerHeight = Math.min(headerLines.length, headerMax, remaining);
		remaining -= headerHeight;

		// P4: Status area - reserve minimum height to prevent chat viewport jumping
		const statusHeight = Math.min(
			Math.max(statusLines.length, this.options.minStatusHeight),
			this.options.statusAreaMaxHeight,
			remaining,
		);
		remaining -= statusHeight;

		// P5: Input bar can grow beyond minimum if space allows
		const inputExtra = this.inputBar
			? Math.min(this.options.maxInputHeight - inputMin, Math.max(0, inputLines.length - inputMin), remaining)
			: 0;
		remaining -= inputExtra;
		const inputHeight = inputMin + inputExtra;

		// P6: Chat viewport gets remaining space (can be 0 on tiny terminals)
		const chatHeight = Math.max(0, remaining);

		// 3. Render chat viewport with calculated height
		const chatLines = this.chatViewport ? this.chatViewport.render(width, chatHeight) : [];

		// 4. Assemble final output — each section contributes exactly its target height
		const lines: string[] = [];

		pushLines(lines, headerLines, headerHeight);
		pushLines(lines, chatLines, chatHeight);
		pushLines(lines, statusLines, statusHeight);
		pushLines(lines, inputLines, inputHeight);
		pushLines(lines, footerLines, footerHeight);

		// Ensure output is exactly totalHeight lines (defensive)
		while (lines.length < totalHeight) {
			lines.push("");
		}
		if (lines.length > totalHeight) {
			lines.length = totalHeight;
		}

		return lines;
	}

	invalidate(): void {
		this.header?.invalidate?.();
		this.chatViewport?.invalidate?.();
		this.statusArea?.invalidate?.();
		this.inputBar?.invalidate?.();
		this.footer?.invalidate?.();
	}
}

/**
 * Push exactly `targetHeight` lines from source into output.
 * Truncates if source has more, pads with empty lines if source has fewer.
 */
function pushLines(output: string[], source: string[], targetHeight: number): void {
	if (targetHeight <= 0) return;
	const sliced = source.slice(0, targetHeight);
	output.push(...sliced);
	for (let i = sliced.length; i < targetHeight; i++) {
		output.push("");
	}
}
