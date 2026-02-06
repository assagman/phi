/**
 * Scenario: Micro-benchmarks for individual component render() calls.
 *
 * Tests raw render performance of Box, Text, Markdown in isolation.
 */

import { Box } from "../../../src/components/box.js";
import { Markdown } from "../../../src/components/markdown.js";
import { Text } from "../../../src/components/text.js";
import { createBenchTheme, generateBashOutput } from "../fixtures.js";
import type { BenchmarkResult } from "../harness.js";
import { runScenario } from "../harness.js";

const WIDTH = 100;

/**
 * Text component with large content.
 */
export async function runTextRender(): Promise<BenchmarkResult> {
	const lines = generateBashOutput(500);
	const content = lines.join("\n");
	const text = new Text(content);

	return runScenario({
		name: "component-text",
		warmup: 10,
		iterations: 200,
		fn: () => {
			text.render(WIDTH);
		},
	});
}

/**
 * Box with nested children.
 */
export async function runBoxRender(): Promise<BenchmarkResult> {
	const box = new Box(2, 1);
	for (let i = 0; i < 20; i++) {
		const child = new Text(`Child ${i}: ${"Some content with padding and borders ".repeat(2)}`);
		box.addChild(child);
	}

	return runScenario({
		name: "component-box",
		warmup: 10,
		iterations: 200,
		fn: () => {
			box.render(WIDTH);
		},
	});
}

/**
 * Box with nested children, invalidated each iteration (cache miss path).
 */
export async function runBoxRenderUncached(): Promise<BenchmarkResult> {
	const box = new Box(2, 1);
	for (let i = 0; i < 20; i++) {
		const child = new Text(`Child ${i}: ${"Some content with padding and borders ".repeat(2)}`);
		box.addChild(child);
	}

	return runScenario({
		name: "component-box-uncached",
		warmup: 10,
		iterations: 200,
		fn: () => {
			box.invalidate();
			box.render(WIDTH);
		},
	});
}

/**
 * Markdown component — full document render (cold).
 */
export async function runMarkdownCold(): Promise<BenchmarkResult> {
	const theme = createBenchTheme();
	const doc = [
		"# Main Heading",
		"",
		"Some introductory paragraph with **bold** and *italic* text.",
		"",
		"## Code Example",
		"",
		"```typescript",
		"function hello(name: string): void {",
		'  console.log("Hello", name);',
		"}",
		"```",
		"",
		"## List Section",
		"",
		"- First item with details",
		"- Second item with **emphasis**",
		"- Third item with `code`",
		"  - Nested sub-item",
		"",
		"> Important blockquote text",
		"> Second line of quote",
		"",
		"---",
		"",
		"Final paragraph with closing thoughts.",
	].join("\n");

	return runScenario({
		name: "component-markdown-cold",
		warmup: 10,
		iterations: 100,
		fn: () => {
			// New instance each time = cold render (no cache)
			const md = new Markdown(doc, 0, 0, theme);
			md.render(WIDTH);
		},
	});
}

/**
 * Markdown component — cached re-render (same content, same width).
 */
export async function runMarkdownCached(): Promise<BenchmarkResult> {
	const theme = createBenchTheme();
	const doc = [
		"# Heading",
		"",
		"Paragraph with **bold** and *italic*.",
		"",
		"```typescript",
		"const x = 42;",
		"```",
		"",
		"- Item 1",
		"- Item 2",
	].join("\n");

	const md = new Markdown(doc, 0, 0, theme);
	// Prime cache
	md.render(WIDTH);

	return runScenario({
		name: "component-markdown-cached",
		warmup: 10,
		iterations: 500,
		fn: () => {
			md.render(WIDTH);
		},
	});
}
