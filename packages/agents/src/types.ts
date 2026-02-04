import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "agent";
import type { Model } from "ai";

/**
 * Reusable agent configuration preset.
 * Defines a specialized agent personality with model, prompt, and behavior settings.
 */
export interface AgentPreset {
	/** Unique identifier for this preset */
	name: string;
	/** Human-readable description of the agent's purpose */
	description: string;
	/** LLM model to use */
	model: Model<any>;
	/** System prompt defining the agent's behavior and expertise */
	systemPrompt: string;
	/** Thinking/reasoning level for models that support it */
	thinkingLevel?: ThinkingLevel;
	/** Temperature for response generation */
	temperature?: number;
	/** Maximum tokens for response */
	maxTokens?: number;
}

/**
 * Execution strategy for running multiple agents.
 */
export type ExecutionStrategy = "parallel" | "sequential";

/**
 * Merge strategy for combining agent results.
 */
export type MergeStrategyType = "verification" | "union" | "intersection" | "custom";

/**
 * Configuration for the merge/synthesis phase.
 */
export interface MergeConfig {
	/** How to combine results from multiple agents */
	strategy: MergeStrategyType;
	/** Agent preset used for verification/synthesis (required for verification strategy) */
	mergeAgent?: AgentPreset;
	/** Custom merge function (required for custom strategy) */
	customMerge?: (results: AgentResult[]) => Promise<TeamResult>;
}

/**
 * Team configuration defining agents and orchestration behavior.
 */
export interface TeamConfig {
	/** Unique identifier for this team */
	name: string;
	/** Human-readable description of the team's purpose */
	description?: string;
	/** Agent presets to execute */
	agents: AgentPreset[];
	/** Tools shared across all agents */
	tools: AgentTool[];
	/** Execution strategy (default: parallel) */
	strategy?: ExecutionStrategy;
	/** Merge configuration for combining results */
	merge: MergeConfig;
	/** Maximum retries per agent on failure (default: 1) */
	maxRetries?: number;
	/** Continue if an agent fails (default: true for resilience) */
	continueOnError?: boolean;
}

/**
 * Severity level for findings.
 */
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * Category of finding.
 * Expanded to cover comprehensive code review domains.
 */
export type FindingCategory =
	// Core categories
	| "security" // Vulnerabilities, attack vectors, auth issues
	| "privacy" // PII handling, data protection, compliance
	| "bug" // Logic errors, incorrect behavior
	| "performance" // Bottlenecks, complexity, resource usage
	// Code quality categories
	| "types" // Type safety, type design, type holes
	| "testing" // Test coverage, test quality, edge cases
	| "error-handling" // Error handling, resilience, fault tolerance
	| "concurrency" // Race conditions, deadlocks, thread safety
	// Design categories
	| "architecture" // Structure, patterns, SOLID, modularity
	| "api" // API design, contracts, consistency
	// Content categories
	| "docs" // Documentation, comments, examples
	| "accessibility" // WCAG, a11y, inclusive design
	| "i18n" // Internationalization, localization, Unicode
	// Ecosystem categories
	| "dependencies" // Dependency health, vulnerabilities, hygiene
	// Generic
	| "style" // Code style, formatting (low priority)
	| "maintainability" // General maintainability concerns
	| "other"; // Uncategorized findings

/**
 * A finding represents a single issue, suggestion, or observation from an agent.
 */
export interface Finding {
	/** Unique identifier */
	id: string;
	/** Which agent produced this finding */
	agentName: string;
	/** Severity level */
	severity: FindingSeverity;
	/** Category of the finding */
	category: FindingCategory;
	/** File path (if applicable) */
	file?: string;
	/** Line number or range (if applicable) */
	line?: number | [number, number];
	/** Short title/summary */
	title: string;
	/** Detailed description */
	description: string;
	/** Suggested fix or recommendation */
	suggestion?: string;
	/** Code snippet for context */
	codeSnippet?: string;
	/** Confidence score (0-1) */
	confidence?: number;
	/** Whether this finding was verified by merge agent */
	verified?: boolean;
	/** References (CWE, OWASP, etc.) */
	references?: string[];
}

/**
 * Result from a single agent execution.
 */
export interface AgentResult {
	/** Agent preset name */
	agentName: string;
	/** Whether execution succeeded */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Parsed findings from the agent */
	findings: Finding[];
	/** Raw response messages from the agent */
	messages: AgentMessage[];
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Token usage if available */
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

/**
 * Cluster of related findings (same file+line or similar content).
 */
export interface FindingCluster {
	/** Primary finding (representative) */
	primary: Finding;
	/** Related findings from other agents */
	related: Finding[];
	/** Agreement count (how many agents found similar issues) */
	agreementCount: number;
	/** Verification status */
	verified?: boolean;
	/** Verification note from merge agent */
	verificationNote?: string;
}

/**
 * Final result from team execution.
 */
export interface TeamResult {
	/** Team configuration name */
	teamName: string;
	/** Whether overall execution succeeded */
	success: boolean;
	/** Individual agent results */
	agentResults: AgentResult[];
	/** Merged and verified findings */
	findings: Finding[];
	/** Clustered findings showing agreement between agents */
	clusters: FindingCluster[];
	/** Summary synthesized by merge agent */
	summary?: string;
	/** Total execution duration in milliseconds */
	durationMs: number;
	/** Aggregate token usage */
	totalUsage?: {
		inputTokens: number;
		outputTokens: number;
	};
	/** Error message if team execution failed */
	error?: string;
}

/**
 * Task status for epsilon task tracking.
 */
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

/**
 * Epsilon task tracking info for an agent.
 */
export interface AgentTaskInfo {
	/** Total tasks created by this agent */
	total: number;
	/** Tasks completed (done or cancelled) */
	completed: number;
	/** Currently active task title (in_progress) */
	activeTaskTitle?: string;
}

/**
 * Events emitted during team execution for UI updates.
 */
export type TeamEvent =
	// Team lifecycle
	| { type: "team_start"; teamName: string; agentCount: number }
	| { type: "team_end"; result: TeamResult }
	// Agent lifecycle within team
	| { type: "agent_start"; agentName: string; index: number; total: number }
	| { type: "agent_event"; agentName: string; event: AgentEvent }
	| { type: "agent_end"; agentName: string; result: AgentResult }
	| { type: "agent_error"; agentName: string; error: string; willRetry: boolean }
	| { type: "agent_retry"; agentName: string; attempt: number; maxRetries: number }
	// Task tracking (epsilon integration)
	| { type: "agent_task_update"; agentName: string; taskInfo: AgentTaskInfo }
	// Merge phase
	| { type: "merge_start"; strategy: MergeStrategyType; findingCount: number }
	| { type: "merge_progress"; phase: "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing" }
	| { type: "merge_event"; event: AgentEvent }
	| { type: "merge_end"; mergedCount: number; verifiedCount: number };

/**
 * Event emitter interface for SQLite-backed event persistence.
 *
 * This interface allows the agents package to emit events to the coding-agent's
 * PersistentEventBus without creating a circular dependency. The coding-agent
 * provides an implementation that bridges to its event bus.
 *
 * All methods return the event ID for parent-child relationships.
 */
export interface TeamEventEmitter {
	/** Emit agent_start event. Returns event ID. */
	emitAgentStart(agentName: string, teamName: string): number;

	/** Emit agent_end event. Returns event ID. */
	emitAgentEnd(
		agentName: string,
		teamName: string,
		success: boolean,
		findingCount: number,
		durationMs: number,
		error?: string,
		parentEventId?: number,
	): number;

	/** Emit finding event. Returns event ID. */
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
	): number;

	/** Emit team_start event. Returns event ID. */
	emitTeamStart(teamName: string, agents: string[], task: string): number;

	/** Emit team_end event. Returns event ID. */
	emitTeamEnd(
		teamName: string,
		success: boolean,
		findingCount: number,
		durationMs: number,
		error?: string,
		parentEventId?: number,
	): number;

	/** Emit merge_start event. Returns event ID. */
	emitMergeStart(strategy: string, inputFindingCount: number, parentEventId?: number): number;

	/** Emit merge_end event. Returns event ID. */
	emitMergeEnd(outputFindingCount: number, parentEventId?: number): number;
}

/**
 * Options for Team.run() and Team.execute()
 */
export interface TeamRunOptions {
	/** Abort signal for cancellation */
	signal?: AbortSignal;
	/** Task/prompt describing what the team should analyze or do */
	task?: string;
	/** Initial messages/context to provide to all agents */
	initialMessages?: AgentMessage[];
	/** API key resolver for dynamic keys */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/**
	 * SQLite storage for persistence. When provided:
	 * - Agent results are persisted as they complete
	 * - Merge phase snapshots are saved
	 * - Results can be recovered if execution fails
	 */
	storage?: TeamExecutionStorageInterface;
	/**
	 * Event emitter for SQLite-backed event persistence. When provided:
	 * - agent_start/agent_end events emitted for each agent
	 * - finding events emitted for each parsed finding
	 * - team_start/team_end events emitted for the team
	 * - merge_start/merge_end events emitted for merge phase
	 *
	 * This enables event replay, auditing, and UI subscriptions.
	 */
	eventEmitter?: TeamEventEmitter;
}

/**
 * Interface for team execution storage (decoupled from implementation).
 * Allows dependency injection and testing.
 */
export interface TeamExecutionStorageInterface {
	/** Create a new execution record */
	createExecution(input: { sessionId: string; teamName: string; task: string; agentCount: number }): number;
	/** Update execution status */
	updateExecutionStatus(
		executionId: number,
		status: "pending" | "running" | "merging" | "completed" | "failed" | "aborted",
		error?: string,
	): void;
	/** Create agent result record */
	createAgentResult(executionId: number, agentName: string): number;
	/** Update agent result */
	updateAgentResult(
		agentResultId: number,
		input: {
			status?: "pending" | "running" | "completed" | "failed" | "retrying";
			findings?: Finding[];
			messages?: AgentMessage[];
			usage?: { inputTokens: number; outputTokens: number };
			durationMs?: number;
			error?: string;
		},
	): void;
	/** Create merge phase snapshot */
	createMergeSnapshot(
		executionId: number,
		phase: "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing" | "completed",
		inputData: unknown,
	): number;
	/** Update merge snapshot with output */
	updateMergeSnapshot(snapshotId: number, outputData: unknown): void;
	/** Save final team result */
	saveTeamResult(executionId: number, result: TeamResult): void;
}
