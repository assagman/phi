/**
 * Scrollable viewport component for chat/message display.
 * Manages scroll offset and renders only visible content.
 */

import type { Component } from "../tui.js";

export interface ScrollableViewportOptions {
	/** Whether to auto-scroll to bottom when new content is added */
	autoScroll?: boolean;
	/** Scroll offset from bottom (0 = at bottom) */
	initialScrollOffset?: number;
	/** Enable smooth/momentum scrolling (default: true) */
	smoothScroll?: boolean;
	/** Velocity decay factor per frame (0-1, lower = more friction, default: 0.88) */
	scrollDecay?: number;
	/** Minimum velocity threshold to stop animation (default: 0.3) */
	scrollThreshold?: number;
}

interface ItemRenderCache {
	component: Component;
	lines: string[];
	height: number;
	start: number;
	dirty: boolean;
}

/**
 * ScrollableViewport manages a scrollable region of content.
 * It tracks scroll position and renders only the visible portion.
 */
export class ScrollableViewport implements Component {
	private items: Component[] = [];

	/** Lines from bottom (integer part of position) */
	private scrollOffset = 0;

	/** Last width used for item render caching */
	private cachedWidth = 0;

	/** Total number of content lines across all items */
	private contentHeight = 0;
	private lastViewportHeight = 0; // Track last known viewport height

	/** Per-item render cache (enables independent component rendering) */
	private itemCache: ItemRenderCache[] = [];
	private layoutDirty = true;

	private options: Required<ScrollableViewportOptions>;

	// Smooth scroll state
	private velocity = 0; // Lines per frame (positive = scroll up, negative = scroll down)
	private fractionalOffset = 0; // Sub-line scroll position for smooth animation
	private animationTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly FRAME_INTERVAL = 16; // ~60fps

	onScroll?: (atBottom: boolean) => void;
	/** Called when smooth scroll animation updates (for triggering re-render) */
	onSmoothScrollUpdate?: () => void;

	constructor(options: ScrollableViewportOptions = {}) {
		this.options = {
			autoScroll: true,
			initialScrollOffset: 0,
			smoothScroll: true,
			scrollDecay: 0.88,
			scrollThreshold: 0.3,
			...options,
		};
		this.scrollOffset = this.options.initialScrollOffset;
		this.fractionalOffset = this.scrollOffset;
	}

	/**
	 * Add a message component to the viewport.
	 */
	addItem(component: Component): void {
		const cacheAlignedBeforeAppend = this.isItemCacheAlignedWithItems();
		const appendStart = this.contentHeight;

		this.items.push(component);

		if (cacheAlignedBeforeAppend) {
			this.itemCache.push({
				component,
				lines: [],
				height: 0,
				start: appendStart,
				dirty: true,
			});
			this.layoutDirty = true;
		}

		// Notify about scroll state
		this.onScroll?.(this.scrollOffset === 0);
	}

	/**
	 * Remove all items from the viewport.
	 */
	clear(): void {
		this.items = [];
		this.scrollOffset = 0;
		this.fractionalOffset = 0;
		this.stopSmoothScroll();
		this.invalidate();
	}

	/**
	 * Remove a specific item from the viewport.
	 */
	removeItem(component: Component): void {
		const index = this.items.indexOf(component);
		if (index !== -1) {
			this.items.splice(index, 1);
			this.invalidate();
		}
	}

	/**
	 * Get the number of items.
	 */
	getItemCount(): number {
		return this.items.length;
	}

	/**
	 * Get all items (for external processing).
	 */
	getItems(): readonly Component[] {
		return this.items;
	}

	/**
	 * Scroll up by the specified number of lines (instant).
	 * Note: Does NOT invalidate cache - scrolling changes the visible slice,
	 * not the content. The cached lines remain valid.
	 */
	scrollUp(lines: number): void {
		this.stopSmoothScroll();
		const oldOffset = this.scrollOffset;
		this.scrollOffset += lines;
		this.clampScrollOffset();
		this.fractionalOffset = this.scrollOffset;

		if (this.scrollOffset !== oldOffset) {
			this.onScroll?.(this.scrollOffset === 0);
		}
	}

	/**
	 * Scroll down by the specified number of lines (instant).
	 * Note: Does NOT invalidate cache - scrolling changes the visible slice,
	 * not the content. The cached lines remain valid.
	 */
	scrollDown(lines: number): void {
		this.stopSmoothScroll();
		const oldOffset = this.scrollOffset;
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		this.fractionalOffset = this.scrollOffset;

		if (this.scrollOffset !== oldOffset) {
			this.onScroll?.(this.scrollOffset === 0);
		}
	}

	/**
	 * Scroll to the top of the content (instant).
	 * Note: Does NOT invalidate cache - only scroll offset changes.
	 */
	scrollToTop(): void {
		this.stopSmoothScroll();
		const maxOffset = Math.max(0, this.contentHeight - 1);
		if (this.scrollOffset !== maxOffset) {
			this.scrollOffset = maxOffset;
			this.fractionalOffset = maxOffset;
			this.onScroll?.(false);
		}
	}

	/**
	 * Scroll to the bottom of the content (instant).
	 * Note: Does NOT invalidate cache - only scroll offset changes.
	 */
	scrollToBottom(): void {
		this.stopSmoothScroll();
		if (this.scrollOffset !== 0) {
			this.scrollOffset = 0;
			this.fractionalOffset = 0;
			this.onScroll?.(true);
		}
	}

	/**
	 * Get current scroll offset from bottom.
	 */
	getScrollOffset(): number {
		return this.scrollOffset;
	}

	/**
	 * Check if viewport is scrolled to bottom.
	 */
	isAtBottom(): boolean {
		return this.scrollOffset === 0;
	}

	/**
	 * Check if smooth scroll animation is currently running.
	 */
	isAnimating(): boolean {
		return this.animationTimer !== null;
	}

	/**
	 * Smooth scroll up with momentum.
	 * Adds velocity instead of instant jump.
	 */
	smoothScrollUp(impulse: number): void {
		if (!this.options.smoothScroll) {
			this.scrollUp(Math.round(impulse));
			return;
		}
		this.velocity += impulse;
		this.startAnimation();
	}

	/**
	 * Smooth scroll down with momentum.
	 * Adds velocity instead of instant jump.
	 */
	smoothScrollDown(impulse: number): void {
		if (!this.options.smoothScroll) {
			this.scrollDown(Math.round(impulse));
			return;
		}
		this.velocity -= impulse;
		this.startAnimation();
	}

	/**
	 * Stop any ongoing smooth scroll animation.
	 */
	stopSmoothScroll(): void {
		if (this.animationTimer !== null) {
			clearTimeout(this.animationTimer);
			this.animationTimer = null;
		}
		this.velocity = 0;
	}

	private startAnimation(): void {
		if (this.animationTimer !== null) return;
		this.runAnimationFrame();
	}

	private runAnimationFrame(): void {
		this.fractionalOffset += this.velocity;

		const maxOffset = Math.max(0, this.contentHeight - 1);
		this.fractionalOffset = Math.max(0, Math.min(this.fractionalOffset, maxOffset));

		const newIntOffset = Math.round(this.fractionalOffset);
		const offsetChanged = newIntOffset !== this.scrollOffset;

		if (offsetChanged) {
			this.scrollOffset = newIntOffset;
			this.onScroll?.(this.scrollOffset === 0);
			this.onSmoothScrollUpdate?.();
		}

		this.velocity *= this.options.scrollDecay;

		if (Math.abs(this.velocity) < this.options.scrollThreshold) {
			this.velocity = 0;
			this.animationTimer = null;
			this.fractionalOffset = this.scrollOffset;
			return;
		}

		this.animationTimer = setTimeout(() => this.runAnimationFrame(), ScrollableViewport.FRAME_INTERVAL);
	}

	/**
	 * Clamp scroll offset to valid range based on content height.
	 */
	private clampScrollOffset(): void {
		const maxOffset = Math.max(0, this.contentHeight - 1);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
	}

	/**
	 * Mark a specific item's render cache as dirty.
	 * This enables independent rendering updates without invalidating other items.
	 */
	invalidateItemCache(component: Component): void {
		this.ensureItemCacheAligned();
		const entry = this.itemCache.find((e) => e.component === component);
		if (entry) {
			entry.dirty = true;
			this.layoutDirty = true;
		}
	}

	render(width: number, height?: number): string[] {
		const viewportHeight = height ?? (this.lastViewportHeight || 1);
		if (height !== undefined) {
			this.lastViewportHeight = height;
		}

		this.ensureItemCacheAligned();

		// Width changed → invalidate all item render caches.
		if (this.cachedWidth !== width) {
			this.cachedWidth = width;
			for (const entry of this.itemCache) {
				entry.dirty = true;
			}
			this.layoutDirty = true;
		}

		const prevHeight = this.contentHeight;
		this.renderDirtyItems(width);
		this.recomputeLayout();

		// Scroll offset stability: when user is scrolled up (scrollOffset > 0),
		// adjust offset by content height delta to "freeze" the visible region.
		if (this.scrollOffset > 0 && prevHeight > 0) {
			const delta = this.contentHeight - prevHeight;
			if (delta > 0) {
				this.scrollOffset += delta;
			}
		}

		this.clampScrollOffset();

		return this.sliceForViewport(viewportHeight);
	}

	private isItemCacheAlignedWithItems(): boolean {
		if (this.itemCache.length !== this.items.length) {
			return false;
		}

		for (let i = 0; i < this.items.length; i++) {
			if (this.itemCache[i]?.component !== this.items[i]) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Ensure cache array matches items array.
	 */
	private ensureItemCacheAligned(): void {
		if (this.isItemCacheAlignedWithItems()) return;

		this.itemCache = this.items.map((component) => ({
			component,
			lines: [],
			height: 0,
			start: 0,
			dirty: true,
		}));
		this.layoutDirty = true;
	}

	/**
	 * Render only dirty items.
	 */
	private renderDirtyItems(width: number): void {
		for (const entry of this.itemCache) {
			if (!entry.dirty) continue;
			entry.lines = entry.component.render(width);
			entry.height = entry.lines.length;
			entry.dirty = false;
			this.layoutDirty = true;
		}
	}

	/**
	 * Recompute per-item start offsets and total content height.
	 */
	private recomputeLayout(): void {
		if (!this.layoutDirty) return;

		let start = 0;
		for (const entry of this.itemCache) {
			entry.start = start;
			start += entry.height;
		}

		this.contentHeight = start;
		this.layoutDirty = false;
	}

	/**
	 * Extract visible portion of content based on scroll offset.
	 */
	private sliceForViewport(viewportHeight: number): string[] {
		if (this.contentHeight === 0) {
			return Array(viewportHeight).fill("");
		}

		const endLine = this.contentHeight - this.scrollOffset;
		const startLine = Math.max(0, endLine - viewportHeight);
		const actualEndLine = Math.min(this.contentHeight, startLine + viewportHeight);

		const visible: string[] = [];

		let globalLine = startLine;
		let idx = this.findItemIndexForLine(globalLine);

		while (idx < this.itemCache.length && globalLine < actualEndLine) {
			const entry = this.itemCache[idx];
			const entryStart = entry.start;
			const entryEnd = entry.start + entry.height;

			if (entry.height === 0) {
				idx++;
				continue;
			}

			const localStart = Math.max(0, globalLine - entryStart);
			const localEnd = Math.min(entry.height, actualEndLine - entryStart);

			visible.push(...entry.lines.slice(localStart, localEnd));
			globalLine = Math.min(entryEnd, entryStart + localEnd);
			idx++;
		}

		const padding = viewportHeight - visible.length;
		if (padding > 0) {
			return [...Array(padding).fill(""), ...visible];
		}

		return visible;
	}

	/**
	 * Find the item index containing the given global line.
	 */
	private findItemIndexForLine(globalLine: number): number {
		if (this.itemCache.length === 0) return 0;
		if (globalLine <= 0) return 0;
		if (globalLine >= this.contentHeight) return this.itemCache.length;

		let low = 0;
		let high = this.itemCache.length - 1;

		while (low <= high) {
			const mid = (low + high) >> 1;
			const entry = this.itemCache[mid];
			const start = entry.start;
			const end = entry.start + entry.height;

			if (globalLine < start) {
				high = mid - 1;
			} else if (globalLine >= end) {
				low = mid + 1;
			} else {
				return mid;
			}
		}

		return Math.min(low, this.itemCache.length);
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.contentHeight = 0;

		this.itemCache = [];
		this.layoutDirty = true;

		for (const item of this.items) {
			item.invalidate?.();
		}
	}

	/**
	 * Invalidate only the viewport's cache, not children.
	 * Use when a child's content changes but the child manages its own cache.
	 */
	invalidateCacheOnly(): void {
		this.ensureItemCacheAligned();
		for (const entry of this.itemCache) {
			entry.dirty = true;
		}
		this.layoutDirty = true;
	}
}
