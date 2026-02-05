/**
 * Handoff utilities — context enrichment and truncation.
 */

import type { Model } from "ai";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ─── Context Truncation ─────────────────────────────────────────────────────

/**
 * Truncate conversation text to fit within the summarization model's context window.
 * Truncates from the beginning (oldest messages) to preserve recent context.
 * Reserves space for system prompt, goal text, enrichment sections, and output tokens.
 */
export function truncateForSummarization(text: string, model: Model<any>): string {
	// Conservative chars-to-tokens ratio (~3 chars per token)
	// Reserve 30% for system prompt + goal + enrichment + output
	const maxChars = Math.floor(model.contextWindow * 3 * 0.7);

	if (text.length <= maxChars) return text;

	const marker = "[... earlier conversation truncated ...]\n\n";
	const truncated = text.slice(text.length - maxChars + marker.length);

	// Try to break at a message boundary (look for [User]: or [Assistant]: or [Tool result]:)
	const boundaryMatch = truncated.match(
		/\n\n\[(User|Assistant|Tool result|Assistant thinking|Assistant tool calls)\]:/,
	);
	if (boundaryMatch?.index !== undefined) {
		return marker + truncated.slice(boundaryMatch.index + 2);
	}

	return marker + truncated;
}

// ─── Context Enrichment ─────────────────────────────────────────────────────

export interface EnrichedContext {
	/** File operations from the session */
	fileOps?: { readFiles: string[]; modifiedFiles: string[] };
	/** Active tasks from epsilon */
	tasks?: string;
	/** Key memories from delta */
	memories?: string;
	/** Git diff --stat output */
	gitDiff?: string;
}

/**
 * Gather enrichment context from external sources (epsilon, delta, git).
 * All calls run in parallel, are optional, and fail gracefully with timeouts.
 */
export async function gatherEnrichmentContext(): Promise<Omit<EnrichedContext, "fileOps">> {
	const result: Omit<EnrichedContext, "fileOps"> = {};

	const [tasksResult, memoriesResult, diffResult] = await Promise.allSettled([
		execFileAsync("phi_epsilon", ["backlog", "10"], { encoding: "utf-8", timeout: 2000 }),
		execFileAsync("phi_delta", ["search", "--importance", "3", "--limit", "10"], {
			encoding: "utf-8",
			timeout: 2000,
		}),
		execFileAsync("git", ["diff", "--stat", "HEAD"], { encoding: "utf-8", timeout: 2000 }),
	]);

	if (tasksResult.status === "fulfilled") {
		const tasks = tasksResult.value.stdout.trim();
		if (tasks) result.tasks = tasks;
	}

	if (memoriesResult.status === "fulfilled") {
		const memories = memoriesResult.value.stdout.trim();
		if (memories) result.memories = memories;
	}

	if (diffResult.status === "fulfilled") {
		const diff = diffResult.value.stdout.trim();
		if (diff) result.gitDiff = diff;
	}

	return result;
}

/**
 * Build the enrichment sections to append to the LLM prompt.
 */
export function formatEnrichmentSections(ctx: EnrichedContext): string {
	const sections: string[] = [];

	if (ctx.fileOps) {
		const { readFiles, modifiedFiles } = ctx.fileOps;
		if (modifiedFiles.length > 0 || readFiles.length > 0) {
			const lines: string[] = [];
			if (modifiedFiles.length > 0) {
				lines.push("Modified:");
				for (const f of modifiedFiles) lines.push(`- ${f}`);
			}
			if (readFiles.length > 0) {
				lines.push("Read-only:");
				for (const f of readFiles) lines.push(`- ${f}`);
			}
			sections.push(`## Files Touched This Session\n${lines.join("\n")}`);
		}
	}

	if (ctx.gitDiff) {
		sections.push(`## Uncommitted Changes\n\`\`\`\n${ctx.gitDiff}\n\`\`\``);
	}

	if (ctx.tasks) {
		sections.push(`## Active Tasks\n${ctx.tasks}`);
	}

	if (ctx.memories) {
		sections.push(`## Key Memories\n${ctx.memories}`);
	}

	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}
