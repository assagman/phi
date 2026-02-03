/**
 * Text selection support for TUI.
 * Handles mouse-based text selection with visual highlighting.
 */

import { extractAnsiCode, sliceByColumn, visibleWidth } from "./utils.js";

/** Position in terms of row and visible column */
export interface SelectionPosition {
	row: number;
	col: number;
}

/** Normalized selection range (start always before end) */
export interface SelectionRange {
	start: SelectionPosition;
	end: SelectionPosition;
}

/**
 * TextSelection manages mouse-based text selection state.
 */
export class TextSelection {
	/** Anchor position (where selection started) */
	private anchor: SelectionPosition | null = null;
	/** Current end position (follows mouse during drag) */
	private current: SelectionPosition | null = null;
	/** Whether selection is active (mouse down, dragging) */
	private selecting = false;

	/**
	 * Start a new selection at the given position.
	 */
	startSelection(row: number, col: number): void {
		this.anchor = { row, col };
		this.current = { row, col };
		this.selecting = true;
	}

	/**
	 * Update the selection end position during drag.
	 */
	updateSelection(row: number, col: number): void {
		if (!this.selecting) return;
		this.current = { row, col };
	}

	/**
	 * End the selection (mouse release).
	 * @returns The normalized range, or null if no selection
	 */
	endSelection(): SelectionRange | null {
		this.selecting = false;
		return this.getRange();
	}

	/**
	 * Clear the selection entirely.
	 */
	clear(): void {
		this.anchor = null;
		this.current = null;
		this.selecting = false;
	}

	/**
	 * Check if there is an active selection.
	 */
	hasSelection(): boolean {
		return this.anchor !== null && this.current !== null;
	}

	/**
	 * Check if selection is currently in progress (dragging).
	 */
	isSelecting(): boolean {
		return this.selecting;
	}

	/**
	 * Get the normalized selection range (start before end).
	 */
	getRange(): SelectionRange | null {
		if (!this.anchor || !this.current) return null;

		// Normalize: start should be before end
		const a = this.anchor;
		const c = this.current;

		if (a.row < c.row || (a.row === c.row && a.col <= c.col)) {
			return { start: a, end: c };
		}
		return { start: c, end: a };
	}

	/**
	 * Extract the plain text from selected region.
	 * @param lines - The rendered lines (with ANSI codes)
	 * @returns The selected text (stripped of ANSI)
	 */
	extractText(lines: string[]): string {
		const range = this.getRange();
		if (!range) return "";

		const { start, end } = range;
		const result: string[] = [];

		for (let row = start.row; row <= end.row && row < lines.length; row++) {
			const line = lines[row];
			if (!line) continue;

			const lineWidth = visibleWidth(line);

			// Determine column range for this row
			const startCol = row === start.row ? start.col : 0;
			const endCol = row === end.row ? end.col : lineWidth;

			if (startCol >= endCol) continue;

			// Extract the visible portion
			const slice = sliceByColumn(line, startCol, endCol - startCol);
			result.push(stripAnsi(slice));
		}

		return result.join("\n");
	}
}

/**
 * Strip all ANSI escape codes from a string.
 */
export function stripAnsi(str: string): string {
	let result = "";
	let i = 0;

	while (i < str.length) {
		const ansi = extractAnsiCode(str, i);
		if (ansi) {
			i += ansi.length;
		} else {
			result += str[i];
			i++;
		}
	}

	return result;
}

// ANSI codes for selection highlight (reverse video)
const SELECTION_START = "\x1b[7m"; // Reverse video on
const SELECTION_END = "\x1b[27m"; // Reverse video off

/**
 * Apply selection highlighting to rendered lines.
 * Returns new array of lines with reverse video applied to selected region.
 */
export function applySelectionHighlight(
	lines: string[],
	range: SelectionRange | null,
	viewportTop: number = 0,
): string[] {
	if (!range) return lines;

	const { start, end } = range;
	const result: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const screenRow = viewportTop + i;
		const line = lines[i];

		// Check if this row is within selection
		if (screenRow < start.row || screenRow > end.row) {
			result.push(line);
			continue;
		}

		// Determine selection columns for this row
		const lineWidth = visibleWidth(line);
		const selStart = screenRow === start.row ? start.col : 0;
		const selEnd = screenRow === end.row ? end.col : lineWidth;

		if (selStart >= selEnd || selStart >= lineWidth) {
			result.push(line);
			continue;
		}

		// Apply highlight
		result.push(highlightLineRange(line, selStart, Math.min(selEnd, lineWidth)));
	}

	return result;
}

/**
 * Apply reverse video to a range of columns in a line.
 * Handles ANSI codes properly.
 */
function highlightLineRange(line: string, startCol: number, endCol: number): string {
	if (startCol >= endCol) return line;

	const lineWidth = visibleWidth(line);
	if (startCol >= lineWidth) return line;

	// Extract three parts: before, selected, after
	const before = startCol > 0 ? sliceByColumn(line, 0, startCol) : "";
	const selected = sliceByColumn(line, startCol, endCol - startCol);
	const after = endCol < lineWidth ? sliceByColumn(line, endCol, lineWidth - endCol) : "";

	// Apply reverse video to selected portion
	return before + SELECTION_START + selected + SELECTION_END + after;
}
