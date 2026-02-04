import type { Finding } from "../types.js";
import { clusterFindings, type MergeExecutor, type MergeExecutorOptions, rankFindings } from "./types.js";

/**
 * Union strategy: combines all findings from all agents.
 * Clusters similar findings but keeps all of them.
 */
export const unionExecutor: MergeExecutor = {
	type: "union",

	async execute(findings: Finding[], options: MergeExecutorOptions) {
		options.onProgress?.("clustering");

		// Cluster similar findings
		const clusters = clusterFindings(findings);

		options.onProgress?.("ranking");

		// Rank all findings
		const ranked = rankFindings(findings);

		options.onProgress?.("synthesizing");

		// Generate summary
		const summary = generateUnionSummary(ranked, clusters);

		return {
			findings: ranked,
			clusters,
			summary,
		};
	},
};

function generateUnionSummary(findings: Finding[], clusters: { agreementCount: number }[]): string {
	const bySeverity = {
		critical: findings.filter((f) => f.severity === "critical").length,
		high: findings.filter((f) => f.severity === "high").length,
		medium: findings.filter((f) => f.severity === "medium").length,
		low: findings.filter((f) => f.severity === "low").length,
		info: findings.filter((f) => f.severity === "info").length,
	};

	const multiAgentCount = clusters.filter((c) => c.agreementCount > 1).length;

	const lines = [
		`## Review Summary (Union)`,
		``,
		`**Total findings:** ${findings.length}`,
		`- Critical: ${bySeverity.critical}`,
		`- High: ${bySeverity.high}`,
		`- Medium: ${bySeverity.medium}`,
		`- Low: ${bySeverity.low}`,
		`- Info: ${bySeverity.info}`,
		``,
		`**Multi-agent agreement:** ${multiAgentCount} issues found by multiple reviewers`,
	];

	return lines.join("\n");
}
