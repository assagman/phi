import type { PresetTemplate } from "./types.js";

/**
 * Committer preset - commits session changes using commit-wizard skill.
 */
export const committerTemplate: PresetTemplate = {
	name: "committer",
	description: "Commits session changes using commit-wizard skill",
	thinkingLevel: "low",
	temperature: 0.1,
	systemPrompt: `Use /skill:commit-wizard to commit the session's code changes.`,
};
