import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus, type EventBus } from "../dist/bus.js";
import { cleanupAllSessions } from "../dist/storage.js";
import type {
	FindingPayload,
	LeadOutputPayload,
	TeamEndPayload,
	TeamStartPayload,
	ToolCallEndPayload,
	ToolCallStartPayload,
} from "../dist/types.js";

describe("EventBus", () => {
	let sessionId: string;
	let bus: EventBus;

	beforeEach(() => {
		// Use unique session ID per test to ensure isolation
		sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		bus = createEventBus(sessionId);
	});

	afterEach(() => {
		bus.close();
		// Clean up test data
		cleanupAllSessions({ maxAgeMs: 0, sessionIds: [sessionId] });
	});

	describe("emit and get", () => {
		it("should emit and retrieve a tool_call_start event", () => {
			const payload: ToolCallStartPayload = {
				toolCallId: "call-123",
				toolName: "read",
				args: { path: "test.ts" },
			};

			const id = bus.emit({
				type: "tool_call_start",
				producer: "test-producer",
				sessionId,
				payload,
			});

			expect(id).toBeGreaterThan(0);

			const event = bus.get<ToolCallStartPayload>(id);
			expect(event).not.toBeNull();
			expect(event?.type).toBe("tool_call_start");
			expect(event?.producer).toBe("test-producer");
			expect(event?.payload.toolName).toBe("read");
			expect(event?.payload.args.path).toBe("test.ts");
		});

		it("should emit and retrieve a tool_call_end event with parent", () => {
			const startPayload: ToolCallStartPayload = {
				toolCallId: "call-456",
				toolName: "bash",
				args: { command: "ls -la" },
			};

			const startId = bus.emit({
				type: "tool_call_start",
				producer: "test",
				sessionId,
				payload: startPayload,
			});

			const endPayload: ToolCallEndPayload = {
				toolCallId: "call-456",
				toolName: "bash",
				result: { output: "file1.ts\nfile2.ts" },
				isError: false,
				durationMs: 150,
			};

			const endId = bus.emit({
				type: "tool_call_end",
				producer: "test",
				sessionId,
				parentId: startId,
				payload: endPayload,
			});

			const endEvent = bus.get<ToolCallEndPayload>(endId);
			expect(endEvent?.parentId).toBe(startId);
			expect(endEvent?.payload.durationMs).toBe(150);
		});

		it("should emit team_start and team_end events", () => {
			const startPayload: TeamStartPayload = {
				teamName: "security-audit",
				agents: ["security-auditor", "privacy-auditor"],
				task: "Security review",
			};

			const startId = bus.emit({
				type: "team_start",
				producer: "coop",
				sessionId,
				payload: startPayload,
			});

			const endPayload: TeamEndPayload = {
				teamName: "security-audit",
				success: true,
				findingCount: 5,
				durationMs: 30000,
			};

			const endId = bus.emit({
				type: "team_end",
				producer: "coop",
				sessionId,
				parentId: startId,
				payload: endPayload,
			});

			const startEvent = bus.get<TeamStartPayload>(startId);
			const endEvent = bus.get<TeamEndPayload>(endId);

			expect(startEvent?.payload.agents).toHaveLength(2);
			expect(endEvent?.payload.findingCount).toBe(5);
			expect(endEvent?.parentId).toBe(startId);
		});

		it("should emit finding events", () => {
			const payload: FindingPayload = {
				agentName: "security-auditor",
				category: "security",
				severity: "high",
				title: "SQL Injection vulnerability",
				description: "User input is concatenated directly into SQL query",
				file: "src/db.ts",
				line: 42,
				suggestion: "Use parameterized queries",
			};

			const id = bus.emit({
				type: "finding",
				producer: "coop",
				sessionId,
				payload,
			});

			const event = bus.get<FindingPayload>(id);
			expect(event?.payload.severity).toBe("high");
			expect(event?.payload.file).toBe("src/db.ts");
			expect(event?.payload.line).toBe(42);
		});

		it("should emit lead_output events", () => {
			const payload: LeadOutputPayload = {
				selectedTeams: ["security-audit", "architecture"],
				executionWaves: [["security-audit"], ["architecture"]],
				intent: "security review",
				reasoning: "Project handles sensitive data, needs security focus",
			};

			const id = bus.emit({
				type: "lead_output",
				producer: "coop",
				sessionId,
				payload,
			});

			const event = bus.get<LeadOutputPayload>(id);
			expect(event?.payload.selectedTeams).toEqual(["security-audit", "architecture"]);
			expect(event?.payload.executionWaves).toHaveLength(2);
		});
	});

	describe("query", () => {
		beforeEach(() => {
			// Emit a variety of events for query tests
			bus.emit({
				type: "tool_call_start",
				producer: "agent-session",
				sessionId,
				payload: { toolCallId: "1", toolName: "read", args: {} },
			});
			bus.emit({
				type: "tool_call_end",
				producer: "agent-session",
				sessionId,
				payload: { toolCallId: "1", toolName: "read", result: {}, isError: false, durationMs: 100 },
			});
			bus.emit({
				type: "team_start",
				producer: "coop",
				sessionId,
				payload: { teamName: "test", agents: [], task: "test" },
			});
		});

		it("should query events by type", () => {
			const toolCalls = bus.query({ types: ["tool_call_start"] });
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0].type).toBe("tool_call_start");
		});

		it("should query multiple types", () => {
			const events = bus.query({ types: ["tool_call_start", "tool_call_end"] });
			expect(events).toHaveLength(2);
		});

		it("should query by producer", () => {
			const coopEvents = bus.query({ producer: "coop" });
			expect(coopEvents).toHaveLength(1);
			expect(coopEvents[0].type).toBe("team_start");
		});

		it("should query with limit", () => {
			const events = bus.query({ limit: 2 });
			expect(events).toHaveLength(2);
		});

		it("should query by session", () => {
			const events = bus.query({ sessionId });
			expect(events.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe("subscriptions", () => {
		it("should notify subscribers on emit", () => {
			const received: any[] = [];
			bus.on("tool_call_start", (event) => {
				received.push(event);
			});

			bus.emit({
				type: "tool_call_start",
				producer: "test",
				sessionId,
				payload: { toolCallId: "sub-1", toolName: "test", args: {} },
			});

			expect(received).toHaveLength(1);
			expect(received[0].payload.toolCallId).toBe("sub-1");
		});

		it("should allow unsubscribing", () => {
			const received: any[] = [];
			const subscription = bus.on("finding", (event) => {
				received.push(event);
			});

			bus.emit({
				type: "finding",
				producer: "test",
				sessionId,
				payload: { agentName: "test", category: "test", severity: "info", title: "t1", description: "" },
			});

			subscription.unsubscribe();

			bus.emit({
				type: "finding",
				producer: "test",
				sessionId,
				payload: { agentName: "test", category: "test", severity: "info", title: "t2", description: "" },
			});

			expect(received).toHaveLength(1);
		});

		it("should support multiple event types in subscription", () => {
			const received: any[] = [];
			bus.on(["team_start", "team_end"], (event) => {
				received.push(event);
			});

			bus.emit({
				type: "team_start",
				producer: "test",
				sessionId,
				payload: { teamName: "t", agents: [], task: "t" },
			});
			bus.emit({
				type: "team_end",
				producer: "test",
				sessionId,
				payload: { teamName: "t", success: true, findingCount: 0, durationMs: 100 },
			});
			bus.emit({
				type: "finding",
				producer: "test",
				sessionId,
				payload: { agentName: "test", category: "test", severity: "info", title: "t", description: "" },
			});

			expect(received).toHaveLength(2); // team_start and team_end, not finding
		});
	});

	describe("getChildren", () => {
		it("should return children of a parent event", () => {
			const parentId = bus.emit({
				type: "team_start",
				producer: "coop",
				sessionId,
				payload: { teamName: "test", agents: ["a1", "a2"], task: "test" },
			});

			bus.emit({
				type: "finding",
				producer: "coop",
				sessionId,
				parentId,
				payload: { agentName: "a1", category: "test", severity: "info", title: "f1", description: "" },
			});
			bus.emit({
				type: "finding",
				producer: "coop",
				sessionId,
				parentId,
				payload: { agentName: "a2", category: "test", severity: "info", title: "f2", description: "" },
			});

			const children = bus.getChildren(parentId);
			expect(children).toHaveLength(2);
		});
	});

	describe("count", () => {
		it("should count events matching filters", () => {
			bus.emit({
				type: "tool_call_start",
				producer: "test",
				sessionId,
				payload: { toolCallId: "c1", toolName: "read", args: {} },
			});
			bus.emit({
				type: "tool_call_start",
				producer: "test",
				sessionId,
				payload: { toolCallId: "c2", toolName: "write", args: {} },
			});

			const count = bus.count({ types: ["tool_call_start"], sessionId });
			expect(count).toBe(2);
		});
	});
});
