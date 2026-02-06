/**
 * Scenario: ScrollableViewport with many items.
 *
 * Tests:
 * 1. Incremental append — adding items and rendering
 * 2. Scroll render — rendering at various scroll offsets
 * 3. Mixed append + scroll — interleaved operations
 */

import { ScrollableViewport } from "../../../src/components/scrollable-viewport.js";
import { Text } from "../../../src/components/text.js";
import { generateBashOutput } from "../fixtures.js";
import type { BenchmarkResult } from "../harness.js";
import { computeStats, runScenario } from "../harness.js";

const WIDTH = 120;
const VIEWPORT_HEIGHT = 40;
const ITEM_COUNT = 200;
const LINES_PER_ITEM = 5;

function createTextComponent(lines: string[]): Text {
	return new Text(lines.join("\n"));
}

/**
 * Scenario: append ITEM_COUNT items to viewport and render after each.
 */
export async function runAppend(): Promise<BenchmarkResult> {
	const bashLines = generateBashOutput(ITEM_COUNT * LINES_PER_ITEM);
	const times: number[] = [];

	// 2 warmup + 5 measured
	for (let iter = 0; iter < 7; iter++) {
		const vp = new ScrollableViewport({ autoScroll: true, smoothScroll: false });

		for (let i = 0; i < ITEM_COUNT; i++) {
			const start = i * LINES_PER_ITEM;
			const itemLines = bashLines.slice(start, start + LINES_PER_ITEM);
			const component = createTextComponent(itemLines);
			vp.addItem(component);

			const t0 = performance.now();
			vp.render(WIDTH, VIEWPORT_HEIGHT);
			const elapsed = performance.now() - t0;

			if (iter >= 2) times.push(elapsed); // Skip warmup
		}
	}

	return computeStats("viewport-append", times);
}

/**
 * Scenario: pre-populated viewport, render at various scroll positions.
 */
export async function runScroll(): Promise<BenchmarkResult> {
	const bashLines = generateBashOutput(ITEM_COUNT * LINES_PER_ITEM);
	const vp = new ScrollableViewport({ autoScroll: false, smoothScroll: false });

	// Populate
	for (let i = 0; i < ITEM_COUNT; i++) {
		const start = i * LINES_PER_ITEM;
		const itemLines = bashLines.slice(start, start + LINES_PER_ITEM);
		vp.addItem(createTextComponent(itemLines));
	}
	// Initial render to build cache
	vp.render(WIDTH, VIEWPORT_HEIGHT);

	// Scroll positions: bottom, middle, top, and back
	const totalHeight = ITEM_COUNT * LINES_PER_ITEM;
	const scrollPositions = [
		0,
		Math.floor(totalHeight * 0.25),
		Math.floor(totalHeight * 0.5),
		Math.floor(totalHeight * 0.75),
		totalHeight - VIEWPORT_HEIGHT,
		Math.floor(totalHeight * 0.5),
		0,
	];

	return runScenario({
		name: "viewport-scroll",
		warmup: 5,
		iterations: 100,
		fn: () => {
			for (const offset of scrollPositions) {
				vp.scrollToBottom();
				vp.scrollUp(offset);
				vp.render(WIDTH, VIEWPORT_HEIGHT);
			}
		},
	});
}

/**
 * Scenario: viewport with items being updated (simulating streaming tool output).
 * One item at the bottom gets new content each step.
 */
export async function runStreamingItem(): Promise<BenchmarkResult> {
	const bashLines = generateBashOutput(500);
	const times: number[] = [];

	for (let iter = 0; iter < 7; iter++) {
		const vp = new ScrollableViewport({ autoScroll: true, smoothScroll: false });

		// Pre-populate with 50 static items
		for (let i = 0; i < 50; i++) {
			vp.addItem(new Text(`Static item ${i}\nLine 2 of item ${i}`));
		}
		vp.render(WIDTH, VIEWPORT_HEIGHT);

		// Add a streaming item that grows
		const streamText = new Text("");
		vp.addItem(streamText);
		let content = "";

		for (let s = 0; s < 200; s++) {
			content += `${bashLines[s % bashLines.length]}\n`;
			streamText.setText(content);
			vp.invalidateItemCache(streamText);

			const t0 = performance.now();
			vp.render(WIDTH, VIEWPORT_HEIGHT);
			const elapsed = performance.now() - t0;

			if (iter >= 2) times.push(elapsed);
		}
	}

	return computeStats("viewport-streaming-item", times);
}
