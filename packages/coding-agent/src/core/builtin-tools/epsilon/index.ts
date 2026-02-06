/**
 * Epsilon — Task management lifecycle for Pi coding agent.
 *
 * Uses phi_epsilon shell script for all operations.
 * Lifecycle injects task context into system prompt.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============ Constants ============

/** Cached help text (loaded once from shell script) */
let cachedHelp: string | null = null;

// ============ Shell Script Path ============

function getPhiEpsilonPath(): string {
	const locations = [
		join(process.env.HOME || "", ".local/bin/phi_epsilon"),
		join(__dirname, "../../../../skills/epsilon/phi_epsilon"),
		"phi_epsilon",
	];

	for (const loc of locations) {
		if (loc === "phi_epsilon" || existsSync(loc)) {
			return loc;
		}
	}

	return "phi_epsilon";
}

function runEpsilon(args: string): string {
	try {
		const cmd = `${getPhiEpsilonPath()} ${args}`;
		return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
	} catch {
		return "";
	}
}

function getHelp(): string {
	if (cachedHelp === null) {
		cachedHelp = runEpsilon("help");
	}
	return cachedHelp;
}

// ============ Task Context ============

interface TaskSummary {
	total: number;
	todo: number;
	planned: number;
	inProgress: number;
	blocked: number;
	done: number;
	cancelled: number;
	active: Array<{ id: number; title: string; priority: string; tags: string }>;
}

function getTaskSummary(): TaskSummary {
	const summary: TaskSummary = {
		total: 0,
		todo: 0,
		planned: 0,
		inProgress: 0,
		blocked: 0,
		done: 0,
		cancelled: 0,
		active: [],
	};

	// Get counts from info
	const info = runEpsilon("info");
	const countMatch = info.match(
		/total\s+todo\s+planned\s+in_progress\s+blocked\s+done\s+cancelled\s*\n[-\s]+\n(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/,
	);
	if (countMatch) {
		summary.total = parseInt(countMatch[1], 10);
		summary.todo = parseInt(countMatch[2], 10);
		summary.planned = parseInt(countMatch[3], 10);
		summary.inProgress = parseInt(countMatch[4], 10);
		summary.blocked = parseInt(countMatch[5], 10);
		summary.done = parseInt(countMatch[6], 10);
		summary.cancelled = parseInt(countMatch[7], 10);
	}

	// Get active tasks (todo, planned, in_progress, blocked)
	const active = runEpsilon("list --limit 20");
	const lines = active.split("\n");

	for (const line of lines) {
		// Parse CLI output: "○ #42 [high] Task title [tag1,tag2]"
		const match = line.match(/^[○▣◐⊘✓✗]\s+#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\[([^\]]*)])?\s*$/);
		if (match) {
			summary.active.push({
				id: parseInt(match[1], 10),
				title: match[3].trim(),
				priority: match[2].trim(),
				tags: match[4]?.trim() ?? "",
			});
		}
	}

	return summary;
}

// ============ Prompt Building ============

function buildTasksPrompt(summary: TaskSummary): string {
	const lines: string[] = ["<epsilon_tasks>", ""];

	lines.push("## Task Tracking");
	lines.push(
		"Non-trivial changes (2+ files, features, refactors, bug fixes, schema/API) → create task first, set in_progress, mark done when finished.",
	);
	lines.push(
		"Trivial changes (single-file typo, formatting, comment) → no task needed. If it grows to 2+ files, create a task then continue.",
	);
	lines.push("");

	// CLI Reference
	const help = getHelp();
	if (help) {
		lines.push("## CLI Reference");
		lines.push("```");
		lines.push(help);
		lines.push("```");
		lines.push("");
	}

	// Overview
	lines.push("## Overview");
	lines.push(
		`Status: ${summary.todo} todo, ${summary.planned} planned, ${summary.inProgress} in progress, ${summary.blocked} blocked, ${summary.done} done`,
	);
	lines.push("");

	// Active tasks
	if (summary.active.length > 0) {
		lines.push("## Active Tasks");
		for (const task of summary.active) {
			const tagStr = task.tags ? ` [${task.tags}]` : "";
			lines.push(`  ${task.title}${tagStr}`);
		}
		lines.push("");
	}

	lines.push("</epsilon_tasks>");

	return lines.join("\n");
}

// ============ Lifecycle ============

export interface EpsilonLifecycle {
	onSessionShutdown(): void;
	onBeforeAgentStart(systemPrompt: string): { systemPrompt: string };
}

export function createEpsilonLifecycle(): EpsilonLifecycle {
	return {
		onSessionShutdown() {
			// No-op - shell script handles DB
		},

		onBeforeAgentStart(systemPrompt) {
			const summary = getTaskSummary();
			const addition = buildTasksPrompt(summary);
			return {
				systemPrompt: `${systemPrompt}\n\n${addition}`,
			};
		},
	};
}

// ============ Exports for backward compatibility ============

export function closeDb(): void {
	// No-op
}

export { getTaskSummary, buildTasksPrompt };
