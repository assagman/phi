import type { Finding } from "../types.js";
import { clusterFindings, type MergeExecutor, type MergeExecutorOptions, rankFindings } from "./types.js";

/**
 * Intersection strategy: only keeps findings that multiple agents agree on.
 * More conservative - reduces false positives.
 */
export const intersectionExecutor: MergeExecutor = {
	type: "intersection",

	async execute(findings: Finding[], options: MergeExecutorOptions) {
		options.onProgress?.("clustering");

		// Cluster findings
		const clusters = clusterFindings(findings);

		// Keep only clusters with agreement from 2+ agents
		const agreedClusters = clusters.filter((c) => c.agreementCount >= 2);

		options.onProgress?.("ranking");

		// Extract findings from agreed clusters (primary + related)
		const agreedFindings: Finding[] = [];
		for (const cluster of agreedClusters) {
			agreedFindings.push({ ...cluster.primary, verified: true });
			for (const related of cluster.related) {
				agreedFindings.push({ ...related, verified: true });
			}
		}

		const ranked = rankFindings(agreedFindings);

		options.onProgress?.("synthesizing");

		// Generate summary
		const summary = generateIntersectionSummary(findings, ranked, agreedClusters);

		return {
			findings: ranked,
			clusters: agreedClusters,
			summary,
		};
	},
};

function generateIntersectionSummary(
	allFindings: Finding[],
	agreedFindings: Finding[],
	agreedClusters: { agreementCount: number }[],
): string {
	const uniqueAgents = new Set(allFindings.map((f) => f.agentName)).size;

	const bySeverity = {
		critical: agreedFindings.filter((f) => f.severity === "critical").length,
		high: agreedFindings.filter((f) => f.severity === "high").length,
		medium: agreedFindings.filter((f) => f.severity === "medium").length,
		low: agreedFindings.filter((f) => f.severity === "low").length,
		info: agreedFindings.filter((f) => f.severity === "info").length,
	};

	const lines = [
		`## Review Summary (Intersection)`,
		``,
		`**Filtered findings:** ${agreedFindings.length} of ${allFindings.length} original findings`,
		`**Agents consulted:** ${uniqueAgents}`,
		`**Agreed clusters:** ${agreedClusters.length}`,
		``,
		`**By severity (agreed only):**`,
		`- Critical: ${bySeverity.critical}`,
		`- High: ${bySeverity.high}`,
		`- Medium: ${bySeverity.medium}`,
		`- Low: ${bySeverity.low}`,
		`- Info: ${bySeverity.info}`,
		``,
		`*Only showing issues found by 2+ reviewers*`,
	];

	return lines.join("\n");
}
