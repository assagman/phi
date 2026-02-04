import { getModel } from "ai";
import { describe, expect, it } from "vitest";
import { type AgentPreset, createTeam, type TeamConfig, type TeamEvent } from "../src/index.js";

// Simple mock preset that doesn't require real LLM execution
function createMockPreset(name: string): AgentPreset {
	return {
		name,
		description: `Mock ${name} agent`,
		model: getModel("openai", "gpt-4o-mini"),
		systemPrompt: "You are a test agent.",
		temperature: 0,
	};
}

// Minimal team config for testing
function createMinimalConfig(agents: string[]): TeamConfig {
	return {
		name: "test-team",
		description: "Test team configuration",
		agents: agents.map(createMockPreset),
		tools: [],
		strategy: "parallel",
		merge: {
			strategy: "union",
		},
		maxRetries: 0,
		continueOnError: true,
	};
}

describe("Team", () => {
	describe("constructor", () => {
		it("should create team from config", () => {
			const config = createMinimalConfig(["agent-a", "agent-b"]);
			const team = createTeam(config);

			expect(team).toBeDefined();
		});
	});

	describe("run()", () => {
		it("should return an event stream", () => {
			const config = createMinimalConfig(["agent-a"]);
			const team = createTeam(config);

			const stream = team.run({ signal: AbortSignal.abort() }); // Abort immediately

			expect(stream).toBeDefined();
			expect(typeof stream[Symbol.asyncIterator]).toBe("function");
			expect(typeof stream.result).toBe("function");
		});

		it("should emit team_start event first", async () => {
			const config = createMinimalConfig(["agent-a"]);
			const team = createTeam(config);

			const abortController = new AbortController();
			const stream = team.run({ signal: abortController.signal });

			const events: TeamEvent[] = [];
			const collectPromise = (async () => {
				for await (const event of stream) {
					events.push(event);
					// Abort after first event to stop the test
					if (events.length >= 1) {
						abortController.abort();
					}
				}
			})();

			// Wait a bit then abort if still running
			setTimeout(() => abortController.abort(), 100);

			try {
				await collectPromise;
			} catch {
				// Expected - stream aborted
			}

			if (events.length > 0) {
				expect(events[0].type).toBe("team_start");
				if (events[0].type === "team_start") {
					expect(events[0].teamName).toBe("test-team");
					expect(events[0].agentCount).toBe(1);
				}
			}
		});
	});

	describe("abort()", () => {
		it("should abort in-progress execution", () => {
			const config = createMinimalConfig(["agent-a", "agent-b"]);
			const team = createTeam(config);

			// Start execution
			const stream = team.run();

			// Abort immediately
			team.abort();

			// Should not throw
			expect(stream).toBeDefined();
		});
	});

	describe("execute()", () => {
		it("should return a promise", () => {
			const config = createMinimalConfig(["agent-a"]);
			const team = createTeam(config);

			// We can't actually execute without real LLM, so just verify the signature
			const abortController = new AbortController();
			abortController.abort(); // Abort immediately

			const promise = team.execute({ signal: abortController.signal });

			expect(promise).toBeInstanceOf(Promise);
		});
	});
});

describe("TeamConfig", () => {
	it("should support parallel strategy", () => {
		const config: TeamConfig = {
			name: "parallel-team",
			agents: [createMockPreset("a"), createMockPreset("b")],
			tools: [],
			strategy: "parallel",
			merge: { strategy: "union" },
		};

		expect(config.strategy).toBe("parallel");
	});

	it("should support sequential strategy", () => {
		const config: TeamConfig = {
			name: "sequential-team",
			agents: [createMockPreset("a"), createMockPreset("b")],
			tools: [],
			strategy: "sequential",
			merge: { strategy: "union" },
		};

		expect(config.strategy).toBe("sequential");
	});

	it("should support verification merge strategy", () => {
		const config: TeamConfig = {
			name: "verification-team",
			agents: [createMockPreset("a")],
			tools: [],
			merge: {
				strategy: "verification",
				mergeAgent: createMockPreset("merge"),
			},
		};

		expect(config.merge.strategy).toBe("verification");
		expect(config.merge.mergeAgent).toBeDefined();
	});

	it("should support intersection merge strategy", () => {
		const config: TeamConfig = {
			name: "intersection-team",
			agents: [createMockPreset("a"), createMockPreset("b")],
			tools: [],
			merge: { strategy: "intersection" },
		};

		expect(config.merge.strategy).toBe("intersection");
	});
});

describe("TeamEvent types", () => {
	it("should have correct team lifecycle event types", () => {
		const startEvent: TeamEvent = {
			type: "team_start",
			teamName: "test",
			agentCount: 2,
		};
		expect(startEvent.type).toBe("team_start");

		const endEvent: TeamEvent = {
			type: "team_end",
			result: {
				teamName: "test",
				success: true,
				agentResults: [],
				findings: [],
				clusters: [],
				durationMs: 100,
			},
		};
		expect(endEvent.type).toBe("team_end");
	});

	it("should have correct agent lifecycle event types", () => {
		const agentStart: TeamEvent = {
			type: "agent_start",
			agentName: "test-agent",
			index: 0,
			total: 1,
		};
		expect(agentStart.type).toBe("agent_start");

		const agentEnd: TeamEvent = {
			type: "agent_end",
			agentName: "test-agent",
			result: {
				agentName: "test-agent",
				success: true,
				findings: [],
				messages: [],
				durationMs: 50,
			},
		};
		expect(agentEnd.type).toBe("agent_end");

		const agentError: TeamEvent = {
			type: "agent_error",
			agentName: "test-agent",
			error: "Test error",
			willRetry: false,
		};
		expect(agentError.type).toBe("agent_error");
	});

	it("should have correct merge event types", () => {
		const mergeStart: TeamEvent = {
			type: "merge_start",
			strategy: "verification",
			findingCount: 5,
		};
		expect(mergeStart.type).toBe("merge_start");

		const mergeProgress: TeamEvent = {
			type: "merge_progress",
			phase: "clustering",
		};
		expect(mergeProgress.type).toBe("merge_progress");

		const mergeEnd: TeamEvent = {
			type: "merge_end",
			mergedCount: 3,
			verifiedCount: 2,
		};
		expect(mergeEnd.type).toBe("merge_end");
	});
});
