/**
 * Tests for LiveFeed component — sliding-window display of ID-based items.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { LiveFeed } from "../src/components/live-feed.js";
import { visibleWidth } from "../src/utils.js";

describe("LiveFeed", () => {
	describe("empty state", () => {
		it("renders empty array when no items", () => {
			const feed = new LiveFeed();
			assert.deepStrictEqual(feed.render(80), []);
		});

		it("renders empty array when maxLines is 0", () => {
			const feed = new LiveFeed({ maxLines: 0 });
			feed.addItem({ id: "a", text: "hello" });
			assert.deepStrictEqual(feed.render(80), []);
		});

		it("reports length 0 initially", () => {
			const feed = new LiveFeed();
			assert.strictEqual(feed.length, 0);
		});
	});

	describe("basic rendering", () => {
		it("renders single item", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "1", text: "hello world" });
			const lines = feed.render(80);
			assert.strictEqual(lines.length, 1);
			assert.strictEqual(lines[0], "hello world");
		});

		it("renders multiple items in insertion order", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "first" });
			feed.addItem({ id: "b", text: "second" });
			feed.addItem({ id: "c", text: "third" });
			const lines = feed.render(80);
			assert.deepStrictEqual(lines, ["first", "second", "third"]);
		});

		it("wraps long lines to width", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "1", text: "a".repeat(20) });
			const lines = feed.render(10);
			assert.strictEqual(lines.length, 2);
			assert.strictEqual(lines[0], "a".repeat(10));
			assert.strictEqual(lines[1], "a".repeat(10));
		});

		it("handles multi-line item text", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "1", text: "line1\nline2\nline3" });
			const lines = feed.render(80);
			assert.deepStrictEqual(lines, ["line1", "line2", "line3"]);
		});

		it("renders items with empty text as empty line", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "1", text: "" });
			const lines = feed.render(80);
			assert.strictEqual(lines.length, 1);
			assert.strictEqual(lines[0], "");
		});
	});

	describe("sliding window / overflow", () => {
		it("shows all lines when within maxLines", () => {
			const feed = new LiveFeed({ maxLines: 5 });
			for (let i = 0; i < 5; i++) {
				feed.addItem({ id: `${i}`, text: `line ${i}` });
			}
			const lines = feed.render(80);
			assert.strictEqual(lines.length, 5);
		});

		it("truncates with overflow indicator when exceeding maxLines", () => {
			const feed = new LiveFeed({ maxLines: 3 });
			for (let i = 0; i < 5; i++) {
				feed.addItem({ id: `${i}`, text: `line ${i}` });
			}
			const lines = feed.render(80);
			assert.strictEqual(lines.length, 3);
			// First line is overflow indicator
			assert.ok(lines[0].includes("3 lines above"), `Expected overflow indicator, got: ${lines[0]}`);
			// Last two lines are the tail
			assert.strictEqual(lines[1], "line 3");
			assert.strictEqual(lines[2], "line 4");
		});

		it("counts hidden lines correctly with multi-line items", () => {
			const feed = new LiveFeed({ maxLines: 3 });
			feed.addItem({ id: "a", text: "line1\nline2\nline3" }); // 3 lines
			feed.addItem({ id: "b", text: "line4\nline5" }); // 2 lines
			// Total: 5 lines, maxLines: 3, visible: 2, hidden: 3
			const lines = feed.render(80);
			assert.strictEqual(lines.length, 3);
			assert.ok(lines[0].includes("3 lines above"));
			assert.strictEqual(lines[1], "line4");
			assert.strictEqual(lines[2], "line5");
		});

		it("uses custom overflowText when provided", () => {
			const feed = new LiveFeed({
				maxLines: 2,
				overflowText: (n) => `[${n} hidden]`,
			});
			for (let i = 0; i < 5; i++) {
				feed.addItem({ id: `${i}`, text: `line ${i}` });
			}
			const lines = feed.render(80);
			assert.strictEqual(lines[0], "[4 hidden]");
		});

		it("truncates overflow indicator to width", () => {
			const feed = new LiveFeed({
				maxLines: 2,
				overflowText: (n) =>
					`This is a very long overflow message about ${n} hidden lines that should be truncated`,
			});
			for (let i = 0; i < 10; i++) {
				feed.addItem({ id: `${i}`, text: `line ${i}` });
			}
			const lines = feed.render(30);
			assert.ok(visibleWidth(lines[0]) <= 30, `Overflow line too wide: ${visibleWidth(lines[0])}`);
		});
	});

	describe("item updates", () => {
		it("updates item text in place by id", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "◐ running" });
			feed.addItem({ id: "b", text: "pending" });
			feed.updateItem("a", "✓ done");
			const lines = feed.render(80);
			assert.deepStrictEqual(lines, ["✓ done", "pending"]);
		});

		it("addItem with existing id updates in place (no reorder)", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "first" });
			feed.addItem({ id: "b", text: "second" });
			feed.addItem({ id: "a", text: "updated first" });
			const lines = feed.render(80);
			assert.deepStrictEqual(lines, ["updated first", "second"]);
			assert.strictEqual(feed.length, 2);
		});

		it("updateItem is no-op for unknown id", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "hello" });
			feed.updateItem("nonexistent", "nope");
			assert.strictEqual(feed.length, 1);
			assert.deepStrictEqual(feed.render(80), ["hello"]);
		});
	});

	describe("item removal", () => {
		it("removes item by id", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "first" });
			feed.addItem({ id: "b", text: "second" });
			feed.addItem({ id: "c", text: "third" });
			feed.removeItem("b");
			assert.strictEqual(feed.length, 2);
			assert.deepStrictEqual(feed.render(80), ["first", "third"]);
		});

		it("removeItem is no-op for unknown id", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "hello" });
			feed.removeItem("nonexistent");
			assert.strictEqual(feed.length, 1);
		});
	});

	describe("setItems", () => {
		it("replaces all items", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "old" });
			feed.setItems([
				{ id: "x", text: "new1" },
				{ id: "y", text: "new2" },
			]);
			assert.strictEqual(feed.length, 2);
			assert.deepStrictEqual(feed.render(80), ["new1", "new2"]);
		});
	});

	describe("clear", () => {
		it("removes all items", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "hello" });
			feed.addItem({ id: "b", text: "world" });
			feed.clear();
			assert.strictEqual(feed.length, 0);
			assert.deepStrictEqual(feed.render(80), []);
		});
	});

	describe("width safety", () => {
		it("never returns lines wider than width", () => {
			const feed = new LiveFeed({ maxLines: 5 });
			const width = 20;
			feed.addItem({ id: "a", text: "short" });
			feed.addItem({ id: "b", text: "a very long line that exceeds the width" });
			feed.addItem({ id: "c", text: "another\nmulti\nline\nitem" });
			const lines = feed.render(width);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `Line too wide (${visibleWidth(line)} > ${width}): "${line}"`);
			}
		});

		it("handles width of 1", () => {
			const feed = new LiveFeed({ maxLines: 10 });
			feed.addItem({ id: "a", text: "hello" });
			const lines = feed.render(1);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= 1);
			}
		});
	});

	describe("ANSI handling", () => {
		it("preserves ANSI codes in output", () => {
			const feed = new LiveFeed();
			const colored = "\x1b[31mred text\x1b[39m";
			feed.addItem({ id: "a", text: colored });
			const lines = feed.render(80);
			assert.ok(lines[0].includes("\x1b[31m"), "Should preserve ANSI color code");
			assert.ok(lines[0].includes("\x1b[39m"), "Should preserve ANSI reset");
		});
	});

	describe("invalidation and caching", () => {
		it("returns same result for same state and width", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "hello" });
			const lines1 = feed.render(80);
			const lines2 = feed.render(80);
			assert.deepStrictEqual(lines1, lines2);
		});

		it("invalidate forces re-wrap on next render", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "hello world" });
			feed.render(80); // populate cache
			feed.invalidate();
			// Should not throw, should produce same result
			const lines = feed.render(80);
			assert.deepStrictEqual(lines, ["hello world"]);
		});

		it("re-wraps when width changes", () => {
			const feed = new LiveFeed();
			feed.addItem({ id: "a", text: "a".repeat(20) });
			const wide = feed.render(80);
			assert.strictEqual(wide.length, 1);
			const narrow = feed.render(10);
			assert.strictEqual(narrow.length, 2);
		});
	});
});
