import { type AgentContext, type AgentEvent, type AgentMessage, type AgentTool, agentLoop } from "agent";
import { type AssistantMessage, EventStream, type Message, streamSimple } from "ai";
import { debugLog } from "../debug.js";
import type { AgentPreset, AgentResult, Finding, TeamConfig, TeamEvent, TeamResult, TeamRunOptions } from "../types.js";

/**
 * Team orchestrates multiple specialized agents for parallel/sequential execution.
 */
export class Team {
	private config: TeamConfig;
	private abortController: AbortController | null = null;

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

		if (process.env.DEBUG_AGENTS) {
			debugLog("team", "executeInternal starting", {
				teamName: this.config.name,
				agentCount: agents.length,
				toolCount: tools.length,
				strategy,
				hasTask: !!options.task,
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
				agentResults = await this.executeParallel(agents, tools, options, maxRetries, continueOnError, stream);
			} else {
				agentResults = await this.executeSequential(agents, tools, options, maxRetries, continueOnError, stream);
			}

			// Merge phase
			const allFindings = agentResults.flatMap((r) => r.findings);
			stream.push({
				type: "merge_start",
				strategy: merge.strategy,
				findingCount: allFindings.length,
			});

			const mergeResult = await this.runMerge(agentResults, tools, options, stream);

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

			stream.push({ type: "team_end", result });
			stream.end(result);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
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
	): Promise<AgentResult[]> {
		const promises = agents.map((agent, index) =>
			this.executeAgent(agent, tools, options, maxRetries, continueOnError, index, agents.length, stream),
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
	): Promise<AgentResult> {
		const startTime = Date.now();
		let lastError: string | undefined;

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
			}

			try {
				const result = await this.runSingleAgent(preset, tools, options, stream);
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
	): Promise<Pick<TeamResult, "findings" | "clusters" | "summary">> {
		const { merge } = this.config;
		const allFindings = agentResults.flatMap((r) => r.findings);

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

		stream.push({ type: "merge_progress", phase: "parsing" });

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
			},
		});

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

		const severityMatch = block.match(/\*\*Severity:\*\*\s*(\w+)/i);
		const categoryMatch = block.match(/\*\*Category:\*\*\s*(\w+)/i);
		const fileMatch = block.match(/\*\*File:\*\*\s*(.+)/i);
		const lineMatch = block.match(/\*\*Line:\*\*\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);
		const confidenceMatch = block.match(/\*\*Confidence:\*\*\s*([\d.]+)/i);
		const cweMatch = block.match(/\*\*CWE:\*\*\s*(CWE-\d+)/i);

		const descMatch = block.match(/\*\*Description:\*\*\s*([\s\S]*?)(?=\*\*|```|$)/i);
		const suggestionMatch = block.match(/\*\*Suggestion:\*\*\s*([\s\S]*?)(?=\*\*|```|$)/i);
		const codeMatch = block.match(/```[\w]*\n([\s\S]*?)```/);

		const severity = (severityMatch?.[1]?.toLowerCase() || "medium") as Finding["severity"];
		const category = (categoryMatch?.[1]?.toLowerCase() || "other") as Finding["category"];

		const references: string[] = [];
		if (cweMatch) references.push(cweMatch[1]);

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
			description: descMatch?.[1]?.trim() || block.slice(0, 200),
			suggestion: suggestionMatch?.[1]?.trim(),
			codeSnippet: codeMatch?.[1]?.trim(),
			confidence: confidenceMatch ? Number(confidenceMatch[1]) : undefined,
			references: references.length > 0 ? references : undefined,
		};
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
