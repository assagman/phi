/**
 * Delta — Persistent memory lifecycle for Pi coding agent.
 *
 * Uses phi_delta shell script for all operations.
 * Lifecycle injects memory context into system prompt.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============ Constants ============

/** Delta write tools (shell script calls via bash) */
const DELTA_WRITE_PATTERNS = ["phi_delta remember", "phi_delta tag"];

/** Turns of inactivity before injecting a nudge message */
const IDLE_THRESHOLD = 4;

/** Minimum turns between consecutive nudge messages */
const NUDGE_COOLDOWN = 4;

/** Cached help text (loaded once from shell script) */
let cachedHelp: string | null = null;

// ============ Shell Script Path ============

function getPhiDeltaPath(): string {
	// Check common locations
	const locations = [
		join(process.env.HOME || "", ".local/bin/phi_delta"),
		join(__dirname, "../../../../skills/delta/phi_delta"),
		"phi_delta", // In PATH
	];

	for (const loc of locations) {
		if (loc === "phi_delta" || existsSync(loc)) {
			return loc;
		}
	}

	return "phi_delta"; // Fallback to PATH
}

function runDelta(args: string): string {
	try {
		const cmd = `${getPhiDeltaPath()} ${args}`;
		return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
	} catch {
		return "";
	}
}

function getHelp(): string {
	if (cachedHelp === null) {
		cachedHelp = runDelta("help");
	}
	return cachedHelp;
}

// ============ Session State ============

let turnCount = 0;
let lastWriteTurn = 0;
let sessionWriteCount = 0;
let firstTurnDone = false;
let lastNudgeTurn = 0;

function resetState(): void {
	turnCount = 0;
	lastWriteTurn = 0;
	sessionWriteCount = 0;
	firstTurnDone = false;
	lastNudgeTurn = 0;
}

function trackWrite(): void {
	lastWriteTurn = turnCount;
	sessionWriteCount++;
}

function turnsIdle(): number {
	return turnCount - lastWriteTurn;
}

function shouldNudge(): boolean {
	return turnCount > 3 && turnsIdle() >= IDLE_THRESHOLD && turnCount - lastNudgeTurn >= NUDGE_COOLDOWN;
}

// ============ Git Commit Detection ============

const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const COMMIT_HEADER_RE = /\[(\S+)\s+([a-f0-9]+)\]\s*(.*)/;
const COMMIT_STATS_RE = /(\d+)\s+files?\s+changed[^\n]*/;

function extractCommitInfo(output: string): string | null {
	const header = output.match(COMMIT_HEADER_RE);
	if (!header) return null;

	const [, branch, hash, message] = header;
	const stats = output.match(COMMIT_STATS_RE);
	const statsStr = stats ? ` (${stats[0]})` : "";
	return `Commit ${hash} on ${branch}: ${message}${statsStr}`;
}

// ============ Memory Context ============

interface MemoryContext {
	total: number;
	critical: Array<{ id: number; content: string; tags: string; importance: string }>;
	categories: Map<string, number>;
}

function getMemoryContext(): MemoryContext {
	const ctx: MemoryContext = {
		total: 0,
		critical: [],
		categories: new Map(),
	};

	// Get info for total count
	const info = runDelta("info");
	const memMatch = info.match(/memories\s+tags\s+tag_links\s*\n[-\s]+\n(\d+)/);
	if (memMatch) {
		ctx.total = parseInt(memMatch[1], 10);
	}

	// Get critical/high importance memories
	const critical = runDelta("search --importance 4 --limit 20");
	const high = runDelta("search --importance 3 --limit 30");

	// Parse search output (table format)
	const parseSearchOutput = (output: string, importance: string) => {
		const lines = output.split("\n").slice(2); // Skip header and separator
		for (const line of lines) {
			const match = line.match(/^(\d+)\s+\w+\s+([\w,\s]*)\s+(.+?)\s+\d{4}-/);
			if (match) {
				ctx.critical.push({
					id: parseInt(match[1], 10),
					importance,
					tags: match[2].trim(),
					content: match[3].trim(),
				});
			}
		}
	};

	parseSearchOutput(critical, "critical");
	parseSearchOutput(high, "high");

	// Get tag categories
	const tags = runDelta("tags");
	const tagLines = tags.split("\n").slice(2);
	for (const line of tagLines) {
		const match = line.match(/^\d+\s+(\w+)\s+(\d+)/);
		if (match) {
			ctx.categories.set(match[1], parseInt(match[2], 10));
		}
	}

	return ctx;
}

// ============ Prompt Building ============

function buildMemoryPrompt(ctx: MemoryContext, sessionWrites: number, idle: number): string {
	const lines: string[] = ["<delta_memory>", ""];

	// Header
	lines.push("## Memory (mandatory)");
	lines.push('- **BEFORE** work: `phi_delta search "query"` to check past context');
	lines.push('- **AFTER** decisions, bugs, patterns: `phi_delta remember "content" --importance N` to persist');
	lines.push(`- Status: ${sessionWrites} writes this session · ${idle} turns idle`);
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

	// Critical memories
	if (ctx.critical.length > 0) {
		lines.push("## Critical Knowledge (auto-loaded)");
		lines.push("");
		for (const mem of ctx.critical.slice(0, 15)) {
			const tagStr = mem.tags ? ` {${mem.tags}}` : "";
			lines.push(`### Memory #${mem.id} [${mem.importance.toUpperCase()}]${tagStr}`);
			lines.push(mem.content);
			lines.push("");
		}
	}

	// Memory map
	if (ctx.categories.size > 0) {
		lines.push("## Memory Map");
		const cats: string[] = [];
		for (const [tag, count] of ctx.categories) {
			cats.push(`  ${tag}: ${count}`);
		}
		lines.push(cats.slice(0, 10).join("\n"));
		lines.push("");
	}

	lines.push("</delta_memory>");

	return lines.join("\n");
}

// ============ Lifecycle ============

export interface DeltaLifecycle {
	onSessionStart(): void;
	onSessionShutdown(): void;
	onToolCall(event: { toolName: string }): void;
	onToolResult(event: { toolName: string; input: unknown; content: Array<{ type: string; text?: string }> }): void;
	onBeforeAgentStart(systemPrompt: string): {
		systemPrompt: string;
		message?: { customType: string; content: string; display: boolean };
	};
}

export function createDeltaLifecycle(): DeltaLifecycle {
	return {
		onSessionStart() {
			resetState();
		},

		onSessionShutdown() {
			// No DB to close - shell script handles it
		},

		onToolCall(event) {
			// Track bash calls that use phi_delta write commands
			if (event.toolName === "Bash" || event.toolName === "bash") {
				// Will check command in onToolResult
			}
		},

		onToolResult(event) {
			// Check for phi_delta writes via bash
			if (event.toolName === "Bash" || event.toolName === "bash") {
				const input = event.input as { command?: string } | undefined;
				const command = String(input?.command ?? "");

				// Track delta writes
				if (DELTA_WRITE_PATTERNS.some((p) => command.includes(p))) {
					trackWrite();
				}

				// Auto-capture git commits
				if (GIT_COMMIT_RE.test(command)) {
					const output = event.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
						.map((c) => c.text)
						.join("");

					const info = extractCommitInfo(output);
					if (info) {
						runDelta(`remember "${info.replace(/"/g, '\\"')}" --importance 2 --context "auto-captured"`);
						trackWrite();
					}
				}
			}
		},

		onBeforeAgentStart(systemPrompt) {
			turnCount++;

			const ctx = getMemoryContext();
			const prompt = buildMemoryPrompt(ctx, sessionWriteCount, turnsIdle());

			const result: {
				systemPrompt: string;
				message?: { customType: string; content: string; display: boolean };
			} = {
				systemPrompt: `${systemPrompt}\n\n${prompt}`,
			};

			// First turn: welcome message
			if (!firstTurnDone) {
				firstTurnDone = true;
				const memInfo = ctx.total > 0 ? `${ctx.total} memories (${ctx.critical.length} high/critical)` : "empty";
				result.message = {
					customType: "delta-memory",
					content: `🧠 Delta memory loaded. Memory: ${memInfo}\nUse \`phi_delta search "query"\` to find relevant memories.`,
					display: false,
				};
			}
			// Idle nudge
			else if (shouldNudge()) {
				lastNudgeTurn = turnCount;
				result.message = {
					customType: "delta-nudge",
					content: `⚠ No memory writes in ${turnsIdle()} turns. If you've made decisions, found bugs, or learned patterns — use \`phi_delta remember "content" --importance N\` to persist them.`,
					display: false,
				};
			}

			return result;
		},
	};
}

// ============ Exports for backward compatibility ============

export function closeDb(): void {
	// No-op - shell script handles DB
}

export function resetSession(): void {
	resetState();
}

export function getMemoryContext_compat(): MemoryContext {
	return getMemoryContext();
}

export function buildMemoryPrompt_compat(opts: {
	ctx: MemoryContext;
	sessionWrites: number;
	turnsIdle: number;
}): string {
	return buildMemoryPrompt(opts.ctx, opts.sessionWrites, opts.turnsIdle);
}

// Re-export with original names for compatibility
export { getMemoryContext_compat as getMemoryContextFn, buildMemoryPrompt_compat as buildMemoryPromptFn };
