/**
 * Delta — Persistent memory builtin for Pi coding agent.
 *
 * Features:
 * - Unified memory with tags, importance, FTS5 full-text search
 * - Idle nudge after N turns without memory writes
 * - Auto-capture git commits as memories
 * - Session write stats in system prompt
 */

export { buildMemoryPrompt, closeDb, getMemoryContext, logEpisode, resetSession } from "./db.js";
export { deltaTools } from "./tools.js";

import { buildMemoryPrompt, closeDb, getMemoryContext, logEpisode, resetSession } from "./db.js";

// ============ Constants ============

/** Delta write tools that count toward session activity */
const DELTA_WRITE_TOOLS = new Set(["delta_remember", "delta_remember_bulk"]);

/** Turns of inactivity before injecting a nudge message */
const IDLE_THRESHOLD = 4;

/** Minimum turns between consecutive nudge messages */
const NUDGE_COOLDOWN = 4;

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

// ============ Helper Functions ============

function isBashToolResult(event: {
	toolName: string;
	input: unknown;
}): event is { toolName: string; input: { command?: string }; content: Array<{ type: string; text?: string }> } {
	return event.toolName === "Bash" || event.toolName === "bash";
}

// ============ Lifecycle Management ============

export interface DeltaLifecycle {
	/** Call on session start to reset state */
	onSessionStart(): void;
	/** Call on session shutdown to close DB */
	onSessionShutdown(): void;
	/** Call on tool_call event to track writes */
	onToolCall(event: { toolName: string }): void;
	/** Call on tool_result event to detect git commits */
	onToolResult(event: { toolName: string; input: unknown; content: Array<{ type: string; text?: string }> }): void;
	/** Call before agent starts to get system prompt addition and optional message */
	onBeforeAgentStart(systemPrompt: string): {
		systemPrompt: string;
		message?: { customType: string; content: string; display: boolean };
	};
}

/**
 * Create the delta lifecycle manager.
 */
export function createDeltaLifecycle(): DeltaLifecycle {
	return {
		onSessionStart() {
			resetState();
			resetSession();
		},

		onSessionShutdown() {
			closeDb();
		},

		onToolCall(event) {
			if (DELTA_WRITE_TOOLS.has(event.toolName)) {
				trackWrite();
			}
		},

		onToolResult(event) {
			if (!isBashToolResult(event)) return;

			const command = String(event.input.command ?? "");
			if (!GIT_COMMIT_RE.test(command)) return;

			const output = event.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("");

			const info = extractCommitInfo(output);
			if (info) {
				logEpisode(info, "git", ["commit", "auto-captured"]);
				trackWrite();
			}
		},

		onBeforeAgentStart(systemPrompt) {
			turnCount++;

			const ctx = getMemoryContext();

			// Build memory prompt
			const prompt = buildMemoryPrompt({
				ctx,
				sessionWrites: sessionWriteCount,
				turnsIdle: turnsIdle(),
			});

			const result: {
				systemPrompt: string;
				message?: { customType: string; content: string; display: boolean };
			} = {
				systemPrompt: `${systemPrompt}\n\n${prompt}`,
			};

			// First turn: hidden welcome message
			if (!firstTurnDone) {
				firstTurnDone = true;
				result.message = {
					customType: "delta-memory",
					content: buildWelcomeMessage(ctx),
					display: false,
				};
			}
			// Idle nudge: hidden reminder after sustained inactivity
			else if (shouldNudge()) {
				lastNudgeTurn = turnCount;
				result.message = {
					customType: "delta-nudge",
					content: `⚠ No memory writes in ${turnsIdle()} turns. If you've made decisions, found bugs, or learned patterns — use delta_remember(content, tags) to persist them.`,
					display: false,
				};
			}

			return result;
		},
	};
}

// ============ Helpers ============

function buildWelcomeMessage(ctx: ReturnType<typeof getMemoryContext>): string {
	const lines: string[] = [];

	lines.push("🧠 Delta memory loaded. Use delta_remember() to persist knowledge, delta_search() to recall.");
	lines.push("");

	if (ctx.total > 0) {
		lines.push(`Memory: ${ctx.total} memories (${ctx.important.length} high/critical)`);
		lines.push("Use delta_search(query) to find relevant memories.");
	} else {
		lines.push("Memory is empty — start logging discoveries and decisions.");
	}

	return lines.join("\n");
}
