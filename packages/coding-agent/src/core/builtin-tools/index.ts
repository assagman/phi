/**
 * Builtin tools — Core functionality for Pi coding agent.
 *
 * Exports:
 * - Delta: Persistent memory lifecycle (shell-based)
 * - Epsilon: Task management lifecycle (shell-based)
 * - Sigma: Interactive questionnaire (tool)
 * - Handoff: Context transfer to new sessions (tool)
 *
 * Note: Delta and epsilon now use shell scripts (phi_delta, phi_epsilon).
 * The lifecycles inject context into system prompt but don't register tools.
 */

// ─── Delta (Memory) ─────────────────────────────────────────────────────────
export {
	closeDb as closeDeltaDb,
	createDeltaLifecycle,
	type DeltaLifecycle,
	resetSession as resetDeltaSession,
} from "./delta/index.js";

// ─── Epsilon (Tasks) ─────────────────────────────────────────────────────────
export {
	buildTasksPrompt,
	closeDb as closeEpsilonDb,
	createEpsilonLifecycle,
	type EpsilonLifecycle,
	getTaskSummary,
} from "./epsilon/index.js";
export type { HandoffToolContext, HandoffUIContext } from "./handoff/index.js";
// ─── Handoff (Context Transfer) ──────────────────────────────────────────────
export { createHandoffTool, HandoffCommand } from "./handoff/index.js";
export type { Answer, AskResult, Question, QuestionOption, SigmaUIContext } from "./sigma/index.js";
// ─── Sigma (Questionnaire) ───────────────────────────────────────────────────
export { createSigmaTool, createSigmaUI, SIGMA_SYSTEM_PROMPT } from "./sigma/index.js";
// ─── Storage ─────────────────────────────────────────────────────────────────
export { getBuiltinDbPath, getDataDir, getRepoIdentifier } from "./storage.js";
export type { SubagentToolContext } from "./subagent/index.js";
// ─── Subagent (Agent Delegation) ─────────────────────────────────────────────
export {
	type AgentDefinition,
	type AgentRegistry,
	clearRegistryCache as clearSubagentRegistryCache,
	createAgentRegistry,
	createSubagentTool,
} from "./subagent/index.js";

// ─── Combined Lifecycle ──────────────────────────────────────────────────────

import type { AgentTool } from "agent";
import type { Component, OverlayOptions, TUI } from "tui";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { DELEGATION_BLOCK } from "../system-prompt.js";
import { createDeltaLifecycle } from "./delta/index.js";
import { createEpsilonLifecycle } from "./epsilon/index.js";
import { createHandoffTool, type HandoffToolContext } from "./handoff/index.js";
import { createSigmaTool, SIGMA_SYSTEM_PROMPT } from "./sigma/index.js";
import { createSubagentTool, type SubagentToolContext } from "./subagent/index.js";

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
	/** Subagent tool context */
	subagentContext: SubagentToolContext;
}

export interface BuiltinToolsLifecycle {
	/** All builtin tools (sigma, handoff only - delta/epsilon use shell scripts) */
	tools: AgentTool<any>[];
	/** The mutable UI context (for interactive mode to populate) */
	ui: BuiltinToolUIContext;
	/** The mutable handoff context (for interactive mode to populate) */
	handoff: HandoffToolContext;
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
 *
 * Tools registered: sigma, handoff, subagent
 * Lifecycles (no tools, just prompt injection): delta, epsilon
 */
export function createBuiltinToolsLifecycle(config: BuiltinToolsConfig): BuiltinToolsLifecycle {
	const deltaLifecycle = createDeltaLifecycle();
	const epsilonLifecycle = createEpsilonLifecycle();

	// Create tools
	const sigmaTool = createSigmaTool(config.getSessionBranch, config.ui);
	const handoffTool = createHandoffTool(config.handoffContext, config.ui);
	// Subagent no longer uses UI overlay - runs inline with status updates
	const subagentTool = createSubagentTool(config.subagentContext);

	// Registered tools: sigma, handoff, subagent
	// Delta and epsilon are accessed via bash: phi_delta, phi_epsilon
	const tools: AgentTool<any>[] = [sigmaTool, handoffTool, subagentTool];

	return {
		tools,
		ui: config.ui,
		handoff: config.handoffContext,

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

			// Add sigma instructions, then delegation rules last (recency bias)
			const finalPrompt = `${epsilonResult.systemPrompt}\n\n${SIGMA_SYSTEM_PROMPT}\n${DELEGATION_BLOCK}`;

			return {
				systemPrompt: finalPrompt,
				message: deltaResult.message, // Delta's welcome or nudge message
			};
		},
	};
}
