/**
 * Scenario: Long markdown streaming.
 *
 * Simulates an LLM streaming markdown text in small chunks.
 * Measures the cost of setText() + render() per chunk as content grows.
 */

import { Markdown } from "../../../src/components/markdown.js";
import { createBenchTheme, generateMarkdownChunks } from "../fixtures.js";
import type { BenchmarkResult } from "../harness.js";
import { computeStats } from "../harness.js";

const WIDTH = 100;
const TOTAL_BLOCKS = 100; // Generates many chunks (blocks broken into ~15-24 char pieces)
const WARMUP_ITERATIONS = 2;
const MEASURED_ITERATIONS = 5;

export async function run(): Promise<BenchmarkResult> {
	const theme = createBenchTheme();
	const chunks = generateMarkdownChunks(TOTAL_BLOCKS);

	const allTimes: number[] = [];

	// Warmup
	for (let w = 0; w < WARMUP_ITERATIONS; w++) {
		const md = new Markdown("", 0, 0, theme);
		for (const chunk of chunks) {
			md.setText(chunk);
			md.render(WIDTH);
		}
	}

	// Measured runs
	for (let iter = 0; iter < MEASURED_ITERATIONS; iter++) {
		const md = new Markdown("", 0, 0, theme);

		for (const chunk of chunks) {
			const start = performance.now();
			md.setText(chunk);
			md.render(WIDTH);
			allTimes.push(performance.now() - start);
		}
	}

	return computeStats("markdown-stream", allTimes);
}
