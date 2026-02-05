/**
 * Sigma — Interactive questionnaire tool for Pi coding agent.
 *
 * Features:
 *   - Number keys (0–9) for direct option selection
 *   - C-n/C-p for option navigation, j/k for scrolling
 *   - Tab/Shift+Tab for multi-question tab navigation
 *   - "Type something" option is ALWAYS present
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "agent";
import type { Component, OverlayOptions, TUI } from "tui";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import { errorResult, extractLastAssistantMessages, formatAnswerLines, normalizeQuestions } from "./helpers.js";
import type { AskResult } from "./types.js";
import { createSigmaUI } from "./ui.js";

export type { Answer, AskResult, Question, QuestionOption } from "./types.js";
export { createSigmaUI } from "./ui.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(Type.String({ description: "Short contextual label for tab bar, defaults to Q1, Q2" })),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// ─── System Prompt ──────────────────────────────────────────────────────────

export const SIGMA_SYSTEM_PROMPT = `
## Sigma Tool — Usage Guidelines

You have access to the \`sigma\` tool for interactive user questions.

**When to use sigma:**

1. **Always use \`sigma\` to ask questions to the user, interview the user, and questionnaire the user.** It is the primary and mandatory tool for all user-facing questions.
2. **Use \`sigma\`** in case of unclarity/ambiguity, decision points, and when confident enough that there are better alternatives/recommendations/suggestions and out-of-the-box ideas.
3. **Ask category by category.** Group related questions together, don't overwhelm with too many at once.
4. **"Type something" is always available.** The user can always type a custom answer — you don't need to add it as an option.
`.trim();

// ─── UI Context Interface ───────────────────────────────────────────────────

/** Minimal UI context needed by sigma tool */
export interface SigmaUIContext {
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
}

// ─── Tool Definition ────────────────────────────────────────────────────────

/**
 * Create the sigma tool with access to session manager for context extraction.
 */
export function createSigmaTool(
	getSessionBranch: () => readonly unknown[],
	ui: SigmaUIContext,
): AgentTool<typeof AskParams> {
	return {
		name: "sigma",
		label: "Sigma",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: AskParams,

		async execute(
			_toolCallId: string,
			params: {
				questions: Array<{
					id: string;
					label?: string;
					prompt: string;
					options: Array<{ value: string; label: string; description?: string }>;
				}>;
			},
			_signal?: AbortSignal,
			_onUpdate?: unknown,
		): Promise<AgentToolResult<AskResult | undefined>> {
			if (!ui.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalizeQuestions(params.questions);

			// Extract last 2 assistant messages for context (newest first)
			const branch = getSessionBranch();
			const contextMessages = extractLastAssistantMessages(branch, 2);

			const result = await ui.custom<AskResult>(
				(tui, theme, _kb, done) => createSigmaUI(tui, theme, done, questions, contextMessages),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "80%",
						minWidth: 50,
						maxHeight: "85%",
						margin: 2,
					},
				},
			);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: formatAnswerLines(result.answers, questions).join("\n") }],
				details: result,
			};
		},
	};
}
