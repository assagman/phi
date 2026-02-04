/**
 * Event Bus — Bridge between SQLite-backed events package and real-time subscriptions.
 *
 * Provides:
 * - SQLite persistence via packages/events
 * - Real-time subscriptions for UI
 * - Backward-compatible emit/on interface
 * - TeamEventEmitter interface for agents package integration
 */

import { EventEmitter } from "node:events";
import type { TeamEventEmitter } from "agents";
// Note: Using relative path because "events" conflicts with Node.js built-in module
// TODO: Rename packages/events to @phi/events or similar
import type {
	AgentEndPayload,
	AgentStartPayload,
	Event,
	EventType,
	FindingPayload,
	LeadOutputPayload,
	LlmResponsePayload,
	MergePayload,
	EventBus as SqliteEventBus,
	TeamEndPayload,
	TeamStartPayload,
	ToolCallEndPayload,
	ToolCallStartPayload,
} from "../../../events/src/index.js";
import { createEventBus as createSqliteEventBus } from "../../../events/src/index.js";

// ============ Re-export types from events package ============

export type {
	AgentEndPayload,
	AgentStartPayload,
	Event,
	EventType,
	FindingPayload,
	LeadOutputPayload,
	LlmResponsePayload,
	MergePayload,
	TeamEndPayload,
	TeamStartPayload,
	ToolCallEndPayload,
	ToolCallStartPayload,
} from "../../../events/src/index.js";

// ============ Local Event Bus Interface ============

/**
 * Simple channel-based event bus for real-time subscriptions.
 * Used by extensions and UI for immediate event handling.
 */
export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

/**
 * Create a simple in-memory event bus for real-time communication.
 * Used for extension communication and backward compatibility.
 */
export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}

// ============ Persistent Event Bus ============

/**
 * Persistent event bus that stores events in SQLite and provides real-time subscriptions.
 *
 * Features:
 * - All events persisted to SQLite
 * - Large payloads (>64KB) stored as files
 * - Query historical events
 * - Real-time subscriptions
 */
export class PersistentEventBus {
	private readonly sqliteBus: SqliteEventBus;
	private readonly sessionId: string;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
		this.sqliteBus = createSqliteEventBus(sessionId);
	}

	/**
	 * Emit an event, persisting to SQLite and notifying subscribers.
	 * Returns the event ID.
	 */
	emit<T>(type: EventType, producer: string, payload: T, parentId?: number): number {
		return this.sqliteBus.emit<T>({
			type,
			producer,
			sessionId: this.sessionId,
			parentId: parentId ?? null,
			payload,
		});
	}

	/**
	 * Emit a tool_call_start event.
	 */
	emitToolCallStart(toolCallId: string, toolName: string, args: Record<string, unknown>): number {
		const payload: ToolCallStartPayload = { toolCallId, toolName, args };
		return this.emit("tool_call_start", "agent-session", payload);
	}

	/**
	 * Emit a tool_call_end event.
	 */
	emitToolCallEnd(
		toolCallId: string,
		toolName: string,
		result: unknown,
		isError: boolean,
		durationMs: number,
		parentEventId?: number,
	): number {
		const payload: ToolCallEndPayload = { toolCallId, toolName, result, isError, durationMs };
		return this.emit("tool_call_end", "agent-session", payload, parentEventId);
	}

	/**
	 * Emit an llm_response event for completed assistant messages.
	 */
	emitLlmResponse(
		model: string,
		content: string,
		thinkingContent?: string,
		inputTokens?: number,
		outputTokens?: number,
		stopReason?: string,
	): number {
		const payload: LlmResponsePayload = {
			model,
			content,
			thinkingContent,
			inputTokens,
			outputTokens,
			stopReason,
		};
		return this.emit("llm_response", "agent-session", payload);
	}

	/**
	 * Emit a team_start event.
	 */
	emitTeamStart(teamName: string, agents: string[], task: string): number {
		const payload: TeamStartPayload = { teamName, agents, task };
		return this.emit("team_start", "coop", payload);
	}

	/**
	 * Emit a team_end event.
	 */
	emitTeamEnd(
		teamName: string,
		success: boolean,
		findingCount: number,
		durationMs: number,
		error?: string,
		parentEventId?: number,
	): number {
		const payload: TeamEndPayload = { teamName, success, findingCount, durationMs, error };
		return this.emit("team_end", "coop", payload, parentEventId);
	}

	/**
	 * Emit a lead_output event.
	 */
	emitLeadOutput(selectedTeams: string[], executionWaves: string[][], intent: string, reasoning: string): number {
		const payload: LeadOutputPayload = { selectedTeams, executionWaves, intent, reasoning };
		return this.emit("lead_output", "coop", payload);
	}

	/**
	 * Emit a finding event.
	 */
	emitFinding(
		agentName: string,
		category: string,
		severity: "critical" | "high" | "medium" | "low" | "info",
		title: string,
		description: string,
		file?: string,
		line?: number,
		suggestion?: string,
		parentEventId?: number,
	): number {
		const payload: FindingPayload = {
			agentName,
			category,
			severity,
			title,
			description,
			file,
			line,
			suggestion,
		};
		return this.emit("finding", "coop", payload, parentEventId);
	}

	/**
	 * Emit an agent_start event.
	 */
	emitAgentStart(agentName: string, teamName: string): number {
		const payload: AgentStartPayload = { agentName, teamName };
		return this.emit("agent_start", "team", payload);
	}

	/**
	 * Emit an agent_end event.
	 */
	emitAgentEnd(
		agentName: string,
		teamName: string,
		success: boolean,
		findingCount: number,
		durationMs: number,
		error?: string,
		parentEventId?: number,
	): number {
		const payload: AgentEndPayload = { agentName, teamName, success, findingCount, durationMs, error };
		return this.emit("agent_end", "team", payload, parentEventId);
	}

	/**
	 * Emit a merge_start event.
	 */
	emitMergeStart(strategy: string, inputFindingCount: number, parentEventId?: number): number {
		const payload: MergePayload = { phase: "start", strategy, inputFindingCount };
		return this.emit("merge_start", "team", payload, parentEventId);
	}

	/**
	 * Emit a merge_end event.
	 */
	emitMergeEnd(outputFindingCount: number, parentEventId?: number): number {
		const payload: MergePayload = { phase: "end", outputFindingCount };
		return this.emit("merge_end", "team", payload, parentEventId);
	}

	/**
	 * Create a TeamEventEmitter interface for use with the agents package.
	 * This allows the agents package to emit events without depending on coding-agent.
	 */
	createTeamEventEmitter(): TeamEventEmitter {
		return {
			emitAgentStart: (agentName: string, teamName: string) => this.emitAgentStart(agentName, teamName),
			emitAgentEnd: (
				agentName: string,
				teamName: string,
				success: boolean,
				findingCount: number,
				durationMs: number,
				error?: string,
				parentEventId?: number,
			) => this.emitAgentEnd(agentName, teamName, success, findingCount, durationMs, error, parentEventId),
			emitFinding: (
				agentName: string,
				category: string,
				severity: "critical" | "high" | "medium" | "low" | "info",
				title: string,
				description: string,
				file?: string,
				line?: number,
				suggestion?: string,
				parentEventId?: number,
			) =>
				this.emitFinding(agentName, category, severity, title, description, file, line, suggestion, parentEventId),
			emitTeamStart: (teamName: string, agents: string[], task: string) =>
				this.emitTeamStart(teamName, agents, task),
			emitTeamEnd: (
				teamName: string,
				success: boolean,
				findingCount: number,
				durationMs: number,
				error?: string,
				parentEventId?: number,
			) => this.emitTeamEnd(teamName, success, findingCount, durationMs, error, parentEventId),
			emitMergeStart: (strategy: string, inputFindingCount: number, parentEventId?: number) =>
				this.emitMergeStart(strategy, inputFindingCount, parentEventId),
			emitMergeEnd: (outputFindingCount: number, parentEventId?: number) =>
				this.emitMergeEnd(outputFindingCount, parentEventId),
		};
	}

	/**
	 * Get an event by ID.
	 */
	get<T = unknown>(id: number): Event<T> | null {
		return this.sqliteBus.get<T>(id);
	}

	/**
	 * Query events by type.
	 */
	queryByType<T = unknown>(types: EventType[], limit?: number): Event<T>[] {
		return this.sqliteBus.query<T>({ types, sessionId: this.sessionId, limit });
	}

	/**
	 * Query events since a timestamp.
	 */
	querySince<T = unknown>(since: number, types?: EventType[]): Event<T>[] {
		return this.sqliteBus.query<T>({ types, sessionId: this.sessionId, since });
	}

	/**
	 * Get children of an event.
	 */
	getChildren<T = unknown>(parentId: number): Event<T>[] {
		return this.sqliteBus.getChildren<T>(parentId);
	}

	/**
	 * Subscribe to events of a specific type.
	 */
	subscribe<T = unknown>(types: EventType | EventType[], handler: (event: Event<T>) => void): () => void {
		const subscription = this.sqliteBus.on<T>(types, handler);
		return () => subscription.unsubscribe();
	}

	/**
	 * Get storage locations.
	 */
	getLocations(): { db: string; files: string } {
		return this.sqliteBus.getLocations();
	}

	/**
	 * Close the event bus.
	 */
	close(): void {
		this.sqliteBus.close();
	}
}

/**
 * Create a persistent event bus for a session.
 */
export function createPersistentEventBus(sessionId: string): PersistentEventBus {
	return new PersistentEventBus(sessionId);
}
