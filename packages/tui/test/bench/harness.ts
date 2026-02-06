/**
 * Benchmark harness for TUI rendering performance.
 *
 * Provides utilities for timing, statistics, and regression detection.
 */

export interface BenchmarkResult {
	/** Scenario name */
	name: string;
	/** Number of measured iterations */
	iterations: number;
	/** Render times in ms (sorted ascending) */
	times: number[];
	/** Percentile stats */
	p50: number;
	p95: number;
	p99: number;
	min: number;
	max: number;
	mean: number;
	/** Total wall time for all iterations in ms */
	totalMs: number;
	/** Throughput: iterations per second */
	opsPerSec: number;
}

export interface BaselineEntry {
	p50: number;
	p95: number;
	p99: number;
	mean: number;
	opsPerSec: number;
}

export type Baseline = Record<string, BaselineEntry>;

export interface ComparisonRow {
	name: string;
	metricLabel: string;
	baseline: number;
	current: number;
	deltaPercent: number;
	status: "pass" | "warn" | "fail";
}

// ─── Statistics ──────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

export function computeStats(name: string, times: number[]): BenchmarkResult {
	const sorted = [...times].sort((a, b) => a - b);
	const total = sorted.reduce((s, t) => s + t, 0);
	const mean = sorted.length > 0 ? total / sorted.length : 0;

	return {
		name,
		iterations: sorted.length,
		times: sorted,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
		mean,
		totalMs: total,
		opsPerSec: total > 0 ? (sorted.length / total) * 1000 : 0,
	};
}

// ─── Benchmark runner ────────────────────────────────────────

export interface ScenarioConfig {
	/** Scenario name */
	name: string;
	/** Number of warmup iterations (default: 5) */
	warmup?: number;
	/** Number of measured iterations (default: 50) */
	iterations?: number;
	/** Setup called once before warmup+iterations */
	setup?: () => void | Promise<void>;
	/** The function to benchmark. Returns nothing; timing is external. */
	fn: () => void | Promise<void>;
	/** Teardown called once after all iterations */
	teardown?: () => void | Promise<void>;
}

export async function runScenario(config: ScenarioConfig): Promise<BenchmarkResult> {
	const warmup = config.warmup ?? 5;
	const iterations = config.iterations ?? 50;

	if (config.setup) await config.setup();

	// Warmup
	for (let i = 0; i < warmup; i++) {
		await config.fn();
	}

	// Measured runs
	const times: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		await config.fn();
		times.push(performance.now() - start);
	}

	if (config.teardown) await config.teardown();

	return computeStats(config.name, times);
}

/**
 * Run a scenario where each iteration is a sequence of steps (e.g., streaming chunks).
 * Measures individual step times and returns aggregate stats.
 */
export interface StreamScenarioConfig {
	name: string;
	warmup?: number;
	iterations?: number;
	/** Setup called once; returns context passed to step(). */
	setup: () => void | Promise<void>;
	/** One step (e.g., append a chunk + render). Called `steps` times per iteration. */
	step: (stepIndex: number) => void | Promise<void>;
	/** Number of steps per iteration */
	steps: number;
	/** Reset state between iterations */
	reset: () => void | Promise<void>;
	teardown?: () => void | Promise<void>;
}

export async function runStreamScenario(config: StreamScenarioConfig): Promise<BenchmarkResult> {
	const warmup = config.warmup ?? 2;
	const iterations = config.iterations ?? 10;

	await config.setup();

	// Warmup
	for (let w = 0; w < warmup; w++) {
		for (let s = 0; s < config.steps; s++) {
			await config.step(s);
		}
		await config.reset();
	}

	// Measured runs — collect per-step times
	const times: number[] = [];
	for (let i = 0; i < iterations; i++) {
		for (let s = 0; s < config.steps; s++) {
			const start = performance.now();
			await config.step(s);
			times.push(performance.now() - start);
		}
		await config.reset();
	}

	if (config.teardown) await config.teardown();

	return computeStats(config.name, times);
}

// ─── Comparison / regression ─────────────────────────────────

/** Threshold for regression detection */
const REGRESSION_THRESHOLD_PCT = 20; // p95 time increase
const THROUGHPUT_THRESHOLD_PCT = 15; // ops/sec decrease
const WARN_THRESHOLD_PCT = 10;

export function compareToBaseline(results: BenchmarkResult[], baseline: Baseline): ComparisonRow[] {
	const rows: ComparisonRow[] = [];

	for (const result of results) {
		const base = baseline[result.name];
		if (!base) continue;

		// p95 comparison (higher is worse)
		const p95Delta = ((result.p95 - base.p95) / base.p95) * 100;
		rows.push({
			name: result.name,
			metricLabel: "p95 (ms)",
			baseline: base.p95,
			current: result.p95,
			deltaPercent: p95Delta,
			status: p95Delta > REGRESSION_THRESHOLD_PCT ? "fail" : p95Delta > WARN_THRESHOLD_PCT ? "warn" : "pass",
		});

		// ops/sec comparison (lower is worse)
		const opseDelta = ((result.opsPerSec - base.opsPerSec) / base.opsPerSec) * 100;
		rows.push({
			name: result.name,
			metricLabel: "ops/sec",
			baseline: base.opsPerSec,
			current: result.opsPerSec,
			deltaPercent: opseDelta,
			status: opseDelta < -THROUGHPUT_THRESHOLD_PCT ? "fail" : opseDelta < -WARN_THRESHOLD_PCT ? "warn" : "pass",
		});
	}

	return rows;
}

// ─── Formatting ──────────────────────────────────────────────

export function formatResult(r: BenchmarkResult): string {
	const lines = [
		`  ${r.name}`,
		`    iterations: ${r.iterations}`,
		`    p50: ${r.p50.toFixed(3)}ms  p95: ${r.p95.toFixed(3)}ms  p99: ${r.p99.toFixed(3)}ms`,
		`    min: ${r.min.toFixed(3)}ms  max: ${r.max.toFixed(3)}ms  mean: ${r.mean.toFixed(3)}ms`,
		`    ops/sec: ${r.opsPerSec.toFixed(1)}`,
	];
	return lines.join("\n");
}

export function formatComparisonTable(rows: ComparisonRow[]): string {
	if (rows.length === 0) return "  (no baseline to compare)";

	const STATUS_ICONS: Record<string, string> = { pass: "OK", warn: "!!", fail: "FAIL" };

	const header = "  Scenario                              | Metric   | Baseline    | Current     | Delta     | Status";
	const sep = `  ${"-".repeat(header.length - 2)}`;
	const lines = [header, sep];

	for (const row of rows) {
		const name = row.name.padEnd(38);
		const metric = row.metricLabel.padEnd(8);
		const base = row.baseline.toFixed(3).padStart(11);
		const cur = row.current.toFixed(3).padStart(11);
		const sign = row.deltaPercent >= 0 ? "+" : "";
		const delta = `${sign}${row.deltaPercent.toFixed(1)}%`.padStart(9);
		const status = STATUS_ICONS[row.status] ?? row.status;
		lines.push(`  ${name} | ${metric} | ${base} | ${cur} | ${delta} | ${status}`);
	}

	return lines.join("\n");
}

export function resultToBaselineEntry(r: BenchmarkResult): BaselineEntry {
	return {
		p50: r.p50,
		p95: r.p95,
		p99: r.p99,
		mean: r.mean,
		opsPerSec: r.opsPerSec,
	};
}

export function hasRegressions(rows: ComparisonRow[]): boolean {
	return rows.some((r) => r.status === "fail");
}
