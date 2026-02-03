import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ScrollableViewport } from "../src/components/scrollable-viewport.js";
import type { Component } from "../src/tui.js";

// Simple test component that renders N lines
function createTestComponent(lineCount: number): Component {
	return {
		render: (width: number) => Array.from({ length: lineCount }, (_, i) => `line-${i}`.padEnd(width)),
		invalidate: () => {},
	};
}

// Test component that tracks render calls
function createTrackingComponent(lineCount: number): Component & { renderCount: number } {
	const component = {
		renderCount: 0,
		render: (width: number) => {
			component.renderCount++;
			return Array.from({ length: lineCount }, (_, i) => `line-${i}`.padEnd(width));
		},
		invalidate: () => {},
	};
	return component;
}

describe("ScrollableViewport", () => {
	describe("basic scrolling", () => {
		it("should scroll up and down", () => {
			const viewport = new ScrollableViewport({ smoothScroll: false });
			viewport.addItem(createTestComponent(20));

			// Render to set content height
			viewport.render(80, 10);

			assert.strictEqual(viewport.isAtBottom(), true);
			assert.strictEqual(viewport.getScrollOffset(), 0);

			viewport.scrollUp(5);
			assert.strictEqual(viewport.getScrollOffset(), 5);
			assert.strictEqual(viewport.isAtBottom(), false);

			viewport.scrollDown(3);
			assert.strictEqual(viewport.getScrollOffset(), 2);

			viewport.scrollToBottom();
			assert.strictEqual(viewport.getScrollOffset(), 0);
			assert.strictEqual(viewport.isAtBottom(), true);
		});

		it("should scroll to top", () => {
			const viewport = new ScrollableViewport({ smoothScroll: false });
			viewport.addItem(createTestComponent(20));
			viewport.render(80, 10);

			viewport.scrollToTop();
			// Max offset is contentHeight - 1 = 19
			assert.strictEqual(viewport.getScrollOffset(), 19);
		});

		it("should clamp scroll offset", () => {
			const viewport = new ScrollableViewport({ smoothScroll: false });
			viewport.addItem(createTestComponent(10));
			viewport.render(80, 10);

			viewport.scrollUp(100);
			// Should be clamped to max (9)
			assert.strictEqual(viewport.getScrollOffset(), 9);
		});

		it("should preserve cache on scroll (no re-render)", () => {
			const viewport = new ScrollableViewport({ smoothScroll: false });
			const item = createTrackingComponent(20);
			viewport.addItem(item);

			// First render builds cache
			viewport.render(80, 10);
			assert.strictEqual(item.renderCount, 1, "Should render once to build cache");

			// Scroll operations should NOT trigger re-render
			viewport.scrollUp(5);
			viewport.render(80, 10);
			assert.strictEqual(item.renderCount, 1, "Scroll should not invalidate cache");

			viewport.scrollDown(2);
			viewport.render(80, 10);
			assert.strictEqual(item.renderCount, 1, "ScrollDown should not invalidate cache");

			viewport.scrollToTop();
			viewport.render(80, 10);
			assert.strictEqual(item.renderCount, 1, "ScrollToTop should not invalidate cache");

			viewport.scrollToBottom();
			viewport.render(80, 10);
			assert.strictEqual(item.renderCount, 1, "ScrollToBottom should not invalidate cache");
		});

		it("should return different slices for different scroll offsets", () => {
			const viewport = new ScrollableViewport({ smoothScroll: false });
			viewport.addItem(createTestComponent(20));

			// Render at bottom
			const atBottom = viewport.render(80, 5);
			assert.ok(atBottom[4].startsWith("line-19"), `Expected line-19, got ${atBottom[4]}`);

			// Scroll up and render - should return different slice
			viewport.scrollUp(10);
			const scrolledUp = viewport.render(80, 5);
			assert.ok(scrolledUp[4].startsWith("line-9"), `Expected line-9, got ${scrolledUp[4]}`);
		});
	});

	describe("smooth scrolling", () => {
		let originalSetTimeout: typeof setTimeout;
		let timeoutCallbacks: Array<{ callback: () => void; delay: number }> = [];

		beforeEach(() => {
			// Simple fake timers - collect callbacks
			timeoutCallbacks = [];
			originalSetTimeout = globalThis.setTimeout;
			// @ts-expect-error - mock setTimeout
			globalThis.setTimeout = (callback: () => void, delay: number) => {
				const id = timeoutCallbacks.length + 1;
				timeoutCallbacks.push({ callback, delay });
				return id;
			};
		});

		afterEach(() => {
			globalThis.setTimeout = originalSetTimeout;
			timeoutCallbacks = [];
		});

		// Run pending timeouts
		function advanceTimers(_ms: number): void {
			// Run all pending timeouts (simplified - runs all regardless of delay)
			const pending = [...timeoutCallbacks];
			timeoutCallbacks = [];
			for (const { callback } of pending) {
				callback();
			}
		}

		it("should animate scroll with momentum", () => {
			const viewport = new ScrollableViewport({ smoothScroll: true, scrollDecay: 0.88, scrollThreshold: 0.3 });
			viewport.addItem(createTestComponent(50));
			viewport.render(80, 10);

			let scrollCallCount = 0;
			viewport.onScroll = () => scrollCallCount++;

			// Start smooth scroll
			viewport.smoothScrollUp(2.5);

			assert.strictEqual(viewport.isAnimating(), true);

			// Run several animation frames
			advanceTimers(16);
			assert.ok(viewport.getScrollOffset() > 0, "Should have scrolled");

			// Continue animation until it stops (run multiple frames)
			for (let i = 0; i < 30; i++) {
				advanceTimers(16);
				if (!viewport.isAnimating()) break;
			}

			assert.strictEqual(viewport.isAnimating(), false);
			assert.ok(scrollCallCount > 0, "onScroll should have been called");
		});

		it("should accumulate velocity from rapid inputs", () => {
			const viewport = new ScrollableViewport({ smoothScroll: true, scrollDecay: 0.88, scrollThreshold: 0.3 });
			viewport.addItem(createTestComponent(100));
			viewport.render(80, 10);

			// Rapid wheel events
			viewport.smoothScrollUp(2.5);
			viewport.smoothScrollUp(2.5);
			viewport.smoothScrollUp(2.5);

			// Run animation
			for (let i = 0; i < 50; i++) {
				advanceTimers(16);
				if (!viewport.isAnimating()) break;
			}

			// Should have scrolled more than a single impulse would
			assert.ok(viewport.getScrollOffset() > 5, `Expected > 5, got ${viewport.getScrollOffset()}`);
		});

		it("should stop animation on instant scroll", () => {
			const viewport = new ScrollableViewport({ smoothScroll: true });
			viewport.addItem(createTestComponent(50));
			viewport.render(80, 10);

			viewport.smoothScrollUp(2.5);
			assert.strictEqual(viewport.isAnimating(), true);

			// Instant scroll should stop animation
			viewport.scrollDown(5);
			assert.strictEqual(viewport.isAnimating(), false);
		});

		it("should fall back to instant scroll when disabled", () => {
			const viewport = new ScrollableViewport({ smoothScroll: false });
			viewport.addItem(createTestComponent(50));
			viewport.render(80, 10);

			viewport.smoothScrollUp(3);
			assert.strictEqual(viewport.isAnimating(), false);
			assert.strictEqual(viewport.getScrollOffset(), 3);
		});

		it("should trigger onSmoothScrollUpdate callback", () => {
			const viewport = new ScrollableViewport({ smoothScroll: true });
			viewport.addItem(createTestComponent(50));
			viewport.render(80, 10);

			let updateCount = 0;
			viewport.onSmoothScrollUpdate = () => updateCount++;

			viewport.smoothScrollUp(2.5);
			advanceTimers(16);

			assert.ok(updateCount > 0, "onSmoothScrollUpdate should have been called");
		});

		it("should clear animation on clear()", () => {
			const viewport = new ScrollableViewport({ smoothScroll: true });
			viewport.addItem(createTestComponent(50));
			viewport.render(80, 10);

			viewport.smoothScrollUp(2.5);
			assert.strictEqual(viewport.isAnimating(), true);

			viewport.clear();
			assert.strictEqual(viewport.isAnimating(), false);
			assert.strictEqual(viewport.getScrollOffset(), 0);
		});
	});
});
