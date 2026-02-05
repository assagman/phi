/**
 * Handoff — Context transfer builtin for Pi coding agent.
 *
 * Transfers context to a new focused session instead of compacting.
 * Available as both /handoff slash command AND a tool.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   Or via tool: handoff({ goal: "implement teams feature" })
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "agent";
import type { Model } from "ai";
import { completeSimple, type Message } from "ai";
import { extensionsLog } from "../../../utils/logger.js";
import { HANDOFF_SYSTEM_PROMPT } from "./command.js";
import {
	type EnrichedContext,
	formatEnrichmentSections,
	gatherEnrichmentContext,
	truncateForSummarization,
} from "./utils.js";

export { HANDOFF_SYSTEM_PROMPT, HandoffCommand } from "./command.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

const HandoffParams = Type.Object({
	goal: Type.String({ description: "The goal or focus for the new session" }),
});

// ─── UI Context Interface ───────────────────────────────────────────────────

/** Minimal UI context needed by handoff tool */
export interface HandoffUIContext {
	/** Whether UI is available (false in print/RPC mode) */
	hasUI: boolean;
}

// ─── Tool Context ───────────────────────────────────────────────────────────

export interface HandoffToolContext {
	getModel(): Model<any> | undefined;
	getApiKey(model: Model<any>): Promise<string>;
	getConversationText(): string;
	/** Get file operations (read/modified) from the current session */
	getFileOperations(): { readFiles: string[]; modifiedFiles: string[] };
	getCurrentSessionFile(): string | undefined;
	createNewSession(opts: { parentSession?: string }): Promise<{ cancelled: boolean }>;
	setEditorText(text: string): void;
	/** Send message to start agent loop (for auto-submit in tool mode) */
	sendMessage(text: string): Promise<void>;
}

// ─── Result Details ─────────────────────────────────────────────────────────

interface HandoffResult {
	cancelled?: boolean;
	prompt?: string;
}

// ─── Tool Definition ────────────────────────────────────────────────────────

/**
 * Create the handoff tool.
 */
export function createHandoffTool(context: HandoffToolContext, ui: HandoffUIContext): AgentTool<typeof HandoffParams> {
	return {
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused session. Use when the current thread is getting long or when pivoting to a new task that would benefit from a fresh start with curated context.",
		parameters: HandoffParams,

		async execute(
			_toolCallId: string,
			params: { goal: string },
			signal?: AbortSignal,
			_onUpdate?: unknown,
		): Promise<AgentToolResult<HandoffResult>> {
			if (!ui.hasUI) {
				return {
					content: [{ type: "text", text: "Error: handoff requires interactive mode" }],
					details: { cancelled: true },
				};
			}

			const model = context.getModel();
			if (!model) {
				return {
					content: [{ type: "text", text: "Error: No model selected" }],
					details: { cancelled: true },
				};
			}

			const conversationText = context.getConversationText();
			if (!conversationText) {
				return {
					content: [{ type: "text", text: "Error: No conversation to hand off" }],
					details: { cancelled: true },
				};
			}

			const currentSessionFile = context.getCurrentSessionFile();

			// Generate the handoff prompt silently (no UI)
			let result: string;
			try {
				const apiKey = await context.getApiKey(model);

				// Truncate conversation to fit model context window
				const truncatedText = truncateForSummarization(conversationText, model);

				// Gather enrichment context (file ops, tasks, memories, git)
				const enrichment: EnrichedContext = {
					fileOps: context.getFileOperations(),
					...(await gatherEnrichmentContext()),
				};
				const enrichmentText = formatEnrichmentSections(enrichment);

				const userMessage: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: `## Conversation History\n\n${truncatedText}${enrichmentText}\n\n## User's Goal for New Thread\n\n${params.goal}`,
						},
					],
					timestamp: Date.now(),
				};

				const response = await completeSimple(
					model,
					{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey, signal, maxTokens: 4096 },
				);

				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text", text: "Handoff aborted" }],
						details: { cancelled: true },
					};
				}

				result = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			} catch (err: unknown) {
				extensionsLog.error("Handoff generation failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				return {
					content: [{ type: "text", text: `Handoff failed: ${err instanceof Error ? err.message : String(err)}` }],
					details: { cancelled: true },
				};
			}

			// Create new session with parent tracking
			const newSessionResult = await context.createNewSession({
				parentSession: currentSessionFile,
			});

			if (newSessionResult.cancelled) {
				return {
					content: [{ type: "text", text: "New session cancelled" }],
					details: { cancelled: true },
				};
			}

			// Auto-submit the handoff prompt to start the new session
			await context.sendMessage(result);

			return {
				content: [{ type: "text", text: "Handoff complete. New session started." }],
				details: { prompt: result },
			};
		},
	};
}
