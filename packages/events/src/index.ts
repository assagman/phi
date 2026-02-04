/**
 * Events Package — SQLite-backed event bus for phi.
 *
 * Features:
 * - SQLite persistence with automatic payload storage strategy
 * - Large payloads (>64KB) stored as files
 * - Real-time subscriptions
 * - TTL-based cleanup
 * - Full audit trail and replay capability
 *
 * Usage:
 * ```typescript
 * import { createEventBus, cleanup } from "events";
 *
 * // Create event bus for a session
 * const bus = createEventBus("session-123");
 *
 * // Subscribe to events
 * bus.on("tool_call_end", (event) => {
 *   console.log("Tool completed:", event.payload);
 * });
 *
 * // Emit an event
 * const id = bus.emit({
 *   type: "tool_call_start",
 *   producer: "agent-loop",
 *   sessionId: "session-123",
 *   payload: { toolName: "read", args: { path: "file.ts" } },
 * });
 *
 * // Query events
 * const toolCalls = bus.query({ types: ["tool_call_start", "tool_call_end"] });
 *
 * // Cleanup old events
 * cleanup({ maxAgeMs: 24 * 60 * 60 * 1000 }); // 24 hours
 * ```
 */

// ============ Types ============

export type {
	AgentEndPayload,
	AgentResultPayload,
	AgentStartPayload,
	CleanupOptions,
	CleanupResult,
	Event,
	EventInput,
	EventListener,
	// Query and subscription
	EventQueryOptions,
	EventRecord,
	// Event types
	EventType,
	FindingPayload,
	LeadOutputPayload,
	// Payload types
	LlmResponsePayload,
	MergePayload,
	MessagePayload,
	PayloadType,
	// Config and cleanup
	StorageConfig,
	Subscription,
	SubscriptionFilter,
	TeamEndPayload,
	TeamStartPayload,
	ToolCallEndPayload,
	ToolCallStartPayload,
} from "./types.js";

// ============ Event Bus ============

export { createEventBus, EventBus } from "./bus.js";

// ============ Storage ============

export { cleanupAllSessions, EventStorage } from "./storage.js";

// ============ Cleanup ============

export {
	CleanupScheduler,
	type CleanupSchedulerOptions,
	cleanup,
	cleanupOrphanedFiles,
	EventCleaner,
	formatBytes,
	getStorageStats,
} from "./cleanup.js";
