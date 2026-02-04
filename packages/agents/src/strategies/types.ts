import type { AgentEvent, AgentTool } from "agent";
import type { AgentPreset, Finding, FindingCluster, MergeStrategyType } from "../types.js";

/**
 * Options passed to merge executor.
 */
export interface MergeExecutorOptions {
	/** Agent preset for verification (required for verification strategy) */
	mergeAgent?: AgentPreset;
	/** Tools available for verification */
	tools?: AgentTool[];
	/** Abort signal */
	signal?: AbortSignal;
	/** API key resolver */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Callback for agent events during merge */
	onEvent?: (event: AgentEvent) => void;
	/** Callback for progress updates */
	onProgress?: (phase: "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing") => void;
}

/**
 * Result from merge execution.
 */
export interface MergeResult {
	findings: Finding[];
	clusters: FindingCluster[];
	summary?: string;
}

/**
 * Interface for merge strategy executors.
 */
export interface MergeExecutor {
	/** Strategy type identifier */
	type: MergeStrategyType;
	/** Execute the merge */
	execute(findings: Finding[], options: MergeExecutorOptions): Promise<MergeResult>;
}

/**
 * Calculate similarity between two findings (0-1).
 */
export function calculateSimilarity(a: Finding, b: Finding): number {
	let score = 0;
	let weights = 0;

	// Same file is a strong signal
	if (a.file && b.file) {
		weights += 3;
		if (a.file === b.file) score += 3;
	}

	// Same or overlapping lines
	if (a.line !== undefined && b.line !== undefined) {
		weights += 2;
		const aStart = typeof a.line === "number" ? a.line : a.line[0];
		const aEnd = typeof a.line === "number" ? a.line : a.line[1];
		const bStart = typeof b.line === "number" ? b.line : b.line[0];
		const bEnd = typeof b.line === "number" ? b.line : b.line[1];

		// Within 5 lines considered similar
		if (Math.abs(aStart - bStart) <= 5 || Math.abs(aEnd - bEnd) <= 5) {
			score += 2;
		} else if (
			(aStart <= bEnd && aEnd >= bStart) || // Overlapping ranges
			Math.min(Math.abs(aStart - bEnd), Math.abs(aEnd - bStart)) <= 5
		) {
			score += 1;
		}
	}

	// Same category
	weights += 1;
	if (a.category === b.category) score += 1;

	// Same severity (less important for similarity)
	weights += 0.5;
	if (a.severity === b.severity) score += 0.5;

	// Title similarity (simple word overlap)
	weights += 1.5;
	const aWords = new Set(a.title.toLowerCase().split(/\s+/));
	const bWords = new Set(b.title.toLowerCase().split(/\s+/));
	const intersection = [...aWords].filter((w) => bWords.has(w)).length;
	const union = new Set([...aWords, ...bWords]).size;
	if (union > 0) {
		score += 1.5 * (intersection / union);
	}

	return weights > 0 ? score / weights : 0;
}

/**
 * Cluster findings by similarity.
 */
export function clusterFindings(findings: Finding[], similarityThreshold = 0.6): FindingCluster[] {
	const clusters: FindingCluster[] = [];
	const assigned = new Set<string>();

	// Sort by severity for primary selection
	const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
	const sorted = [...findings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

	for (const finding of sorted) {
		if (assigned.has(finding.id)) continue;

		const cluster: FindingCluster = {
			primary: finding,
			related: [],
			agreementCount: 1,
		};
		assigned.add(finding.id);

		// Find related findings
		for (const other of findings) {
			if (assigned.has(other.id)) continue;
			if (other.agentName === finding.agentName) continue; // Different agents only

			const similarity = calculateSimilarity(finding, other);
			if (similarity >= similarityThreshold) {
				cluster.related.push(other);
				cluster.agreementCount++;
				assigned.add(other.id);
			}
		}

		clusters.push(cluster);
	}

	// Sort clusters by agreement count (descending) then severity
	clusters.sort((a, b) => {
		if (b.agreementCount !== a.agreementCount) {
			return b.agreementCount - a.agreementCount;
		}
		return severityOrder[a.primary.severity] - severityOrder[b.primary.severity];
	});

	return clusters;
}

/**
 * Rank findings by severity and confidence.
 */
export function rankFindings(findings: Finding[]): Finding[] {
	const severityScore = { critical: 100, high: 75, medium: 50, low: 25, info: 10 };

	return [...findings].sort((a, b) => {
		const aScore = severityScore[a.severity] + (a.confidence ?? 0.5) * 20 + (a.verified ? 50 : 0);
		const bScore = severityScore[b.severity] + (b.confidence ?? 0.5) * 20 + (b.verified ? 50 : 0);
		return bScore - aScore;
	});
}
