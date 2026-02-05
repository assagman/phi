/**
 * Per-command rules for bash tool behavior.
 *
 * Controls exit code interpretation and TUI display hints
 * for specific commands (e.g., rg exit 1 = success, phi_delta force-expand).
 */

export interface BashCommandRule {
	/** Command prefix to match (matched against trimmed command start) */
	match: string;
	/** Exit codes to treat as success in addition to 0 */
	successExitCodes?: number[];
	/** Force-expand output in TUI regardless of global toggle */
	forceExpand?: boolean;
	/** Max lines to show when force-expanded (default: 20) */
	maxOutputLines?: number;
}

/** Display hints attached to BashToolDetails for the TUI layer */
export interface BashDisplayHints {
	forceExpand?: boolean;
	maxOutputLines?: number;
}

const DEFAULT_BASH_RULES: readonly BashCommandRule[] = [
	// Skill CLIs — always show output to user
	{ match: "phi_delta", forceExpand: true, maxOutputLines: 20 },
	{ match: "phi_epsilon", forceExpand: true, maxOutputLines: 20 },

	// Search tools — exit code 1 means "no matches", not failure
	{ match: "rg ", successExitCodes: [1] },
	{ match: "rg\n", successExitCodes: [1] },
];

/**
 * Find the first matching rule for a command string.
 * Matches against the trimmed command prefix.
 */
export function matchRule(command: string): BashCommandRule | undefined {
	const trimmed = command.trimStart();
	return DEFAULT_BASH_RULES.find((rule) => trimmed.startsWith(rule.match));
}

/**
 * Extract display hints from a matched rule.
 * Returns undefined if the rule has no display-related fields.
 */
export function buildDisplayHints(rule: BashCommandRule | undefined): BashDisplayHints | undefined {
	if (!rule?.forceExpand) return undefined;
	return {
		forceExpand: rule.forceExpand,
		maxOutputLines: rule.maxOutputLines,
	};
}
