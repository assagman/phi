/**
 * Builtin tools — Core functionality for Pi coding agent.
 *
 * Exports:
 * - Delta: Persistent memory system
 * - Epsilon: Task management
 * - Sigma: Interactive questionnaire
 * - Handoff: Context transfer to new sessions
 */

// ─── Delta (Memory) ─────────────────────────────────────────────────────────
export {
	buildMemoryPrompt,
	closeDb as closeDeltaDb,
	createDeltaLifecycle,
	type DeltaLifecycle,
	getMemoryContext,
	resetSession as resetDeltaSession,
} from "./delta/index.js";
export { deltaForget, deltaRemember, deltaSearch, deltaTools } from "./delta/tools.js";
// ─── Epsilon (Tasks) ─────────────────────────────────────────────────────────
export {
	buildTasksPrompt,
	closeDb as closeEpsilonDb,
	createEpsilonLifecycle,
	type EpsilonLifecycle,
	getTaskSummary,
} from "./epsilon/index.js";
export { epsilonTools } from "./epsilon/tools.js";
export type { HandoffToolContext, HandoffUIContext } from "./handoff/index.js";
// ─── Handoff (Context Transfer) ──────────────────────────────────────────────
export { createHandoffTool, HandoffCommand } from "./handoff/index.js";
export type { Answer, AskResult, Question, QuestionOption, SigmaUIContext } from "./sigma/index.js";
// ─── Sigma (Questionnaire) ───────────────────────────────────────────────────
export { createSigmaTool, createSigmaUI, SIGMA_SYSTEM_PROMPT } from "./sigma/index.js";

// ─── Storage ─────────────────────────────────────────────────────────────────
export { getBuiltinDbPath, getDataDir, getRepoIdentifier } from "./storage.js";

// ─── Combined Lifecycle ──────────────────────────────────────────────────────

import type { AgentTool } from "agent";
import type { Component, OverlayOptions, TUI } from "tui";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { createDeltaLifecycle } from "./delta/index.js";
import { deltaTools } from "./delta/tools.js";
import { createEpsilonLifecycle } from "./epsilon/index.js";
import { epsilonTools } from "./epsilon/tools.js";
import { createHandoffTool, type HandoffToolContext } from "./handoff/index.js";
import { createSigmaTool, SIGMA_SYSTEM_PROMPT } from "./sigma/index.js";

/**
 * Minimal UI context needed by builtin tools.
 * This is a mutable holder - initially hasUI=false, interactive mode sets it to true and provides implementations.
 */
export interface BuiltinToolUIContext {
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

/**
 * Create a mutable UI context holder.
 * Starts with hasUI=false and stub implementations.
 * Interactive mode should call setUI() to provide real implementations.
 */
export function createBuiltinUIContext(): BuiltinToolUIContext {
	return {
		hasUI: false,
		async custom<T>(): Promise<T> {
			throw new Error("UI not available (running in non-interactive mode)");
		},
		async editor(): Promise<string | undefined> {
			return undefined;
		},
	};
}

export interface BuiltinToolsConfig {
	/** Get session branch for sigma context extraction */
	getSessionBranch: () => readonly unknown[];
	/** Mutable UI context - interactive mode will populate this */
	ui: BuiltinToolUIContext;
	/** Handoff tool context */
	handoffContext: HandoffToolContext;
}

export interface BuiltinToolsLifecycle {
	/** All builtin tools */
	tools: AgentTool<any>[];
	/** The mutable UI context (for interactive mode to populate) */
	ui: BuiltinToolUIContext;
	/** Call on session start */
	onSessionStart(): void;
	/** Call on session shutdown */
	onSessionShutdown(): void;
	/** Call on tool_call event */
	onToolCall(event: { toolName: string }): void;
	/** Call on tool_result event */
	onToolResult(event: { toolName: string; input: unknown; content: Array<{ type: string; text?: string }> }): void;
	/** Call before agent starts to modify system prompt */
	onBeforeAgentStart(systemPrompt: string): {
		systemPrompt: string;
		message?: { customType: string; content: string; display: boolean };
	};
}

/**
 * Create the combined lifecycle manager for all builtin tools.
 */
export function createBuiltinToolsLifecycle(config: BuiltinToolsConfig): BuiltinToolsLifecycle {
	const deltaLifecycle = createDeltaLifecycle();
	const epsilonLifecycle = createEpsilonLifecycle();

	// Create tools - pass UI context via closure (tools check hasUI at runtime)
	const sigmaTool = createSigmaTool(config.getSessionBranch, config.ui);
	const handoffTool = createHandoffTool(config.handoffContext, config.ui);

	const tools: AgentTool<any>[] = [...deltaTools, ...epsilonTools, sigmaTool, handoffTool];

	return {
		tools,
		ui: config.ui,

		onSessionStart() {
			deltaLifecycle.onSessionStart();
		},

		onSessionShutdown() {
			deltaLifecycle.onSessionShutdown();
			epsilonLifecycle.onSessionShutdown();
		},

		onToolCall(event) {
			deltaLifecycle.onToolCall(event);
		},

		onToolResult(event) {
			deltaLifecycle.onToolResult(event);
		},

		onBeforeAgentStart(systemPrompt) {
			// Apply delta first (adds memory context)
			const deltaResult = deltaLifecycle.onBeforeAgentStart(systemPrompt);

			// Apply epsilon (adds task context)
			const epsilonResult = epsilonLifecycle.onBeforeAgentStart(deltaResult.systemPrompt);

			// Add sigma instructions
			const finalPrompt = `${epsilonResult.systemPrompt}\n\n${SIGMA_SYSTEM_PROMPT}`;

			return {
				systemPrompt: finalPrompt,
				message: deltaResult.message, // Delta's welcome or nudge message
			};
		},
	};
}
