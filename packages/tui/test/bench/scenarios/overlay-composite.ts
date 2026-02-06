/**
 * Scenario: Overlay compositing.
 *
 * Measures the overhead of compositing overlays on top of base content.
 * Tests the TUI's overlay rendering pipeline using VirtualTerminal.
 */

import { Box } from "../../../src/components/box.js";
import { Text } from "../../../src/components/text.js";
import { TUI } from "../../../src/tui.js";
import { VirtualTerminal } from "../../virtual-terminal.js";
import { generateBashOutput } from "../fixtures.js";
import type { BenchmarkResult } from "../harness.js";
import { computeStats } from "../harness.js";

const TERM_WIDTH = 120;
const TERM_HEIGHT = 40;

/**
 * Scenario: render with 1-3 overlays composited on top of scrolling content.
 */
export async function run(): Promise<BenchmarkResult> {
	const times: number[] = [];

	for (let iter = 0; iter < 7; iter++) {
		const terminal = new VirtualTerminal(TERM_WIDTH, TERM_HEIGHT);
		const tui = new TUI(terminal);

		// Base content: lots of text lines
		const bashLines = generateBashOutput(100);
		const baseContent = new Text(bashLines.join("\n"));
		tui.addChild(baseContent);

		tui.start();
		await terminal.flush();

		// Add overlays with different positioning
		const overlay1 = new Box(1, 1);
		overlay1.addChild(new Text("Overlay 1\nSome modal content\nWith multiple lines"));
		const handle1 = tui.showOverlay(overlay1, {
			anchor: "center",
			width: 40,
			maxHeight: 10,
			dimBackground: true,
			border: { title: "Dialog" },
		});

		const overlay2 = new Box(1, 0);
		overlay2.addChild(new Text("Status: OK"));
		const handle2 = tui.showOverlay(overlay2, {
			anchor: "bottom-right",
			width: 20,
			margin: 1,
		});

		// Measure render cycles with overlays
		for (let frame = 0; frame < 100; frame++) {
			// Simulate content updates underneath
			baseContent.setText(bashLines.slice(frame % 50).join("\n"));

			const t0 = performance.now();
			tui.requestRender();
			await terminal.flush();
			const elapsed = performance.now() - t0;

			if (iter >= 2) times.push(elapsed);
		}

		handle1.hide();
		handle2.hide();
		tui.stop();
	}

	return computeStats("overlay-composite", times);
}
