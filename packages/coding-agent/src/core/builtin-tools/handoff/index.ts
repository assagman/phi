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
import { complete, type Message } from "ai";
import type { Component, OverlayOptions, TUI } from "tui";
import { BorderedLoader } from "../../../modes/interactive/components/bordered-loader.js";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import { extensionsLog } from "../../../utils/logger.js";

export { HandoffCommand } from "./command.js";

// ─── System Prompt ──────────────────────────────────────────────────────────

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

// ─── Schema ─────────────────────────────────────────────────────────────────

const HandoffParams = Type.Object({
	goal: Type.String({ description: "The goal or focus for the new session" }),
});

// ─── UI Context Interface ───────────────────────────────────────────────────

/** Minimal UI context needed by handoff tool */
export interface HandoffUIContext {
	/** Whether UI is available (false in print/RPC mode) */
	hasUI: boolean;
	/** Show a custom component with keyboard focus */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: unknown,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
		},
	): Promise<T>;
	/** Show a multi-line editor for text editing */
	editor(title: string, prefill?: string): Promise<string | undefined>;
}

// ─── Tool Context ───────────────────────────────────────────────────────────

export interface HandoffToolContext {
	getModel(): Model<any> | undefined;
	getApiKey(model: Model<any>): Promise<string>;
	getConversationText(): string;
	getCurrentSessionFile(): string | undefined;
	createNewSession(opts: { parentSession?: string }): Promise<{ cancelled: boolean }>;
	setEditorText(text: string): void;
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

			// Generate the handoff prompt with loader UI
			const result = await ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
					loader.onAbort = () => done(null);

					const doGenerate = async () => {
						const apiKey = await context.getApiKey(model);

						const userMessage: Message = {
							role: "user",
							content: [
								{
									type: "text",
									text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${params.goal}`,
								},
							],
							timestamp: Date.now(),
						};

						const response = await complete(
							model,
							{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
							{ apiKey, signal: signal ?? loader.signal },
						);

						if (response.stopReason === "aborted") {
							return null;
						}

						return response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
					};

					doGenerate()
						.then(done)
						.catch((err: unknown) => {
							// Log error instead of console.error to avoid leaking implementation details (#379)
							extensionsLog.error("Handoff generation failed", {
								error: err instanceof Error ? err.message : String(err),
							});
							done(null);
						});

					return loader;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: 60,
						minWidth: 40,
						maxHeight: 10,
						margin: 2,
					},
				},
			);

			if (result === null) {
				return {
					content: [{ type: "text", text: "Handoff cancelled" }],
					details: { cancelled: true },
				};
			}

			// Let user edit the generated prompt
			const editedPrompt = await ui.editor("Edit handoff prompt", result);

			if (editedPrompt === undefined) {
				return {
					content: [{ type: "text", text: "Handoff cancelled" }],
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

			// Set the edited prompt in the main editor for submission
			context.setEditorText(editedPrompt);

			return {
				content: [{ type: "text", text: "Handoff ready. Submit when ready." }],
				details: { prompt: editedPrompt },
			};
		},
	};
}
