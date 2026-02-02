/**
 * Epsilon — Task management extension for Phi coding agent.
 *
 * Provides: task CRUD with subtasks, priorities, statuses, tags.
 * Storage:  repo-scoped SQLite at ~/.local/share/phi-ext-epsilon/<repo-id>/epsilon.db
 */
import type { ExtensionAPI } from "coding-agent";
import { buildTasksPrompt, closeDb, getTaskSummary } from "./db.js";
import { registerTools } from "./tools.js";

export default function epsilonExtension(pi: ExtensionAPI) {
	// Register task tools
	registerTools(pi);

	// Single system-prompt injection every turn — no hidden messages
	pi.on("before_agent_start", async (event) => {
		const summary = getTaskSummary();
		const addition = buildTasksPrompt({ summary });
		return {
			systemPrompt: `${event.systemPrompt}\n\n${addition}`,
		};
	});

	pi.on("session_shutdown", () => {
		closeDb();
	});
}
