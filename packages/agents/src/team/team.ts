import { type AgentContext, type AgentEvent, type AgentMessage, type AgentTool, agentLoop } from "agent";
import { type AssistantMessage, EventStream, type Message, streamSimple } from "ai";
import { debugLog } from "../debug.js";
import type {
	AgentPreset,
	AgentResult,
	AgentTaskInfo,
	Finding,
	TaskStatus,
	TeamConfig,
	TeamEvent,
	TeamResult,
	TeamRunOptions,
} from "../types.js";

/**
 * Tracks epsilon tasks per agent during team execution.
 * Parses tool execution events to extract task creation/update info.
 *
 * Epsilon tool output formats:
 * - Single create: "Created task #1:\n✓ #1 [priority] Title\n  status | date"
 * - Bulk create:   "Created 3/3 tasks:\nCreated #1: Title\nCreated #2: Title"
 * - Single update: "Updated task #1:\n✓ #1 [priority] Title\n  status | date"
 * - Bulk update:   "Updated 2/2 tasks:\nUpdated #1: Title\nUpdated #2: Title"
 * - Delete:        "Deleted task #1" or "Deleted #1"
 */
class AgentTaskTracker {
	/** Maximum tasks to track per agent to prevent unbounded memory growth */
	private static readonly MAX_TASKS_PER_AGENT = 100;
	private tasks: Map<string, Map<number, { title: string; status: TaskStatus }>> = new Map();

	/**
	 * Process a tool execution event and update task tracking.
	 * Returns updated AgentTaskInfo if task state changed, undefined otherwise.
	 */
	processToolEvent(agentName: string, event: AgentEvent): AgentTaskInfo | undefined {
		try {
			if (event.type !== "tool_execution_end") return undefined;

			const toolName = event.toolName;
			if (!toolName.startsWith("epsilon_task_")) return undefined;

			// Initialize agent task map if needed
			if (!this.tasks.has(agentName)) {
				this.tasks.set(agentName, new Map());
			}
			const agentTasks = this.tasks.get(agentName)!;

			// Parse tool result to extract task info
			const result = event.result;
			if (!result || typeof result !== "object") return undefined;

			// Extract text content from result with explicit type validation
			const text = this.extractTextContent(result);
			if (!text) return undefined;

			// Parse task info from result text
			if (toolName === "epsilon_task_create" || toolName === "epsilon_task_create_bulk") {
				this.parseCreateResult(text, agentTasks);
			} else if (toolName === "epsilon_task_update" || toolName === "epsilon_task_update_bulk") {
				this.parseUpdateResult(text, agentTasks);
			} else if (toolName === "epsilon_task_delete" || toolName === "epsilon_task_delete_bulk") {
				this.parseDeleteResult(text, agentTasks);
			}

			return this.getTaskInfo(agentName);
		} catch (e) {
			// Log error in debug mode (task #313), but don't break progress tracking
			if (process.env.DEBUG_AGENTS) {
				debugLog("task-tracker", "Error processing tool event", {
					agentName,
					toolName: (event as { toolName?: string }).toolName,
					error: e instanceof Error ? e.message : String(e),
				});
			}
			// Return current state (may be partial) rather than crashing
			return this.tasks.has(agentName) ? this.getTaskInfo(agentName) : undefined;
		}
	}

	/**
	 * Extract text content from tool result object.
	 */
	private extractTextContent(result: unknown): string {
		let text = "";
		if (result && typeof result === "object" && "content" in result) {
			const content = (result as { content: unknown }).content;
			if (Array.isArray(content)) {
				for (const item of content) {
					if (
						item &&
						typeof item === "object" &&
						"type" in item &&
						(item as { type: unknown }).type === "text" &&
						"text" in item &&
						typeof (item as { text: unknown }).text === "string"
					) {
						text += (item as { text: string }).text;
					}
				}
			}
		}
		return text;
	}

	/**
	 * Parse task creation result.
	 * Handles both single creates ("Created task #1:\n✓ #1 [pri] Title")
	 * and bulk creates ("Created #1: Title\nCreated #2: Title")
	 */
	private parseCreateResult(text: string, agentTasks: Map<number, { title: string; status: TaskStatus }>): void {
		const lines = text.split("\n");

		// First try bulk format: "Created #123: Title" (title on same line)
		const bulkMatches = text.matchAll(/Created\s+#(\d+):\s+([^\n]+)/gi);
		for (const match of bulkMatches) {
			if (agentTasks.size >= AgentTaskTracker.MAX_TASKS_PER_AGENT) break;
			const id = Number.parseInt(match[1], 10);
			const title = match[2]?.trim() || `Task #${id}`;
			agentTasks.set(id, { title, status: "todo" });
		}

		// Then try single format: "Created task #123:" followed by task details on next line
		// The task detail line format: "✓ #1 [priority] Title [tags]"
		const singleMatch = text.match(/Created\s+task\s+#(\d+):/i);
		if (singleMatch) {
			const id = Number.parseInt(singleMatch[1], 10);
			if (!agentTasks.has(id) && agentTasks.size < AgentTaskTracker.MAX_TASKS_PER_AGENT) {
				// Look for title in the task detail line: "✓ #id [priority] Title"
				// Also handle status icons: ○ ◐ ✓ ✗
				const titleMatch = text.match(/[○◐✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
				const title = titleMatch?.[1]?.trim() || `Task #${id}`;
				// Extract initial status from the status line: "  status | date"
				const statusLine = lines.find((l) => /^\s+(todo|in_progress|blocked|done|cancelled)\s*\|/i.test(l));
				const status = statusLine?.match(/^\s+(todo|in_progress|blocked|done|cancelled)/i)?.[1]?.toLowerCase() as
					| TaskStatus
					| undefined;
				agentTasks.set(id, { title, status: status ?? "todo" });
			}
		}
	}

	/**
	 * Parse task update result.
	 * Handles both single updates and bulk updates, extracting per-task status.
	 */
	private parseUpdateResult(text: string, agentTasks: Map<number, { title: string; status: TaskStatus }>): void {
		const lines = text.split("\n");

		// For bulk updates: "Updated #123: Title" - update each task found
		const bulkMatches = text.matchAll(/Updated\s+#(\d+):\s+([^\n]+)/gi);
		for (const match of bulkMatches) {
			const id = Number.parseInt(match[1], 10);
			const existing = agentTasks.get(id);
			if (existing) {
				const newTitle = match[2]?.trim();
				if (newTitle) existing.title = newTitle;
				// For bulk updates, we can't reliably extract individual status
				// Mark as done since it was successfully updated
			}
		}

		// For single update: "Updated task #123:" followed by task details
		const singleMatch = text.match(/Updated\s+task\s+#(\d+):/i);
		if (singleMatch) {
			const id = Number.parseInt(singleMatch[1], 10);
			const existing = agentTasks.get(id);
			if (existing) {
				// Extract title from detail line: "✓ #id [priority] Title"
				const titleMatch = text.match(/[○◐✓✗]\s+#\d+\s+\[\w+\]\s+([^[\n]+)/);
				if (titleMatch?.[1]) {
					existing.title = titleMatch[1].trim();
				}
				// Extract status from status line: "  status | date"
				const statusLine = lines.find((l) => /^\s+(todo|in_progress|blocked|done|cancelled)\s*\|/i.test(l));
				const status = statusLine?.match(/^\s+(todo|in_progress|blocked|done|cancelled)/i)?.[1]?.toLowerCase() as
					| TaskStatus
					| undefined;
				if (status) {
					existing.status = status;
				}
			}
		}
	}

	/**
	 * Parse task deletion result.
	 */
	private parseDeleteResult(text: string, agentTasks: Map<number, { title: string; status: TaskStatus }>): void {
		// Handle both "Deleted task #123" and "Deleted #123"
		const matches = text.matchAll(/Deleted(?:\s+task)?\s+#(\d+)/gi);
		for (const match of matches) {
			const id = Number.parseInt(match[1], 10);
			agentTasks.delete(id);
		}
	}

	/**
	 * Get current task info for an agent.
	 */
	getTaskInfo(agentName: string): AgentTaskInfo {
		const agentTasks = this.tasks.get(agentName);
		if (!agentTasks || agentTasks.size === 0) {
			return { total: 0, completed: 0 };
		}

		let total = 0;
		let completed = 0;
		let activeTaskTitle: string | undefined;

		for (const task of agentTasks.values()) {
			total++;
			if (task.status === "done" || task.status === "cancelled") {
				completed++;
			} else if (task.status === "in_progress" && !activeTaskTitle) {
				activeTaskTitle = task.title;
			}
		}

		return { total, completed, activeTaskTitle };
	}
}

/**
 * Team orchestrates multiple specialized agents for parallel/sequential execution.
 */
export class Team {
	private config: TeamConfig;
	private abortController: AbortController | null = null;
	private taskTracker: AgentTaskTracker = new AgentTaskTracker();

	constructor(config: TeamConfig) {
		this.config = config;
	}

	/**
	 * Run the team and yield events for UI updates.
	 * Returns an EventStream that emits TeamEvents and resolves to TeamResult.
	 */
	run(options: TeamRunOptions = {}): EventStream<TeamEvent, TeamResult> {
		if (process.env.DEBUG_AGENTS) {
			debugLog("team", "Team.run() called", {
				teamName: this.config.name,
				hasTask: !!options.task,
				hasSignal: !!options.signal,
				hasGetApiKey: !!options.getApiKey,
			});
		}

		const stream = new EventStream<TeamEvent, TeamResult>(
			(event) => event.type === "team_end",
			(event) => (event as { type: "team_end"; result: TeamResult }).result,
		);
		this.abortController = new AbortController();

		// Combine signals - use AbortSignal.any() if available (Node 20+), else fallback
		let combinedSignal: AbortSignal;
		if (options.signal) {
			if (typeof AbortSignal.any === "function") {
				combinedSignal = AbortSignal.any([options.signal, this.abortController.signal]);
			} else {
				// Fallback for older Node versions
				const controller = new AbortController();
				const abort = () => controller.abort();
				options.signal.addEventListener("abort", abort);
				this.abortController.signal.addEventListener("abort", abort);
				combinedSignal = controller.signal;
			}
		} else {
			combinedSignal = this.abortController.signal;
		}

		this.executeInternal(stream, { ...options, signal: combinedSignal });

		return stream;
	}

	/**
	 * Execute the team and return the final result.
	 * Convenience wrapper around run() that collects all events.
	 */
	async execute(options: TeamRunOptions = {}): Promise<TeamResult> {
		const stream = this.run(options);
		return stream.result();
	}

	/**
	 * Abort an in-progress execution.
	 */
	abort(): void {
		this.abortController?.abort();
	}

	private async executeInternal(stream: EventStream<TeamEvent, TeamResult>, options: TeamRunOptions): Promise<void> {
		const startTime = Date.now();
		const { agents, tools, strategy = "parallel", merge, maxRetries = 1, continueOnError = true } = this.config;
		const storage = options.storage;

		// Create execution record in storage if provided
		let executionId: number | undefined;
		if (storage) {
			try {
				executionId = storage.createExecution({
					sessionId: `session-${Date.now()}`, // Session ID from caller context
					teamName: this.config.name,
					task: options.task ?? "No task specified",
					agentCount: agents.length,
				});
				if (process.env.DEBUG_AGENTS) {
					debugLog("team", "Created execution record", { executionId, teamName: this.config.name });
				}
			} catch (err) {
				// Storage errors shouldn't block execution - log and continue
				if (process.env.DEBUG_AGENTS) {
					debugLog("team", "Failed to create execution record", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		if (process.env.DEBUG_AGENTS) {
			debugLog("team", "executeInternal starting", {
				teamName: this.config.name,
				agentCount: agents.length,
				toolCount: tools.length,
				strategy,
				hasTask: !!options.task,
				hasStorage: !!storage,
			});
		}

		stream.push({
			type: "team_start",
			teamName: this.config.name,
			agentCount: agents.length,
		});

		let agentResults: AgentResult[];

		try {
			if (strategy === "parallel") {
				agentResults = await this.executeParallel(
					agents,
					tools,
					options,
					maxRetries,
					continueOnError,
					stream,
					executionId,
				);
			} else {
				agentResults = await this.executeSequential(
					agents,
					tools,
					options,
					maxRetries,
					continueOnError,
					stream,
					executionId,
				);
			}

			// Update execution status to merging
			if (storage && executionId !== undefined) {
				try {
					storage.updateExecutionStatus(executionId, "merging");
				} catch {
					// Ignore storage errors
				}
			}

			// Merge phase
			const allFindings = agentResults.flatMap((r) => r.findings);
			stream.push({
				type: "merge_start",
				strategy: merge.strategy,
				findingCount: allFindings.length,
			});

			const mergeResult = await this.runMerge(agentResults, tools, options, stream, executionId);

			const result: TeamResult = {
				teamName: this.config.name,
				success: agentResults.some((r) => r.success),
				agentResults,
				findings: mergeResult.findings,
				clusters: mergeResult.clusters,
				summary: mergeResult.summary,
				durationMs: Date.now() - startTime,
				totalUsage: this.aggregateUsage(agentResults),
			};

			stream.push({
				type: "merge_end",
				mergedCount: result.findings.length,
				verifiedCount: result.findings.filter((f) => f.verified).length,
			});

			// Save final result to storage
			if (storage && executionId !== undefined) {
				try {
					storage.saveTeamResult(executionId, result);
				} catch {
					// Ignore storage errors
				}
			}

			stream.push({ type: "team_end", result });
			stream.end(result);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			// Update execution status to failed
			if (storage && executionId !== undefined) {
				try {
					storage.updateExecutionStatus(executionId, "failed", errorMessage);
				} catch {
					// Ignore storage errors
				}
			}

			if (process.env.DEBUG_AGENTS) {
				debugLog("team", "executeInternal error", {
					teamName: this.config.name,
					error: errorMessage,
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
			const errorResult: TeamResult = {
				teamName: this.config.name,
				success: false,
				agentResults: [],
				findings: [],
				clusters: [],
				durationMs: Date.now() - startTime,
				error: errorMessage,
			};
			stream.push({ type: "team_end", result: errorResult });
			stream.end(errorResult);
		}
	}

	private async executeParallel(
		agents: AgentPreset[],
		tools: AgentTool[],
		options: TeamRunOptions,
		maxRetries: number,
		continueOnError: boolean,
		stream: EventStream<TeamEvent, TeamResult>,
		executionId?: number,
	): Promise<AgentResult[]> {
		const promises = agents.map((agent, index) =>
			this.executeAgent(
				agent,
				tools,
				options,
				maxRetries,
				continueOnError,
				index,
				agents.length,
				stream,
				executionId,
			),
		);

		return Promise.all(promises);
	}

	private async executeSequential(
		agents: AgentPreset[],
		tools: AgentTool[],
		options: TeamRunOptions,
		maxRetries: number,
		continueOnError: boolean,
		stream: EventStream<TeamEvent, TeamResult>,
		executionId?: number,
	): Promise<AgentResult[]> {
		const results: AgentResult[] = [];

		for (let i = 0; i < agents.length; i++) {
			const result = await this.executeAgent(
				agents[i],
				tools,
				options,
				maxRetries,
				continueOnError,
				i,
				agents.length,
				stream,
				executionId,
			);
			results.push(result);

			// For sequential, previous results could be passed to next agent
			// (not implemented yet - would need context accumulation strategy)
		}

		return results;
	}

	private async executeAgent(
		preset: AgentPreset,
		tools: AgentTool[],
		options: TeamRunOptions,
		maxRetries: number,
		continueOnError: boolean,
		index: number,
		total: number,
		stream: EventStream<TeamEvent, TeamResult>,
		executionId?: number,
	): Promise<AgentResult> {
		const startTime = Date.now();
		let lastError: string | undefined;
		const storage = options.storage;

		// Create agent result record in storage if provided
		let agentResultId: number | undefined;
		if (storage && executionId !== undefined) {
			try {
				agentResultId = storage.createAgentResult(executionId, preset.name);
			} catch {
				// Ignore storage errors
			}
		}

		stream.push({
			type: "agent_start",
			agentName: preset.name,
			index,
			total,
		});

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				stream.push({
					type: "agent_retry",
					agentName: preset.name,
					attempt,
					maxRetries,
				});

				// Update storage with retry status
				if (storage && agentResultId !== undefined) {
					try {
						storage.updateAgentResult(agentResultId, { status: "retrying" });
					} catch {
						// Ignore storage errors
					}
				}
			}

			try {
				const result = await this.runSingleAgent(preset, tools, options, stream);

				// Persist successful result to storage
				if (storage && agentResultId !== undefined) {
					try {
						storage.updateAgentResult(agentResultId, {
							status: "completed",
							findings: result.findings,
							messages: result.messages,
							usage: result.usage,
							durationMs: result.durationMs,
						});
					} catch {
						// Ignore storage errors
					}
				}

				stream.push({
					type: "agent_end",
					agentName: preset.name,
					result,
				});
				return result;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				const willRetry = attempt < maxRetries;

				stream.push({
					type: "agent_error",
					agentName: preset.name,
					error: lastError,
					willRetry,
				});

				if (!willRetry && !continueOnError) {
					// Persist failure to storage
					if (storage && agentResultId !== undefined) {
						try {
							storage.updateAgentResult(agentResultId, {
								status: "failed",
								error: lastError,
								durationMs: Date.now() - startTime,
							});
						} catch {
							// Ignore storage errors
						}
					}
					throw error;
				}
			}
		}

		// All retries exhausted - return failure result
		const failResult: AgentResult = {
			agentName: preset.name,
			success: false,
			error: lastError,
			findings: [],
			messages: [],
			durationMs: Date.now() - startTime,
		};

		// Persist failure to storage
		if (storage && agentResultId !== undefined) {
			try {
				storage.updateAgentResult(agentResultId, {
					status: "failed",
					error: lastError,
					durationMs: failResult.durationMs,
				});
			} catch {
				// Ignore storage errors
			}
		}

		stream.push({
			type: "agent_end",
			agentName: preset.name,
			result: failResult,
		});

		return failResult;
	}

	private async runSingleAgent(
		preset: AgentPreset,
		tools: AgentTool[],
		options: TeamRunOptions,
		stream: EventStream<TeamEvent, TeamResult>,
	): Promise<AgentResult> {
		const startTime = Date.now();
		const messages: AgentMessage[] = [];
		let inputTokens = 0;
		let outputTokens = 0;

		// Debug logging - only resolve API key and log when debugging enabled
		if (process.env.DEBUG_AGENTS) {
			let hasApiKey = false;
			let apiKeyError: string | undefined;
			try {
				const testKey = options.getApiKey ? await options.getApiKey(preset.model.provider) : undefined;
				hasApiKey = !!testKey;
			} catch (e) {
				// Sanitize error message to avoid leaking credentials
				apiKeyError = e instanceof Error ? e.message.replace(/[a-zA-Z0-9_-]{20,}/g, "[REDACTED]") : "unknown error";
			}

			debugLog("team", `runSingleAgent starting`, {
				agent: preset.name,
				model: preset.model.id,
				provider: preset.model.provider,
				toolCount: tools.length,
				toolNames: tools.map((t) => t.name),
				taskLength: options.task?.length ?? 0,
				hasApiKey,
				apiKeyError,
			});

			if (!hasApiKey && !apiKeyError) {
				debugLog("team", `WARNING: No API key for provider ${preset.model.provider}`, {
					agent: preset.name,
					hasGetApiKey: !!options.getApiKey,
				});
			}
		}

		const context: AgentContext = {
			systemPrompt: preset.systemPrompt,
			messages: options.initialMessages ? [...options.initialMessages] : [],
			tools,
		};

		// Create prompt from task or use default
		const taskPrompt = options.task || "Please analyze the code and provide your findings.";
		const prompts: AgentMessage[] = [
			{
				role: "user",
				content: taskPrompt,
				timestamp: Date.now(),
			},
		];

		if (process.env.DEBUG_AGENTS) {
			debugLog("team", `runSingleAgent calling agentLoop`, {
				agent: preset.name,
				signalAborted: options.signal?.aborted ?? false,
				promptCount: prompts.length,
				contextMessageCount: context.messages.length,
				contextToolCount: context.tools?.length ?? 0,
			});
		}

		const agentStream = agentLoop(
			prompts,
			context,
			{
				model: preset.model,
				temperature: preset.temperature,
				maxTokens: preset.maxTokens,
				reasoning: preset.thinkingLevel === "off" ? undefined : preset.thinkingLevel,
				signal: options.signal,
				convertToLlm: (msgs) =>
					msgs.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
				getApiKey: options.getApiKey,
			},
			options.signal,
			streamSimple,
		);

		if (process.env.DEBUG_AGENTS) {
			debugLog("team", `runSingleAgent agentLoop created, starting iteration`, {
				agent: preset.name,
			});
		}

		const isDebugEnabled = !!process.env.DEBUG_AGENTS;
		let eventCount = 0;
		// Forward agent events
		for await (const event of agentStream) {
			eventCount++;
			if (isDebugEnabled) {
				if (
					eventCount <= 5 ||
					event.type === "message_end" ||
					event.type === "turn_end" ||
					event.type === "agent_end"
				) {
					debugLog("team", `agent event ${eventCount}`, {
						agent: preset.name,
						eventType: event.type,
						hasMessage: "message" in event,
					});
				}
				// Log message details on message_end (content truncated for privacy)
				if (event.type === "message_end") {
					const msg = event.message as unknown as Record<string, unknown>;
					const content = msg.content;
					debugLog("team", `agent message_end`, {
						agent: preset.name,
						role: msg.role,
						contentType: typeof content,
						contentLength: Array.isArray(content) ? content.length : String(content || "").length,
						stopReason: msg.stopReason,
						usage: msg.usage,
					});
				}
			}

			stream.push({
				type: "agent_event",
				agentName: preset.name,
				event,
			});

			// Track epsilon task updates
			const taskInfo = this.taskTracker.processToolEvent(preset.name, event);
			if (taskInfo) {
				stream.push({
					type: "agent_task_update",
					agentName: preset.name,
					taskInfo,
				});
			}

			// Collect messages
			if (event.type === "message_end") {
				messages.push(event.message);
			}

			// Track usage from completed messages
			if (event.type === "message_end" && event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				inputTokens += assistantMsg.usage?.input ?? 0;
				outputTokens += assistantMsg.usage?.output ?? 0;
			}
		}

		// Parse findings from assistant messages
		const findings = this.parseFindings(preset.name, messages);

		if (process.env.DEBUG_AGENTS) {
			debugLog("team", `runSingleAgent completed`, {
				agent: preset.name,
				durationMs: Date.now() - startTime,
				messageCount: messages.length,
				findingCount: findings.length,
				inputTokens,
				outputTokens,
			});
		}

		return {
			agentName: preset.name,
			success: true,
			findings,
			messages,
			durationMs: Date.now() - startTime,
			usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
		};
	}

	private async runMerge(
		agentResults: AgentResult[],
		tools: AgentTool[],
		options: TeamRunOptions,
		stream: EventStream<TeamEvent, TeamResult>,
		executionId?: number,
	): Promise<Pick<TeamResult, "findings" | "clusters" | "summary">> {
		const { merge } = this.config;
		const allFindings = agentResults.flatMap((r) => r.findings);
		const storage = options.storage;

		// Import merge executor dynamically to avoid circular deps
		const { getMergeExecutor } = await import("../strategies/index.js");
		const executor = getMergeExecutor(merge.strategy);

		if (!executor) {
			// Fallback: return findings as-is without merge
			return {
				findings: allFindings,
				clusters: [],
				summary: undefined,
			};
		}

		// Track current merge snapshot for persistence
		let currentSnapshotId: number | undefined;

		stream.push({ type: "merge_progress", phase: "parsing" });

		// Create initial merge snapshot with input data
		if (storage && executionId !== undefined) {
			try {
				currentSnapshotId = storage.createMergeSnapshot(executionId, "parsing", {
					findingCount: allFindings.length,
					agentCount: agentResults.length,
				});
			} catch {
				// Ignore storage errors
			}
		}

		const result = await executor.execute(allFindings, {
			mergeAgent: merge.mergeAgent,
			tools,
			signal: options.signal,
			getApiKey: options.getApiKey,
			onEvent: (event: AgentEvent) => {
				stream.push({ type: "merge_event", event });
			},
			onProgress: (phase: "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing") => {
				stream.push({ type: "merge_progress", phase });

				// Create snapshot for each phase transition
				if (storage && executionId !== undefined) {
					try {
						// Update previous snapshot's output before creating new one
						if (currentSnapshotId !== undefined) {
							storage.updateMergeSnapshot(currentSnapshotId, { phase, transitionTime: Date.now() });
						}
						currentSnapshotId = storage.createMergeSnapshot(executionId, phase, {
							phase,
							startTime: Date.now(),
						});
					} catch {
						// Ignore storage errors
					}
				}
			},
		});

		// Update final snapshot with merge result
		if (storage && currentSnapshotId !== undefined) {
			try {
				storage.updateMergeSnapshot(currentSnapshotId, result);
			} catch {
				// Ignore storage errors
			}
		}

		return result;
	}

	private parseFindings(agentName: string, messages: AgentMessage[]): Finding[] {
		const findings: Finding[] = [];
		let findingCounter = 0;

		for (const msg of messages) {
			if (msg.role !== "assistant") continue;

			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");

			// Parse structured findings from markdown
			const findingBlocks = content.split(/###\s+Finding:/i).slice(1);

			for (const block of findingBlocks) {
				const finding = this.parseFindingBlock(agentName, block, ++findingCounter);
				if (finding) {
					findings.push(finding);
				}
			}
		}

		return findings;
	}

	private parseFindingBlock(agentName: string, block: string, index: number): Finding | null {
		const lines = block.split("\n");
		const title = lines[0]?.trim() || `Finding ${index}`;

		// More flexible patterns that handle variations in formatting
		// Support both **Label:** and **label:** (case insensitive), with optional spaces
		const severityMatch = block.match(/\*{0,2}severity\*{0,2}[:\s]+(\w+)/i);
		const categoryMatch = block.match(/\*{0,2}category\*{0,2}[:\s]+(\w+)/i);
		const fileMatch = block.match(/\*{0,2}file\*{0,2}[:\s]+([^\n*]+)/i);
		const lineMatch = block.match(/\*{0,2}line(?:s)?\*{0,2}[:\s]+(\d+)(?:\s*[-–]\s*(\d+))?/i);
		const confidenceMatch = block.match(/\*{0,2}confidence\*{0,2}[:\s]+([\d.]+)/i);
		// Support multiple CWE formats
		const cweMatches = block.matchAll(/\b(CWE-\d+)\b/gi);

		// Parse description/suggestion by finding content between labeled sections
		// Using line-based parsing to avoid ReDoS with [\s\S]*? patterns
		const descMatch = this.extractLabeledContent(block, ["description"]);
		const suggestionMatch = this.extractLabeledContent(block, ["suggestion", "fix", "recommendation"]);
		const codeMatch = block.match(/```[\w]*\n?([^`]+)```/);

		const rawSeverity = severityMatch?.[1]?.toLowerCase();
		const severity = (
			["critical", "high", "medium", "low", "info"].includes(rawSeverity ?? "") ? rawSeverity : "medium"
		) as Finding["severity"];

		const rawCategory = categoryMatch?.[1]?.toLowerCase();
		const category = (
			["security", "bug", "performance", "style", "maintainability", "other"].includes(rawCategory ?? "")
				? rawCategory
				: "other"
		) as Finding["category"];

		const references: string[] = [];
		for (const match of cweMatches) {
			if (!references.includes(match[1].toUpperCase())) {
				references.push(match[1].toUpperCase());
			}
		}

		// Log unparsed blocks for debugging (only in debug mode)
		if (process.env.DEBUG_AGENTS && !severityMatch && !descMatch) {
			debugLog("team", "Could not parse finding block", {
				agentName,
				index,
				blockLength: block.length,
				firstLine: lines[0]?.slice(0, 100),
			});
		}

		return {
			id: `${agentName}-${index}`,
			agentName,
			severity,
			category,
			file: fileMatch?.[1]?.trim(),
			line: lineMatch
				? lineMatch[2]
					? [Number(lineMatch[1]), Number(lineMatch[2])]
					: Number(lineMatch[1])
				: undefined,
			title,
			description: descMatch?.trim() || block.slice(0, 200),
			suggestion: suggestionMatch?.trim(),
			codeSnippet: codeMatch?.[1]?.trim(),
			confidence: confidenceMatch ? Number(confidenceMatch[1]) : undefined,
			references: references.length > 0 ? references : undefined,
		};
	}

	/**
	 * Extract content following a labeled section (e.g., **Description:**).
	 * Uses line-based parsing to avoid ReDoS-vulnerable [\s\S]*? patterns.
	 */
	private extractLabeledContent(block: string, labels: string[]): string | undefined {
		const lines = block.split("\n");
		const labelPattern = new RegExp(`^\\*{0,2}(${labels.join("|")})\\*{0,2}[:\\s]+(.*)$`, "i");
		const nextLabelPattern =
			/^\*{0,2}(severity|category|file|lines?|suggestion|fix|recommendation|confidence|description)\*{0,2}[:\s]/i;
		const codeBlockPattern = /^```/;

		let capturing = false;
		const captured: string[] = [];

		for (const line of lines) {
			if (!capturing) {
				const match = line.match(labelPattern);
				if (match) {
					capturing = true;
					// First line may have content after the label
					if (match[2]?.trim()) {
						captured.push(match[2].trim());
					}
				}
			} else {
				// Stop at next label or code block
				if (nextLabelPattern.test(line) || codeBlockPattern.test(line)) {
					break;
				}
				captured.push(line);
			}
		}

		return captured.length > 0 ? captured.join("\n") : undefined;
	}

	private aggregateUsage(results: AgentResult[]): TeamResult["totalUsage"] {
		let inputTokens = 0;
		let outputTokens = 0;
		let hasUsage = false;

		for (const result of results) {
			if (result.usage) {
				hasUsage = true;
				inputTokens += result.usage.inputTokens;
				outputTokens += result.usage.outputTokens;
			}
		}

		return hasUsage ? { inputTokens, outputTokens } : undefined;
	}
}

/**
 * Create a team from configuration.
 */
export function createTeam(config: TeamConfig): Team {
	return new Team(config);
}
