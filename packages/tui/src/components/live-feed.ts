import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";

/**
 * A single item in a LiveFeed.
 * Items are identified by `id` for in-place updates.
 * `text` is a pre-formatted ANSI string (can be multi-line).
 */
export interface LiveFeedItem {
	id: string;
	text: string;
}

/**
 * Options for configuring a LiveFeed instance.
 */
export interface LiveFeedOptions {
	/** Maximum number of visible lines in the sliding window. Default: 20 */
	maxLines?: number;
	/**
	 * Custom overflow indicator text.
	 * Called with the number of hidden lines when the feed is truncated.
	 * The returned string is truncated to width if necessary.
	 * Default: `"… {n} lines above"`
	 */
	overflowText?: (hiddenCount: number) => string;
}

/** Internal cached wrap result for a single item */
interface WrapCache {
	text: string;
	width: number;
	lines: string[];
}

/**
 * LiveFeed — A sliding-window display of ID-based items.
 *
 * Items appear in insertion order. When the total wrapped line count
 * exceeds `maxLines`, only the tail is shown with an overflow indicator.
 *
 * Theme-agnostic: all ANSI formatting must be applied by the consumer
 * before passing text to items.
 *
 * Usage:
 *   const feed = new LiveFeed({ maxLines: 15 });
 *   feed.addItem({ id: "t1", text: "◐ \x1b[33mread\x1b[39m src/foo.ts" });
 *   feed.updateItem("t1", "✓ \x1b[32mread\x1b[39m src/foo.ts  42 lines");
 *   const lines = feed.render(80);
 */
export class LiveFeed implements Component {
	private items: LiveFeedItem[] = [];
	private itemIndex = new Map<string, number>();
	private maxLines: number;
	private overflowText: (hiddenCount: number) => string;

	/** Per-item wrap cache keyed by item id */
	private wrapCache = new Map<string, WrapCache>();

	constructor(options?: LiveFeedOptions) {
		this.maxLines = options?.maxLines ?? 20;
		this.overflowText = options?.overflowText ?? ((n) => `\u2026 ${n} lines above`);
	}

	/**
	 * Add an item to the end of the feed.
	 * If an item with the same id already exists, its text is updated in place.
	 */
	addItem(item: LiveFeedItem): void {
		const existingIdx = this.itemIndex.get(item.id);
		if (existingIdx !== undefined) {
			this.items[existingIdx] = item;
		} else {
			this.itemIndex.set(item.id, this.items.length);
			this.items.push(item);
		}
		this.wrapCache.delete(item.id);
	}

	/**
	 * Update the text of an existing item by id.
	 * No-op if the item does not exist.
	 */
	updateItem(id: string, text: string): void {
		const idx = this.itemIndex.get(id);
		if (idx === undefined) return;
		this.items[idx] = { id, text };
		this.wrapCache.delete(id);
	}

	/**
	 * Remove an item by id. No-op if not found.
	 */
	removeItem(id: string): void {
		const idx = this.itemIndex.get(id);
		if (idx === undefined) return;
		this.items.splice(idx, 1);
		this.wrapCache.delete(id);
		this.rebuildIndex();
	}

	/**
	 * Replace all items at once. Clears existing items and caches.
	 */
	setItems(items: LiveFeedItem[]): void {
		this.items = [...items];
		this.wrapCache.clear();
		this.rebuildIndex();
	}

	/**
	 * Remove all items.
	 */
	clear(): void {
		this.items = [];
		this.itemIndex.clear();
		this.wrapCache.clear();
	}

	/**
	 * Get current item count.
	 */
	get length(): number {
		return this.items.length;
	}

	/**
	 * Invalidate all render caches (e.g. on theme change or resize).
	 */
	invalidate(): void {
		this.wrapCache.clear();
	}

	/**
	 * Render the feed as an array of lines within the given width.
	 *
	 * Algorithm:
	 * 1. Wrap each item's text to width (cached per item)
	 * 2. Flatten all wrapped lines in item order
	 * 3. If total > maxLines, show overflow indicator + tail window
	 */
	render(width: number): string[] {
		if (this.items.length === 0 || this.maxLines <= 0) return [];

		const w = Math.max(1, width);

		// Wrap each item and flatten
		const allLines: string[] = [];
		for (const item of this.items) {
			const wrapped = this.getWrapped(item, w);
			for (const line of wrapped) {
				allLines.push(line);
			}
		}

		if (allLines.length === 0) return [];

		// No overflow — return all lines
		if (allLines.length <= this.maxLines) {
			return allLines;
		}

		// Overflow — show indicator + tail
		const visibleCount = this.maxLines - 1;
		const hiddenCount = allLines.length - visibleCount;

		// Build overflow indicator, sanitize to single line, clamp to width
		const rawOverflow = this.overflowText(hiddenCount).replace(/\n/g, " ");
		const overflowLine = visibleWidth(rawOverflow) > w ? truncateToWidth(rawOverflow, w) : rawOverflow;

		return [overflowLine, ...allLines.slice(-visibleCount)];
	}

	// ─── Internals ──────────────────────────────────────────────────────

	private getWrapped(item: LiveFeedItem, width: number): string[] {
		const cached = this.wrapCache.get(item.id);
		if (cached && cached.text === item.text && cached.width === width) {
			return cached.lines;
		}

		const lines = wrapTextWithAnsi(item.text, width);
		this.wrapCache.set(item.id, { text: item.text, width, lines });
		return lines;
	}

	private rebuildIndex(): void {
		this.itemIndex.clear();
		for (let i = 0; i < this.items.length; i++) {
			this.itemIndex.set(this.items[i].id, i);
		}
	}
}
