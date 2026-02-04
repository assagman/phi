/**
 * Tests for Lead Team system:
 * - TeamDependencyGraph: dependency resolution and wave computation
 * - Lead analyzer output parsing (tested via mock data)
 */

import { describe, expect, it } from "vitest";
import {
	createDependencyGraphForTeams,
	KNOWN_TEAM_DEPENDENCIES,
	TeamDependencyGraph,
} from "../src/team/wave-orchestrator.js";

// ============================================================================
// TeamDependencyGraph Tests
// ============================================================================

describe("TeamDependencyGraph", () => {
	describe("addTeam / addDependency", () => {
		it("should add teams without dependencies", () => {
			const graph = new TeamDependencyGraph();
			graph.addTeam("security-audit");
			graph.addTeam("performance");

			const waves = graph.getWaves();
			expect(waves).toHaveLength(1);
			expect(waves[0]).toContain("security-audit");
			expect(waves[0]).toContain("performance");
		});

		it("should add dependencies between teams", () => {
			const graph = new TeamDependencyGraph();
			graph.addDependency("api-review", "architecture");

			const waves = graph.getWaves();
			expect(waves).toHaveLength(2);
			expect(waves[0]).toContain("architecture");
			expect(waves[1]).toContain("api-review");
		});

		it("should auto-add teams when adding dependencies", () => {
			const graph = new TeamDependencyGraph();
			graph.addDependency("testing", "types");

			// Both teams should exist even though we only called addDependency
			const waves = graph.getWaves();
			const allTeams = waves.flat();
			expect(allTeams).toContain("testing");
			expect(allTeams).toContain("types");
		});
	});

	describe("getDependencies", () => {
		it("should return empty array for team with no dependencies", () => {
			const graph = new TeamDependencyGraph();
			graph.addTeam("security-audit");

			expect(graph.getDependencies("security-audit")).toEqual([]);
		});

		it("should return empty array for unknown team", () => {
			const graph = new TeamDependencyGraph();

			expect(graph.getDependencies("nonexistent")).toEqual([]);
		});

		it("should return dependencies for team", () => {
			const graph = new TeamDependencyGraph();
			graph.addDependency("api-review", "architecture");
			graph.addDependency("api-review", "types");

			const deps = graph.getDependencies("api-review");
			expect(deps).toHaveLength(2);
			expect(deps).toContain("architecture");
			expect(deps).toContain("types");
		});
	});

	describe("getWaves (topological sort)", () => {
		it("should return single wave for independent teams", () => {
			const graph = new TeamDependencyGraph();
			graph.addTeam("security-audit");
			graph.addTeam("performance");
			graph.addTeam("types");

			const waves = graph.getWaves();
			expect(waves).toHaveLength(1);
			expect(waves[0]).toHaveLength(3);
		});

		it("should return multiple waves for dependent teams", () => {
			const graph = new TeamDependencyGraph();
			graph.addTeam("security-audit");
			graph.addDependency("dependencies", "security-audit");

			const waves = graph.getWaves();
			expect(waves).toHaveLength(2);
			expect(waves[0]).toContain("security-audit");
			expect(waves[1]).toContain("dependencies");
		});

		it("should handle complex dependency chains", () => {
			const graph = new TeamDependencyGraph();
			// A → B → C chain
			graph.addDependency("B", "A");
			graph.addDependency("C", "B");

			const waves = graph.getWaves();
			expect(waves).toHaveLength(3);
			expect(waves[0]).toContain("A");
			expect(waves[1]).toContain("B");
			expect(waves[2]).toContain("C");
		});

		it("should handle diamond dependencies", () => {
			const graph = new TeamDependencyGraph();
			//     A
			//    / \
			//   B   C
			//    \ /
			//     D
			graph.addDependency("B", "A");
			graph.addDependency("C", "A");
			graph.addDependency("D", "B");
			graph.addDependency("D", "C");

			const waves = graph.getWaves();
			expect(waves).toHaveLength(3);
			expect(waves[0]).toContain("A");
			expect(waves[1]).toContain("B");
			expect(waves[1]).toContain("C");
			expect(waves[2]).toContain("D");
		});

		it("should detect circular dependencies", () => {
			const graph = new TeamDependencyGraph();
			graph.addDependency("A", "B");
			graph.addDependency("B", "C");
			graph.addDependency("C", "A"); // Creates cycle

			expect(() => graph.getWaves()).toThrow(/circular dependency/i);
		});

		it("should sort teams within waves for determinism", () => {
			const graph = new TeamDependencyGraph();
			graph.addTeam("z-team");
			graph.addTeam("a-team");
			graph.addTeam("m-team");

			const waves = graph.getWaves();
			expect(waves[0]).toEqual(["a-team", "m-team", "z-team"]);
		});

		it("should handle mix of dependent and independent teams", () => {
			const graph = new TeamDependencyGraph();
			graph.addTeam("independent-1");
			graph.addTeam("independent-2");
			graph.addDependency("dependent", "independent-1");

			const waves = graph.getWaves();
			expect(waves).toHaveLength(2);
			// Wave 1 has both independents (one is also a dependency)
			expect(waves[0]).toContain("independent-1");
			expect(waves[0]).toContain("independent-2");
			// Wave 2 has the dependent
			expect(waves[1]).toContain("dependent");
		});
	});

	describe("fromLeadOutput", () => {
		it("should create graph from selected teams only", () => {
			const graph = TeamDependencyGraph.fromLeadOutput(["security-audit", "types", "testing"]);

			const waves = graph.getWaves();
			const allTeams = waves.flat();
			expect(allTeams).toHaveLength(3);
			expect(allTeams).toContain("security-audit");
			expect(allTeams).toContain("types");
			expect(allTeams).toContain("testing");
		});

		it("should infer dependencies from execution waves", () => {
			const graph = TeamDependencyGraph.fromLeadOutput(
				["architecture", "security-audit", "api-review", "dependencies"],
				[
					["architecture", "security-audit"], // Wave 1
					["api-review", "dependencies"], // Wave 2
				],
			);

			const waves = graph.getWaves();
			expect(waves).toHaveLength(2);

			// Wave 1 teams should be in first wave
			expect(waves[0]).toContain("architecture");
			expect(waves[0]).toContain("security-audit");

			// Wave 2 teams should be in second wave
			expect(waves[1]).toContain("api-review");
			expect(waves[1]).toContain("dependencies");
		});

		it("should handle single wave output", () => {
			const graph = TeamDependencyGraph.fromLeadOutput(["security-audit", "types"], [["security-audit", "types"]]);

			const waves = graph.getWaves();
			expect(waves).toHaveLength(1);
			expect(waves[0]).toHaveLength(2);
		});

		it("should handle multi-wave complex output", () => {
			const graph = TeamDependencyGraph.fromLeadOutput(
				["a", "b", "c", "d"],
				[
					["a"], // Wave 1
					["b", "c"], // Wave 2
					["d"], // Wave 3
				],
			);

			const waves = graph.getWaves();
			expect(waves).toHaveLength(3);
			expect(waves[0]).toContain("a");
			expect(waves[1]).toContain("b");
			expect(waves[1]).toContain("c");
			expect(waves[2]).toContain("d");
		});
	});
});

// ============================================================================
// createDependencyGraphForTeams Tests
// ============================================================================

describe("createDependencyGraphForTeams", () => {
	it("should create graph with only selected teams", () => {
		const graph = createDependencyGraphForTeams(["security-audit", "performance"]);

		const waves = graph.getWaves();
		const allTeams = waves.flat();
		expect(allTeams).toHaveLength(2);
	});

	it("should apply known dependencies when both teams are selected", () => {
		// From KNOWN_TEAM_DEPENDENCIES: api-review depends on architecture
		const graph = createDependencyGraphForTeams(["architecture", "api-review"]);

		const waves = graph.getWaves();
		expect(waves).toHaveLength(2);
		expect(waves[0]).toContain("architecture");
		expect(waves[1]).toContain("api-review");
	});

	it("should not apply known dependencies when dependency is not selected", () => {
		// api-review depends on architecture, but architecture not selected
		const graph = createDependencyGraphForTeams(["api-review", "security-audit"]);

		const waves = graph.getWaves();
		expect(waves).toHaveLength(1); // All in parallel since no deps
	});

	it("should apply multiple known dependencies", () => {
		// testing depends on types and quality
		const graph = createDependencyGraphForTeams(["types", "quality", "testing"]);

		const waves = graph.getWaves();
		expect(waves).toHaveLength(2);
		// types and quality in first wave
		expect(waves[0]).toContain("types");
		expect(waves[0]).toContain("quality");
		// testing in second wave
		expect(waves[1]).toContain("testing");
	});
});

// ============================================================================
// KNOWN_TEAM_DEPENDENCIES Tests
// ============================================================================

describe("KNOWN_TEAM_DEPENDENCIES", () => {
	it("should have valid dependency structure", () => {
		for (const dep of KNOWN_TEAM_DEPENDENCIES) {
			expect(dep).toHaveProperty("team");
			expect(dep).toHaveProperty("dependsOn");
			expect(typeof dep.team).toBe("string");
			expect(typeof dep.dependsOn).toBe("string");
		}
	});

	it("should have expected known dependencies", () => {
		// api-review depends on architecture
		expect(KNOWN_TEAM_DEPENDENCIES.some((d) => d.team === "api-review" && d.dependsOn === "architecture")).toBe(true);

		// dependencies depends on security-audit
		expect(KNOWN_TEAM_DEPENDENCIES.some((d) => d.team === "dependencies" && d.dependsOn === "security-audit")).toBe(
			true,
		);
	});
});

// ============================================================================
// Lead Analyzer Output Parsing Tests (mock data)
// ============================================================================

describe("Lead Analyzer Output Parsing", () => {
	// Helper function that mirrors parseLeadAnalyzerOutput logic
	function parseLeadOutput(content: string): { selectedTeams: string[]; waves: string[][] } | null {
		const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
		const jsonStr = jsonMatch ? jsonMatch[1].trim() : content;

		try {
			const parsed = JSON.parse(jsonStr);
			if (!parsed.selectedTeams || !Array.isArray(parsed.selectedTeams)) {
				return null;
			}
			return {
				selectedTeams: parsed.selectedTeams,
				waves: parsed.executionWaves || [parsed.selectedTeams],
			};
		} catch {
			return null;
		}
	}

	it("should parse valid JSON with markdown code block", () => {
		const output = `
Based on my analysis, here's my decision:

\`\`\`json
{
  "intent": "production readiness check",
  "selectedTeams": ["security-audit", "testing", "docs"],
  "executionWaves": [["security-audit"], ["testing", "docs"]],
  "reasoning": "Standard pre-release checks"
}
\`\`\`
`;

		const result = parseLeadOutput(output);
		expect(result).not.toBeNull();
		expect(result!.selectedTeams).toEqual(["security-audit", "testing", "docs"]);
		expect(result!.waves).toEqual([["security-audit"], ["testing", "docs"]]);
	});

	it("should parse JSON without markdown wrapper", () => {
		const output = `{
  "intent": "security audit",
  "selectedTeams": ["security-audit", "dependencies"],
  "reasoning": "User requested security review"
}`;

		const result = parseLeadOutput(output);
		expect(result).not.toBeNull();
		expect(result!.selectedTeams).toEqual(["security-audit", "dependencies"]);
	});

	it("should return null for missing selectedTeams", () => {
		const output = `{
  "intent": "review",
  "reasoning": "No teams specified"
}`;

		expect(parseLeadOutput(output)).toBeNull();
	});

	it("should return null for invalid JSON", () => {
		const output = "This is not valid JSON at all";

		expect(parseLeadOutput(output)).toBeNull();
	});

	it("should handle empty selectedTeams array", () => {
		const output = `{
  "intent": "review",
  "selectedTeams": [],
  "reasoning": "Empty selection"
}`;

		const result = parseLeadOutput(output);
		expect(result).not.toBeNull();
		expect(result!.selectedTeams).toEqual([]);
	});

	it("should default waves to selectedTeams when not provided", () => {
		const output = `{
  "intent": "audit",
  "selectedTeams": ["security-audit", "types"],
  "reasoning": "Basic audit"
}`;

		const result = parseLeadOutput(output);
		expect(result!.waves).toEqual([["security-audit", "types"]]);
	});

	it("should parse complex multi-wave output", () => {
		const output = `\`\`\`json
{
  "intent": "full production readiness audit",
  "projectContext": {
    "type": "app",
    "languages": ["typescript"],
    "frameworks": ["react", "express"],
    "hasTests": true,
    "hasDocs": false
  },
  "selectedTeams": ["architecture", "security-audit", "api-review", "testing", "docs"],
  "executionWaves": [
    ["architecture", "security-audit"],
    ["api-review", "testing"],
    ["docs"]
  ],
  "reasoning": "Architecture and security first, then API review can use architecture context, docs last",
  "memoryContext": "Previous audit found auth issues that were fixed"
}
\`\`\``;

		const result = parseLeadOutput(output);
		expect(result).not.toBeNull();
		expect(result!.selectedTeams).toHaveLength(5);
		expect(result!.waves).toHaveLength(3);
		expect(result!.waves[0]).toContain("architecture");
		expect(result!.waves[0]).toContain("security-audit");
		expect(result!.waves[1]).toContain("api-review");
		expect(result!.waves[2]).toContain("docs");
	});
});

// ============================================================================
// Integration: Graph + Waves End-to-End
// ============================================================================

describe("Integration: Lead Output → Dependency Graph → Execution Waves", () => {
	it("should produce correct execution order from lead output", () => {
		// Simulate lead analyzer output
		const leadOutput = {
			selectedTeams: ["architecture", "security-audit", "api-review", "dependencies"],
			executionWaves: [
				["architecture", "security-audit"],
				["api-review", "dependencies"],
			],
		};

		// Create graph from output
		const graph = TeamDependencyGraph.fromLeadOutput(leadOutput.selectedTeams, leadOutput.executionWaves);

		// Get computed waves
		const waves = graph.getWaves();

		// Verify execution order matches intent
		expect(waves).toHaveLength(2);

		// First wave: architecture and security-audit (no dependencies)
		expect(waves[0]).toContain("architecture");
		expect(waves[0]).toContain("security-audit");

		// Second wave: api-review and dependencies (depend on first wave)
		expect(waves[1]).toContain("api-review");
		expect(waves[1]).toContain("dependencies");
	});

	it("should handle lead output with known dependencies applied", () => {
		// Lead selects teams, we apply known dependencies
		const selectedTeams = ["architecture", "api-review", "security-audit", "dependencies"];

		const graph = createDependencyGraphForTeams(selectedTeams);
		const waves = graph.getWaves();

		// Known: api-review depends on architecture
		// Known: dependencies depends on security-audit
		// So we expect: [architecture, security-audit] -> [api-review, dependencies]
		expect(waves).toHaveLength(2);
		expect(waves[0]).toContain("architecture");
		expect(waves[0]).toContain("security-audit");
		expect(waves[1]).toContain("api-review");
		expect(waves[1]).toContain("dependencies");
	});

	it("should handle overlapping lead waves and known dependencies", () => {
		// Lead suggests waves, but we also have known dependencies
		// The stricter constraint should win

		const leadWaves = [
			["types", "security-audit"],
			["testing", "dependencies"],
		];

		// Known: testing depends on types (already satisfied by lead waves)
		// Known: dependencies depends on security-audit (already satisfied by lead waves)

		const graph = TeamDependencyGraph.fromLeadOutput(
			["types", "security-audit", "testing", "dependencies"],
			leadWaves,
		);

		const waves = graph.getWaves();

		// Should match lead's suggestion since it already respects dependencies
		expect(waves).toHaveLength(2);
		expect(waves[0]).toContain("types");
		expect(waves[0]).toContain("security-audit");
		expect(waves[1]).toContain("testing");
		expect(waves[1]).toContain("dependencies");
	});
});
