#!/usr/bin/env bun
/**
 * TUI Benchmark Runner
 *
 * Usage:
 *   bun run bench:tui              # Run all scenarios, compare to baseline
 *   bun run bench:tui --save       # Run all + save results as new baseline
 *   bun run bench:tui --filter md  # Run only scenarios matching "md"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Baseline,
	type BenchmarkResult,
	compareToBaseline,
	formatComparisonTable,
	formatResult,
	hasRegressions,
	resultToBaselineEntry,
} from "./harness.js";
import {
	runBoxRender,
	runBoxRenderUncached,
	runMarkdownCached,
	runMarkdownCold,
	runTextRender,
} from "./scenarios/component-render.js";
import { run as runFullTui } from "./scenarios/full-tui-render.js";
// Scenario imports
import { run as runMarkdownStream } from "./scenarios/markdown-stream.js";
import { run as runOverlay } from "./scenarios/overlay-composite.js";
import {
	runAppend as runViewportAppend,
	runScroll as runViewportScroll,
	runStreamingItem as runViewportStreaming,
} from "./scenarios/scrollable-viewport.js";

const BASELINE_PATH = path.join(import.meta.dir, "baseline.json");

interface ScenarioEntry {
	name: string;
	run: () => Promise<BenchmarkResult>;
}

const ALL_SCENARIOS: ScenarioEntry[] = [
	{ name: "markdown-stream", run: runMarkdownStream },
	{ name: "viewport-append", run: runViewportAppend },
	{ name: "viewport-scroll", run: runViewportScroll },
	{ name: "viewport-streaming-item", run: runViewportStreaming },
	{ name: "overlay-composite", run: runOverlay },
	{ name: "component-text", run: runTextRender },
	{ name: "component-box", run: runBoxRender },
	{ name: "component-box-uncached", run: runBoxRenderUncached },
	{ name: "component-markdown-cold", run: runMarkdownCold },
	{ name: "component-markdown-cached", run: runMarkdownCached },
	{ name: "full-tui-render", run: runFullTui },
];

async function main() {
	const args = process.argv.slice(2);
	const saveBaseline = args.includes("--save");
	const filterArg = args.find((a) => !a.startsWith("--"));

	let scenarios = ALL_SCENARIOS;
	if (filterArg) {
		scenarios = scenarios.filter((s) => s.name.includes(filterArg));
		if (scenarios.length === 0) {
			console.error(`No scenarios matching "${filterArg}"`);
			process.exit(1);
		}
	}

	console.log(`\nTUI Benchmark — ${scenarios.length} scenario(s)\n`);

	// Load baseline
	let baseline: Baseline = {};
	if (fs.existsSync(BASELINE_PATH)) {
		try {
			baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
		} catch {
			console.warn("  Warning: could not parse baseline.json, running without baseline\n");
		}
	}

	// Run scenarios
	const results: BenchmarkResult[] = [];
	for (const scenario of scenarios) {
		process.stdout.write(`  Running: ${scenario.name}...`);
		const startTime = performance.now();
		const result = await scenario.run();
		const wallTime = ((performance.now() - startTime) / 1000).toFixed(1);
		console.log(` done (${wallTime}s)`);
		results.push(result);
	}

	// Print results
	console.log("\n═══ Results ═══\n");
	for (const result of results) {
		console.log(formatResult(result));
		console.log();
	}

	// Compare to baseline
	const comparisonRows = compareToBaseline(results, baseline);
	if (comparisonRows.length > 0) {
		console.log("═══ Regression Check ═══\n");
		console.log(formatComparisonTable(comparisonRows));
		console.log();
	} else {
		console.log("  (no baseline found — run with --save to create one)\n");
	}

	// Save baseline
	if (saveBaseline) {
		const newBaseline: Baseline = { ...baseline };
		for (const result of results) {
			newBaseline[result.name] = resultToBaselineEntry(result);
		}
		fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(newBaseline, null, "\t")}\n`);
		console.log(`  Baseline saved to ${BASELINE_PATH}\n`);
	}

	// Exit with error if regressions detected
	if (hasRegressions(comparisonRows)) {
		console.error("  FAIL: regressions detected\n");
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Benchmark failed:", err);
	process.exit(1);
});
