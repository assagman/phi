/**
 * Team Dependency Graph
 *
 * Computes execution waves using topological sort:
 * - Teams in the same wave can run in parallel
 * - Teams in later waves depend on earlier waves
 */

// ============================================================================
// Team Dependency Graph
// ============================================================================

/**
 * Represents dependencies between teams.
 * Used to compute execution waves (topological sort).
 */
export class TeamDependencyGraph {
	/** Map of team -> teams it depends on */
	private dependencies: Map<string, Set<string>> = new Map();
	/** All known teams */
	private teams: Set<string> = new Set();

	/**
	 * Add a team to the graph (with no dependencies).
	 */
	addTeam(team: string): void {
		this.teams.add(team);
		if (!this.dependencies.has(team)) {
			this.dependencies.set(team, new Set());
		}
	}

	/**
	 * Add a dependency: `team` depends on `dependsOn`.
	 * This means `dependsOn` must complete before `team` can start.
	 */
	addDependency(team: string, dependsOn: string): void {
		this.addTeam(team);
		this.addTeam(dependsOn);
		this.dependencies.get(team)!.add(dependsOn);
	}

	/**
	 * Get teams that a given team depends on.
	 */
	getDependencies(team: string): string[] {
		return [...(this.dependencies.get(team) || [])];
	}

	/**
	 * Compute execution waves using topological sort (Kahn's algorithm).
	 * Returns array of waves, where each wave is an array of team names
	 * that can execute in parallel.
	 *
	 * @throws Error if circular dependency detected
	 */
	getWaves(): string[][] {
		const waves: string[][] = [];
		const remaining = new Set(this.teams);
		const completed = new Set<string>();

		while (remaining.size > 0) {
			// Find teams with all dependencies satisfied
			const wave: string[] = [];

			for (const team of remaining) {
				const deps = this.dependencies.get(team) || new Set();
				const allDepsSatisfied = [...deps].every((dep) => completed.has(dep));
				if (allDepsSatisfied) {
					wave.push(team);
				}
			}

			if (wave.length === 0) {
				// No progress = circular dependency
				const cycle = [...remaining].join(", ");
				throw new Error(`Circular dependency detected among teams: ${cycle}`);
			}

			// Remove wave teams from remaining, add to completed
			for (const team of wave) {
				remaining.delete(team);
				completed.add(team);
			}

			waves.push(wave.sort()); // Sort for deterministic order
		}

		return waves;
	}

	/**
	 * Create a dependency graph from the lead analyzer's output.
	 */
	static fromLeadOutput(selectedTeams: string[], executionWaves?: string[][]): TeamDependencyGraph {
		const graph = new TeamDependencyGraph();

		// Add all selected teams
		for (const team of selectedTeams) {
			graph.addTeam(team);
		}

		// If waves are provided, infer dependencies
		if (executionWaves && executionWaves.length > 1) {
			for (let i = 1; i < executionWaves.length; i++) {
				const currentWave = executionWaves[i];
				const previousWave = executionWaves[i - 1];

				// Each team in current wave depends on all teams in previous wave
				for (const team of currentWave) {
					for (const prevTeam of previousWave) {
						graph.addDependency(team, prevTeam);
					}
				}
			}
		}

		return graph;
	}
}

// ============================================================================
// Known Team Dependencies
// ============================================================================

/**
 * Pre-defined dependencies between built-in teams.
 * These are based on logical information flow:
 * - Architecture analysis informs API review
 * - Security analysis informs dependency audit
 * - Type analysis informs test coverage review
 */
export const KNOWN_TEAM_DEPENDENCIES: Array<{ team: string; dependsOn: string }> = [
	{ team: "api-review", dependsOn: "architecture" },
	{ team: "dependencies", dependsOn: "security-audit" },
	{ team: "testing", dependsOn: "types" },
	{ team: "testing", dependsOn: "quality" },
];

/**
 * Create a dependency graph with known dependencies applied
 * for the given set of selected teams.
 */
export function createDependencyGraphForTeams(selectedTeams: string[]): TeamDependencyGraph {
	const graph = new TeamDependencyGraph();

	// Add all selected teams
	for (const team of selectedTeams) {
		graph.addTeam(team);
	}

	// Add known dependencies only if both teams are selected
	const teamSet = new Set(selectedTeams);
	for (const { team, dependsOn } of KNOWN_TEAM_DEPENDENCIES) {
		if (teamSet.has(team) && teamSet.has(dependsOn)) {
			graph.addDependency(team, dependsOn);
		}
	}

	return graph;
}
