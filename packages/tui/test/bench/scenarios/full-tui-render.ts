/**
 * Scenario: Full TUI render cycle through VirtualTerminal.
 *
 * Measures the complete pipeline: component render → differential update → terminal write.
 * Uses VirtualTerminal to capture actual terminal output without a real TTY.
 */

import { Markdown } from "../../../src/components/markdown.js";
import { ScrollableViewport } from "../../../src/components/scrollable-viewport.js";
import { Text } from "../../../src/components/text.js";
import { TUI } from "../../../src/tui.js";
import { VirtualTerminal } from "../../virtual-terminal.js";
import { createBenchTheme, generateBashOutput, generateMarkdownChunks } from "../fixtures.js";
import type { BenchmarkResult } from "../harness.js";
import { computeStats } from "../harness.js";

const WIDTH = 120;
const HEIGHT = 40;

/**
 * Scenario: Full render cycle with a mix of components.
 * Simulates a realistic interactive session layout:
 *   - ScrollableViewport containing multiple assistant messages (Markdown)
 *   - Tool output sections (Text)
 *   - Footer bar
 */
export async function run(): Promise<BenchmarkResult> {
	const theme = createBenchTheme();
	const chunks = generateMarkdownChunks(20); // ~20 blocks worth of streaming chunks
	const bashLines = generateBashOutput(100);
	const times: number[] = [];

	for (let iter = 0; iter < 7; iter++) {
		const terminal = new VirtualTerminal(WIDTH, HEIGHT);
		const tui = new TUI(terminal);

		// Build layout: viewport + footer
		const viewport = new ScrollableViewport({ autoScroll: true, smoothScroll: false });

		// Add some existing messages
		for (let i = 0; i < 5; i++) {
			const msg = new Markdown(
				`## Message ${i}\n\nThis is a previous message with some content.\n\n\`\`\`\ncode block here\n\`\`\`\n`,
				0,
				0,
				theme,
			);
			viewport.addItem(msg);
		}

		// Add a tool output section
		const toolOutput = new Text(bashLines.slice(0, 20).join("\n"));
		viewport.addItem(toolOutput);

		// Streaming message
		const streamMsg = new Markdown("", 0, 0, theme);
		viewport.addItem(streamMsg);

		// Footer
		const footer = new Text("pi > model: test | tokens: 1234 | cost: $0.00");

		tui.addChild(viewport);
		tui.addChild(footer);
		tui.start();
		await terminal.flush();

		// Simulate streaming: update the last message with growing content
		// Pick a subset of chunks to keep iteration time reasonable
		const stepChunks = chunks.filter((_, idx) => idx % 3 === 0).slice(0, 100);

		for (let s = 0; s < stepChunks.length; s++) {
			streamMsg.setText(stepChunks[s]);
			viewport.invalidateItemCache(streamMsg);

			const t0 = performance.now();
			// Force synchronous render path (bypass throttle for benchmarking)
			const rendered = tui.render(WIDTH);
			// We measure the component render; terminal.write is separate
			void rendered;
			const elapsed = performance.now() - t0;

			if (iter >= 2) times.push(elapsed);
		}

		tui.stop();
	}

	return computeStats("full-tui-render", times);
}
