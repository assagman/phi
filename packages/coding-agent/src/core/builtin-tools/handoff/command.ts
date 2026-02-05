/**
 * Handoff slash command — /handoff <goal>
 *
 * Transfers context to a new focused session.
 */

import { completeSimple, type Message, type Model } from "ai";
import type { Component, TUI } from "tui";
import { BorderedLoader } from "../../../modes/interactive/components/bordered-loader.js";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import { extensionsLog } from "../../../utils/logger.js";
import {
	type EnrichedContext,
	formatEnrichmentSections,
	gatherEnrichmentContext,
	truncateForSummarization,
} from "./utils.js";

// ─── System Prompt ──────────────────────────────────────────────────────────

export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal, generate a focused prompt for a new coding session.

Output EXACTLY this structure (no preamble, no wrapping):

## Context
[2-5 sentences: what was being worked on, key decisions made, current state]

## Key Files
[Bulleted list of files that matter for the next task, with one-line descriptions]

## Decisions & Constraints
[Bulleted list of decisions already made that the new session must respect]

## Task
[Clear, actionable description of what to do next based on the user's goal]

Rules:
- Be concise. The new session has no prior context.
- Include file paths when referencing code.
- Do not include information irrelevant to the stated goal.
- Do not explain what you are doing. Output only the prompt.`;

// ─── Command Context ────────────────────────────────────────────────────────

export interface HandoffCommandContext {
	/** Check if UI is available */
	hasUI: boolean;
	/** Get current model */
	getModel(): Model<any> | undefined;
	/** Get API key for model */
	getApiKey(model: Model<any>): Promise<string>;
	/** Get serialized conversation text */
	getConversationText(): string;
	/** Get file operations (read/modified) from the current session */
	getFileOperations(): { readFiles: string[]; modifiedFiles: string[] };
	/** Get current session file path */
	getCurrentSessionFile(): string | undefined;
	/** Create new session */
	createNewSession(opts: { parentSession?: string }): Promise<{ cancelled: boolean }>;
	/** Set editor text */
	setEditorText(text: string): void;
	/** Show notification */
	notify(message: string, type: "info" | "error" | "success" | "warning"): void;
	/** Show custom UI overlay */
	showCustomUI<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: unknown,
			done: (result: T) => void,
		) => Component & { dispose?(): void },
		options?: {
			overlay?: boolean;
			overlayOptions?: {
				anchor?: string;
				width?: number | string;
				minWidth?: number;
				maxHeight?: number | string;
				margin?: number;
			};
		},
	): Promise<T>;
	/** Show editor for text editing */
	showEditor(title: string, initialValue: string): Promise<string | undefined>;
}

// ─── Command ────────────────────────────────────────────────────────────────

export const HandoffCommand = {
	name: "handoff",
	description: "Transfer context to a new focused session",

	async handler(args: string, ctx: HandoffCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.notify("handoff requires interactive mode", "error");
			return;
		}

		const model = ctx.getModel();
		if (!model) {
			ctx.notify("No model selected", "error");
			return;
		}

		const goal = args.trim();
		if (!goal) {
			ctx.notify("Usage: /handoff <goal for new thread>", "error");
			return;
		}

		const conversationText = ctx.getConversationText();
		if (!conversationText) {
			ctx.notify("No conversation to hand off", "error");
			return;
		}

		const currentSessionFile = ctx.getCurrentSessionFile();

		// Truncate conversation to fit model context window
		const truncatedText = truncateForSummarization(conversationText, model);

		// Gather enrichment context (file ops, tasks, memories, git)
		const enrichment: EnrichedContext = {
			fileOps: ctx.getFileOperations(),
			...(await gatherEnrichmentContext()),
		};
		const enrichmentText = formatEnrichmentSections(enrichment);

		// Generate the handoff prompt with loader UI
		const result = await ctx.showCustomUI<string | null>(
			(tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const apiKey = await ctx.getApiKey(model);

					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text: `## Conversation History\n\n${truncatedText}${enrichmentText}\n\n## User's Goal for New Thread\n\n${goal}`,
							},
						],
						timestamp: Date.now(),
					};

					const response = await completeSimple(
						model,
						{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey, signal: loader.signal, maxTokens: 4096 },
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
			ctx.notify("Cancelled", "info");
			return;
		}

		// Let user edit the generated prompt
		const editedPrompt = await ctx.showEditor("Edit handoff prompt", result);

		if (editedPrompt === undefined) {
			ctx.notify("Cancelled", "info");
			return;
		}

		// Create new session with parent tracking
		const newSessionResult = await ctx.createNewSession({
			parentSession: currentSessionFile,
		});

		if (newSessionResult.cancelled) {
			ctx.notify("New session cancelled", "info");
			return;
		}

		// Set the edited prompt in the main editor for submission
		ctx.setEditorText(editedPrompt);
		ctx.notify("Handoff ready. Submit when ready.", "info");
	},
};
