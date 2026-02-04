/**
 * Event Bus Types
 *
 * Defines all event types and interfaces for the SQLite-backed event system.
 */

// ============ Event Types ============

/**
 * All supported event types in the system.
 */
export type EventType =
	| "llm_response"
	| "tool_call_start"
	| "tool_call_end"
	| "message"
	| "team_start"
	| "team_end"
	| "agent_start"
	| "agent_end"
	| "agent_result"
	| "finding"
	| "lead_output"
	| "merge_start"
	| "merge_end";

/**
 * Payload storage strategy.
 * - "inline": JSON stored directly in SQLite (< 64KB)
 * - "file": Large content stored as file, path in SQLite
 */
export type PayloadType = "inline" | "file";

// ============ Base Event ============

/**
 * Base event structure stored in SQLite.
 */
export interface EventRecord {
	/** Auto-incremented event ID */
	id: number;
	/** Event type discriminator */
	type: EventType;
	/** Producer identifier (e.g., "agent-loop", "team-executor", "tool-bash") */
	producer: string;
	/** Session ID for grouping related events */
	sessionId: string;
	/** Parent event ID for hierarchical relationships */
	parentId: number | null;
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Storage strategy for payload */
	payloadType: PayloadType;
	/** JSON payload (inline) or file path (file) */
	payload: string;
	/** Additional metadata as JSON */
	meta: string;
}

/**
 * Event input for emit() - id and timestamp are auto-generated.
 */
export interface EventInput<T = unknown> {
	type: EventType;
	producer: string;
	sessionId: string;
	parentId?: number | null;
	payload: T;
	meta?: Record<string, unknown>;
}

/**
 * Hydrated event with parsed payload and meta.
 */
export interface Event<T = unknown> {
	id: number;
	type: EventType;
	producer: string;
	sessionId: string;
	parentId: number | null;
	timestamp: number;
	payload: T;
	meta: Record<string, unknown>;
}

// ============ Event Payloads ============

/**
 * LLM response event payload.
 */
export interface LlmResponsePayload {
	model: string;
	content: string;
	thinkingContent?: string;
	inputTokens?: number;
	outputTokens?: number;
	stopReason?: string;
}

/**
 * Tool call start event payload.
 */
export interface ToolCallStartPayload {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

/**
 * Tool call end event payload.
 */
export interface ToolCallEndPayload {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
	durationMs: number;
}

/**
 * Message event payload.
 */
export interface MessagePayload {
	role: "user" | "assistant" | "system";
	content: string;
}

/**
 * Team start event payload.
 */
export interface TeamStartPayload {
	teamName: string;
	agents: string[];
	task: string;
}

/**
 * Team end event payload.
 */
export interface TeamEndPayload {
	teamName: string;
	success: boolean;
	findingCount: number;
	durationMs: number;
	error?: string;
}

/**
 * Agent start event payload.
 */
export interface AgentStartPayload {
	agentName: string;
	teamName: string;
}

/**
 * Agent end event payload.
 */
export interface AgentEndPayload {
	agentName: string;
	teamName: string;
	success: boolean;
	findingCount: number;
	durationMs: number;
	error?: string;
}

/**
 * Agent result event payload.
 */
export interface AgentResultPayload {
	agentName: string;
	findings: unknown[];
	messages: unknown[];
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

/**
 * Finding event payload.
 */
export interface FindingPayload {
	agentName: string;
	category: string;
	severity: "critical" | "high" | "medium" | "low" | "info";
	title: string;
	description: string;
	file?: string;
	line?: number;
	suggestion?: string;
}

/**
 * Lead analyzer output event payload.
 */
export interface LeadOutputPayload {
	selectedTeams: string[];
	executionWaves: string[][];
	intent: string;
	reasoning: string;
}

/**
 * Merge phase event payload.
 */
export interface MergePayload {
	phase: "start" | "end";
	inputFindingCount?: number;
	outputFindingCount?: number;
	strategy?: string;
}

// ============ Query Options ============

/**
 * Options for querying events.
 */
export interface EventQueryOptions {
	/** Filter by event type(s) */
	types?: EventType[];
	/** Filter by producer */
	producer?: string;
	/** Filter by session ID */
	sessionId?: string;
	/** Filter by parent event ID */
	parentId?: number | null;
	/** Events after this timestamp */
	since?: number;
	/** Events before this timestamp */
	until?: number;
	/** Maximum number of results */
	limit?: number;
	/** Offset for pagination */
	offset?: number;
	/** Order by timestamp (default: DESC) */
	order?: "asc" | "desc";
}

// ============ Subscription ============

/**
 * Event listener callback.
 */
export type EventListener<T = unknown> = (event: Event<T>) => void;

/**
 * Subscription filter options.
 */
export interface SubscriptionFilter {
	types?: EventType[];
	producer?: string;
	sessionId?: string;
}

/**
 * Subscription handle for unsubscribing.
 */
export interface Subscription {
	unsubscribe: () => void;
}

// ============ Storage Config ============

/**
 * Storage configuration options.
 */
export interface StorageConfig {
	/** Base directory for event databases (default: ~/.local/share/phi/events) */
	baseDir?: string;
	/** Threshold for file storage in bytes (default: 64KB) */
	fileSizeThreshold?: number;
	/** Directory for large payload files (default: /tmp/phi-events) */
	fileStorageDir?: string;
	/** TTL for events in milliseconds (default: 24 hours) */
	defaultTtlMs?: number;
}

/**
 * Cleanup options.
 */
export interface CleanupOptions {
	/** Max age for events in milliseconds */
	maxAgeMs?: number;
	/** Specific session IDs to clean */
	sessionIds?: string[];
	/** Whether to remove associated files */
	removeFiles?: boolean;
}

/**
 * Cleanup result.
 */
export interface CleanupResult {
	eventsDeleted: number;
	filesDeleted: number;
	sessionsAffected: string[];
}
