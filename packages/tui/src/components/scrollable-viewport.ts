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

/**
 * ScrollableViewport manages a scrollable region of content.
 * It tracks scroll position and renders only the visible portion.
 */
export class ScrollableViewport implements Component {
	private items: Component[] = [];
	private scrollOffset = 0; // Lines from bottom (integer part of position)
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private cacheValid = false; // Track cache validity (handles empty content)
	private options: Required<ScrollableViewportOptions>;
	private contentHeight = 0;
	private prevContentHeight = 0; // Track for scroll offset stability
	private lastViewportHeight = 0; // Track last known viewport height

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
		this.items.push(component);
		this.invalidate();

		// Auto-scroll to bottom if enabled and currently at bottom
		if (this.options.autoScroll && this.scrollOffset === 0) {
			// Already at bottom, will render correctly
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
		this.prevContentHeight = 0;
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
		this.stopSmoothScroll(); // Cancel any momentum
		const oldOffset = this.scrollOffset;
		this.scrollOffset += lines;
		this.clampScrollOffset();
		this.fractionalOffset = this.scrollOffset; // Keep in sync

		if (this.scrollOffset !== oldOffset) {
			// No invalidate() - cache is still valid, only scroll offset changed
			this.onScroll?.(this.scrollOffset === 0);
		}
	}

	/**
	 * Scroll down by the specified number of lines (instant).
	 * Note: Does NOT invalidate cache - scrolling changes the visible slice,
	 * not the content. The cached lines remain valid.
	 */
	scrollDown(lines: number): void {
		this.stopSmoothScroll(); // Cancel any momentum
		const oldOffset = this.scrollOffset;
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		this.fractionalOffset = this.scrollOffset; // Keep in sync

		if (this.scrollOffset !== oldOffset) {
			// No invalidate() - cache is still valid, only scroll offset changed
			this.onScroll?.(this.scrollOffset === 0);
		}
	}

	/**
	 * Scroll to the top of the content (instant).
	 * Note: Does NOT invalidate cache - only scroll offset changes.
	 */
	scrollToTop(): void {
		this.stopSmoothScroll(); // Cancel any momentum
		const maxOffset = Math.max(0, this.contentHeight - 1);
		if (this.scrollOffset !== maxOffset) {
			this.scrollOffset = maxOffset;
			this.fractionalOffset = maxOffset; // Keep in sync
			// No invalidate() - cache is still valid
			this.onScroll?.(false);
		}
	}

	/**
	 * Scroll to the bottom of the content (instant).
	 * Note: Does NOT invalidate cache - only scroll offset changes.
	 */
	scrollToBottom(): void {
		this.stopSmoothScroll(); // Cancel any momentum
		if (this.scrollOffset !== 0) {
			this.scrollOffset = 0;
			this.fractionalOffset = 0; // Keep in sync
			// No invalidate() - cache is still valid
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
	 * @param impulse Initial velocity boost (lines per frame)
	 */
	smoothScrollUp(impulse: number): void {
		if (!this.options.smoothScroll) {
			this.scrollUp(Math.round(impulse));
			return;
		}
		// Add to existing velocity (allows accumulation from rapid inputs)
		this.velocity += impulse;
		this.startAnimation();
	}

	/**
	 * Smooth scroll down with momentum.
	 * Adds velocity instead of instant jump.
	 * @param impulse Initial velocity boost (lines per frame, positive value)
	 */
	smoothScrollDown(impulse: number): void {
		if (!this.options.smoothScroll) {
			this.scrollDown(Math.round(impulse));
			return;
		}
		// Subtract from velocity (negative = scroll down)
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

	/**
	 * Start the smooth scroll animation loop.
	 */
	private startAnimation(): void {
		if (this.animationTimer !== null) return; // Already running
		this.runAnimationFrame();
	}

	/**
	 * Run a single animation frame.
	 */
	private runAnimationFrame(): void {
		// Apply velocity to fractional position
		this.fractionalOffset += this.velocity;

		// Clamp fractional offset to valid range
		const maxOffset = Math.max(0, this.contentHeight - 1);
		this.fractionalOffset = Math.max(0, Math.min(this.fractionalOffset, maxOffset));

		// Check if integer scroll position changed
		const newIntOffset = Math.round(this.fractionalOffset);
		const offsetChanged = newIntOffset !== this.scrollOffset;

		if (offsetChanged) {
			this.scrollOffset = newIntOffset;
			this.invalidate();
			this.onScroll?.(this.scrollOffset === 0);
			this.onSmoothScrollUpdate?.();
		}

		// Apply decay (friction)
		this.velocity *= this.options.scrollDecay;

		// Stop if velocity is below threshold
		if (Math.abs(this.velocity) < this.options.scrollThreshold) {
			this.velocity = 0;
			this.animationTimer = null;
			// Snap fractional to integer
			this.fractionalOffset = this.scrollOffset;
			return;
		}

		// Schedule next frame
		this.animationTimer = setTimeout(() => this.runAnimationFrame(), ScrollableViewport.FRAME_INTERVAL);
	}

	/**
	 * Clamp scroll offset to valid range based on content height.
	 */
	private clampScrollOffset(): void {
		// Ensure scroll offset doesn't exceed content height
		const maxOffset = Math.max(0, this.contentHeight - 1);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
	}

	render(width: number, height?: number): string[] {
		// Use provided height, or last known height, or minimum fallback of 1
		// (FixedLayoutContainer always provides height, so fallback is defensive only)
		const viewportHeight = height ?? (this.lastViewportHeight || 1);
		if (height !== undefined) {
			this.lastViewportHeight = height;
		}

		// Check if we can use cached result (cacheValid handles empty content case)
		if (this.cacheValid && this.cachedWidth === width) {
			return this.sliceForViewport(viewportHeight);
		}

		// Render all items to get total content
		const allLines: string[] = [];
		for (const item of this.items) {
			const lines = item.render(width);
			allLines.push(...lines);
		}

		this.contentHeight = allLines.length;

		// Scroll offset stability: when user is scrolled up (scrollOffset > 0),
		// adjust offset by content height delta to "freeze" the visible region.
		// This prevents the viewport from drifting toward bottom when new content arrives.
		if (this.scrollOffset > 0 && this.prevContentHeight > 0) {
			const delta = this.contentHeight - this.prevContentHeight;
			if (delta > 0) {
				this.scrollOffset += delta;
			}
		}
		this.prevContentHeight = this.contentHeight;

		this.clampScrollOffset();

		this.cachedLines = allLines;
		this.cachedWidth = width;
		this.cacheValid = true;

		return this.sliceForViewport(viewportHeight);
	}

	/**
	 * Extract visible portion of content based on scroll offset.
	 */
	private sliceForViewport(viewportHeight: number): string[] {
		if (this.cachedLines.length === 0) {
			return Array(viewportHeight).fill("");
		}

		// Calculate visible range
		// scrollOffset is lines from bottom
		const endIndex = this.cachedLines.length - this.scrollOffset;
		const startIndex = Math.max(0, endIndex - viewportHeight);
		const actualEndIndex = Math.min(this.cachedLines.length, startIndex + viewportHeight);

		const visible = this.cachedLines.slice(startIndex, actualEndIndex);

		// Pad to fill viewport if needed
		const padding = viewportHeight - visible.length;
		if (padding > 0) {
			// Add empty lines at top (content is bottom-aligned when at bottom)
			return [...Array(padding).fill(""), ...visible];
		}

		return visible;
	}

	invalidate(): void {
		this.cachedLines = [];
		this.cachedWidth = 0;
		this.cacheValid = false;

		// Invalidate all child items
		for (const item of this.items) {
			item.invalidate?.();
		}
	}

	/**
	 * Invalidate only the viewport's line cache, not children.
	 * Use when a child's content changes but the child manages its own cache.
	 * More efficient than full invalidate() for streaming updates.
	 */
	invalidateCacheOnly(): void {
		this.cachedLines = [];
		this.cachedWidth = 0;
		this.cacheValid = false;
	}
}
