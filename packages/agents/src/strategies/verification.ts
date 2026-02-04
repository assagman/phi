import { type AgentContext, type AgentMessage, agentLoop } from "agent";
import { type Message, streamSimple } from "ai";
import type { Finding, FindingCluster } from "../types.js";
import {
	clusterFindings,
	type MergeExecutor,
	type MergeExecutorOptions,
	type MergeResult,
	rankFindings,
} from "./types.js";

/**
 * Verification strategy: uses a merge agent to verify findings against actual code.
 * Most thorough but requires additional LLM calls.
 */
export const verificationExecutor: MergeExecutor = {
	type: "verification",

	async execute(findings: Finding[], options: MergeExecutorOptions): Promise<MergeResult> {
		if (!options.mergeAgent) {
			// Fall back to union if no merge agent provided
			const { unionExecutor } = await import("./union.js");
			return unionExecutor.execute(findings, options);
		}

		options.onProgress?.("clustering");
		const clusters = clusterFindings(findings);

		options.onProgress?.("verifying");
		const verifiedClusters = await verifyWithAgent(clusters, findings, options);

		options.onProgress?.("ranking");
		const verifiedFindings = extractVerifiedFindings(verifiedClusters);
		const ranked = rankFindings(verifiedFindings);

		options.onProgress?.("synthesizing");
		const summary = await synthesizeSummary(ranked, verifiedClusters, options);

		return {
			findings: ranked,
			clusters: verifiedClusters,
			summary,
		};
	},
};

async function verifyWithAgent(
	clusters: FindingCluster[],
	allFindings: Finding[],
	options: MergeExecutorOptions,
): Promise<FindingCluster[]> {
	const { mergeAgent, tools, signal, getApiKey, onEvent } = options;
	if (!mergeAgent) return clusters;

	// Build verification prompt with all findings
	const findingsJson = JSON.stringify(allFindings, null, 2);
	const clustersJson = JSON.stringify(
		clusters.map((c) => ({
			primary: c.primary.id,
			related: c.related.map((r) => r.id),
			agreementCount: c.agreementCount,
		})),
		null,
		2,
	);

	const verificationPrompt: AgentMessage = {
		role: "user",
		content: `Please verify these findings against the actual code using the read tool.

## Findings to Verify
\`\`\`json
${findingsJson}
\`\`\`

## Clusters
\`\`\`json
${clustersJson}
\`\`\`

For each cluster:
1. Read the referenced files
2. Verify if the primary finding is accurate
3. Mark as "verified", "partial", or "invalid"
4. Add a brief verification note

Output your results in this format:
### Verification: [finding-id]
**Status:** verified | partial | invalid
**Note:** Brief explanation

When done, provide a JSON array of verified finding IDs:
\`\`\`json
["finding-1", "finding-2", ...]
\`\`\``,
		timestamp: Date.now(),
	};

	const context: AgentContext = {
		systemPrompt: mergeAgent.systemPrompt,
		messages: [],
		tools: tools ?? [],
	};

	const stream = agentLoop(
		[verificationPrompt],
		context,
		{
			model: mergeAgent.model,
			temperature: mergeAgent.temperature,
			maxTokens: mergeAgent.maxTokens,
			reasoning: mergeAgent.thinkingLevel === "off" ? undefined : mergeAgent.thinkingLevel,
			signal,
			convertToLlm: (msgs) =>
				msgs.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
			getApiKey,
		},
		signal,
		streamSimple,
	);

	const messages: AgentMessage[] = [];

	for await (const event of stream) {
		onEvent?.(event);
		if (event.type === "message_end") {
			messages.push(event.message);
		}
	}

	// Parse verification results from response
	return parseVerificationResults(clusters, messages);
}

function parseVerificationResults(clusters: FindingCluster[], messages: AgentMessage[]): FindingCluster[] {
	const verifiedIds = new Set<string>();
	const notes: Record<string, string> = {};

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;

		const content =
			typeof msg.content === "string"
				? msg.content
				: msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");

		// Parse verification blocks
		const verificationBlocks = content.split(/###\s+Verification:/i).slice(1);
		for (const block of verificationBlocks) {
			const idMatch = block.match(/^\s*(\S+)/);
			const statusMatch = block.match(/\*\*Status:\*\*\s*(\w+)/i);
			const noteMatch = block.match(/\*\*Note:\*\*\s*(.+?)(?=\n|$)/i);

			if (idMatch && statusMatch) {
				const id = idMatch[1].trim();
				const status = statusMatch[1].toLowerCase();
				if (status === "verified" || status === "partial") {
					verifiedIds.add(id);
				}
				if (noteMatch) {
					notes[id] = noteMatch[1].trim();
				}
			}
		}

		// Also try to parse the final JSON array
		const jsonMatch = content.match(/```json\s*\n\[([^\]]*)\]\s*\n```/);
		if (jsonMatch) {
			try {
				const ids = JSON.parse(`[${jsonMatch[1]}]`);
				for (const id of ids) {
					verifiedIds.add(id);
				}
			} catch {
				// Ignore parse errors
			}
		}
	}

	// Update clusters with verification status
	return clusters.map((cluster) => ({
		...cluster,
		verified: verifiedIds.has(cluster.primary.id),
		verificationNote: notes[cluster.primary.id],
		primary: {
			...cluster.primary,
			verified: verifiedIds.has(cluster.primary.id),
		},
		related: cluster.related.map((r) => ({
			...r,
			verified: verifiedIds.has(r.id),
		})),
	}));
}

function extractVerifiedFindings(clusters: FindingCluster[]): Finding[] {
	const findings: Finding[] = [];

	for (const cluster of clusters) {
		// Include all findings, but mark verification status
		findings.push(cluster.primary);
		findings.push(...cluster.related);
	}

	return findings;
}

async function synthesizeSummary(
	findings: Finding[],
	clusters: FindingCluster[],
	_options: MergeExecutorOptions,
): Promise<string> {
	const verifiedCount = findings.filter((f) => f.verified).length;
	const invalidCount = findings.length - verifiedCount;

	const bySeverity = {
		critical: findings.filter((f) => f.severity === "critical" && f.verified).length,
		high: findings.filter((f) => f.severity === "high" && f.verified).length,
		medium: findings.filter((f) => f.severity === "medium" && f.verified).length,
		low: findings.filter((f) => f.severity === "low" && f.verified).length,
		info: findings.filter((f) => f.severity === "info" && f.verified).length,
	};

	const highConfidenceClusters = clusters.filter((c) => c.agreementCount >= 2 && c.verified);

	const lines = [
		`## Review Summary (Verified)`,
		``,
		`**Verification results:** ${verifiedCount} verified, ${invalidCount} unverified/invalid`,
		`**High-confidence issues:** ${highConfidenceClusters.length} (multi-agent + verified)`,
		``,
		`**Verified findings by severity:**`,
		`- Critical: ${bySeverity.critical}`,
		`- High: ${bySeverity.high}`,
		`- Medium: ${bySeverity.medium}`,
		`- Low: ${bySeverity.low}`,
		`- Info: ${bySeverity.info}`,
	];

	// Add top issues
	const topIssues = findings
		.filter((f) => f.verified && (f.severity === "critical" || f.severity === "high"))
		.slice(0, 5);

	if (topIssues.length > 0) {
		lines.push("", "**Top verified issues:**");
		for (const issue of topIssues) {
			lines.push(`- [${issue.severity.toUpperCase()}] ${issue.title}${issue.file ? ` (${issue.file})` : ""}`);
		}
	}

	return lines.join("\n");
}
