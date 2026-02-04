/**
 * Epsilon — Task management builtin for Pi coding agent.
 *
 * Provides task CRUD with subtasks, priorities, statuses, and tags.
 */

export { buildTasksPrompt, closeDb, getTaskSummary } from "./db.js";
export { epsilonTools } from "./tools.js";

import { buildTasksPrompt, closeDb, getTaskSummary } from "./db.js";

// ============ Lifecycle Management ============

export interface EpsilonLifecycle {
	/** Call on session shutdown to close DB */
	onSessionShutdown(): void;
	/** Call before agent starts to get system prompt addition */
	onBeforeAgentStart(systemPrompt: string): { systemPrompt: string };
}

/**
 * Create the epsilon lifecycle manager.
 */
export function createEpsilonLifecycle(): EpsilonLifecycle {
	return {
		onSessionShutdown() {
			closeDb();
		},

		onBeforeAgentStart(systemPrompt) {
			const summary = getTaskSummary();
			const addition = buildTasksPrompt({ summary });
			return {
				systemPrompt: `${systemPrompt}\n\n${addition}`,
			};
		},
	};
}
