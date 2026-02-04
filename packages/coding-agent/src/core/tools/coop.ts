/**
 * Coop Tool - Team cooperation for coding tasks.
 *
 * Provides main agent access to team orchestrators for any coding task.
 * Uses intent-based interface - describe what you need and the system
 * selects optimal teams automatically.
 *
 * Usage:
 *   coop({
 *     intent: "implement user authentication with OAuth",
 *     scope: "src/auth",
 *     depth: "thorough"
 *   })
 */

import { type Static, Type } from "@sinclair/typebox";
import {
	type AgentContext,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	agentLoop,
} from "agent";
import { createPreset, debugLog, type Finding, leadAnalyzerTemplate, type TeamEvent, type TeamResult } from "agents";
import type { Api, Message, Model } from "ai";
import { streamSimple } from "ai";
import type { ModelRegistry } from "../model-registry.js";
import { getProjectAnalyzerToolsArray } from "./project-analyzer.js";

// Schema

const coopSchema = Type.Object({
	intent: Type.String({
		description:
			"What you need help with. Examples: 'security audit', 'implement auth system', 'refactor for performance', 'prepare for production'",
	}),
	scope: Type.Optional(
		Type.String({
			description:
				"Scope of the task. Examples: 'src/auth', 'recent changes', 'full codebase'. Default: full codebase",
		}),
	),
	depth: Type.Optional(
		Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("thorough")], {
			description: "Depth level. quick=fast, standard=balanced, thorough=comprehensive. Default: standard",
		}),
	),
	focus: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Areas to focus on. Examples: ['security', 'performance', 'types', 'testing']. Default: auto-selected based on intent",
		}),
	),
});

type CoopParams = Static<typeof coopSchema>;

// Types

export interface CoopResult {
	teamsRun: string[];
	findings: Finding[];
	summary: string;
	executionTimeMs: number;
}

/** Phase of the coop tool execution */
export type CoopPhase =
	| "lead_analyzing" // Lead analyzer is running
	| "lead_complete" // Lead analyzer finished, teams selected
	| "lead_failed" // Lead analyzer failed
	| "team_executing" // Teams are being executed
	| "complete"; // All done

export interface CoopToolDetails {
	/** Teams that were executed */
	teamsRun: string[];
	/** Total findings count */
	findingCount: number;
	/** Critical severity findings count */
	criticalCount: number;
	/** High severity findings count */
	highCount: number;
	/** Total execution time in ms */
	executionTimeMs: number;
	/** Current phase of execution */
	phase?: CoopPhase;
	/** Lead task event for progress display (during lead_analyzing phase) */
	leadTaskEvent?: LeadTaskEvent;
	/** Lead tool event for progress display (during lead_analyzing phase) */
	leadToolEvent?: LeadToolEvent;
	/** Selected teams from lead analyzer (available after lead_complete) */
	selectedTeams?: string[];
	/** Lead analyzer reasoning (available after lead_complete) */
	reasoning?: string;
	/** Error message if lead failed */
	errorMessage?: string;
	/** Team event for streaming progress (only in updates during team_executing phase) */
	teamEvent?: TeamEvent;
	/** Agent names for the current team (set at team start) */
	agentNames?: string[];
}

interface LeadAnalyzerOutput {
	intent: string;
	selectedTeams: string[];
	executionWaves: string[][];
	reasoning: string;
}

// Built-in teams for validation (subset of BUILTIN_TEAMS for tool context)
const VALID_TEAM_NAMES = new Set([
	// Validation teams
	"code-review",
	"full-audit",
	"validate",
	"security-audit",
	"security-deep",
	"performance",
	"quality",
	"types",
	"testing",
	"architecture",
	"api-review",
	"frontend",
	"accessibility",
	"docs",
	"dependencies",
	"quality-gate",
	// Verification teams
	"verify",
	"test-planning",
	"acceptance",
	// Delivery teams
	"pre-release",
	"deliver",
	"release-prep",
	// Workflow teams
	"before-coding",
	"after-coding",
	"quick-fix",
	"feature",
]);

// Implementation

/**
 * Parse epsilon task tool result to extract task event.
 */
function parseEpsilonTaskEvent(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
): LeadTaskEvent | undefined {
	// Extract task ID from result text (e.g., "Created task #123" or "Updated task #123")
	const resultText =
		typeof result === "string"
			? result
			: ((result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "");

	const idMatch = resultText.match(/#(\d+)/);
	const taskId = idMatch ? Number.parseInt(idMatch[1], 10) : (args.id as number);

	if (!taskId) return undefined;

	if (toolName === "epsilon_task_create") {
		return {
			type: "create",
			taskId,
			title: args.title as string,
			status: (args.status as string) ?? "todo",
			args,
		};
	}

	if (toolName === "epsilon_task_update") {
		return {
			type: "update",
			taskId,
			title: args.title as string | undefined,
			status: args.status as string | undefined,
			args,
		};
	}

	if (toolName === "epsilon_task_delete") {
		return {
			type: "delete",
			taskId,
		};
	}

	return undefined;
}

interface LeadAnalyzerResult {
	output: LeadAnalyzerOutput | null;
	error?: string;
}

/** Epsilon task event captured from lead analyzer */
export interface LeadTaskEvent {
	type: "create" | "update" | "delete";
	taskId: number;
	title?: string;
	status?: string;
	args?: Record<string, unknown>;
}

/** Tool activity event captured from lead analyzer */
export interface LeadToolEvent {
	type: "start" | "end";
	toolName: string;
	toolCallId: string;
	/** File path for read/edit/write tools */
	path?: string;
	/** Command for bash tool */
	command?: string;
	/** Search pattern extracted from bash command (rg/fd) */
	pattern?: string;
	/** Directory being searched (for rg/fd) */
	directory?: string;
	/** Line count in result (for read tool on end) */
	lineCount?: number;
	/** Whether the tool execution failed */
	isError?: boolean;
}

/**
 * Parse tool args into LeadToolEvent for display.
 */
function parseLeadToolStart(toolName: string, toolCallId: string, args: Record<string, unknown>): LeadToolEvent {
	const event: LeadToolEvent = { type: "start", toolName, toolCallId };

	// Handle Read tool
	if (toolName === "Read" || toolName === "read") {
		event.path = args.path as string | undefined;
	}
	// Handle Bash tool
	else if (toolName === "Bash" || toolName === "bash") {
		const command = args.command as string | undefined;
		event.command = command;

		// Extract search pattern and directory from rg/fd commands
		if (command) {
			// ripgrep: rg "pattern" [directory]
			const rgMatch = command.match(/\brg\s+(?:-[^\s]+\s+)*["']?([^"'\s]+)["']?\s*([^\s|>]*)?/);
			if (rgMatch) {
				event.pattern = rgMatch[1];
				event.directory = rgMatch[2] || ".";
			}
			// fd: fd "pattern" [directory]
			const fdMatch = command.match(/\bfd\s+(?:-[^\s]+\s+)*["']?([^"'\s]+)["']?\s*([^\s|>]*)?/);
			if (fdMatch) {
				event.pattern = fdMatch[1];
				event.directory = fdMatch[2] || ".";
			}
		}
	}
	// Handle project analyzer tools
	else if (toolName.startsWith("analyze_")) {
		// analyze_project_structure, analyze_dependencies, etc.
		event.directory = args.directory as string | undefined;
	}

	return event;
}

/**
 * Parse tool result into LeadToolEvent end event.
 */
function parseLeadToolEnd(
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	result: unknown,
	isError: boolean,
): LeadToolEvent {
	const event: LeadToolEvent = { type: "end", toolName, toolCallId, isError };

	// Copy relevant fields from start
	if (toolName === "Read" || toolName === "read") {
		event.path = args.path as string | undefined;
		// Count lines in result
		const resultText =
			typeof result === "string"
				? result
				: ((result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "");
		if (resultText && !isError) {
			event.lineCount = resultText.split("\n").length;
		}
	} else if (toolName === "Bash" || toolName === "bash") {
		event.command = args.command as string | undefined;
	}

	return event;
}

/**
 * Run the lead analyzer to select teams based on intent.
 * @param onTaskEvent - Called when epsilon task events occur (for UI progress)
 * @param onToolEvent - Called when tool execution events occur (for UI progress)
 */
async function runLeadAnalyzer(
	intent: string,
	scope: string | undefined,
	depth: string | undefined,
	focus: string[] | undefined,
	cwd: string,
	model: Model<Api>,
	getApiKey: () => Promise<string | undefined>,
	sessionTools: AgentTool[],
	signal?: AbortSignal,
	onTaskEvent?: (event: LeadTaskEvent) => void,
	onToolEvent?: (event: LeadToolEvent) => void,
): Promise<LeadAnalyzerResult> {
	// Create lead agent preset
	const leadPreset = createPreset(leadAnalyzerTemplate, model, {
		injectEpsilon: true, // Enable epsilon for task progress tracking
	});

	// Get project analyzer tools + delta tools + epsilon tools from session
	const projectTools = getProjectAnalyzerToolsArray(cwd);
	const deltaTools = sessionTools.filter((t) => t.name.startsWith("delta_"));
	const epsilonTools = sessionTools.filter((t) => t.name.startsWith("epsilon_"));
	const leadTools = [...projectTools, ...deltaTools, ...epsilonTools];

	// Build enhanced prompt with tool parameters
	const scopeHint = scope ? `\nScope: Focus on ${scope}` : "";
	const depthHint = depth ? `\nDepth: ${depth} review requested` : "";
	const focusHint = focus?.length ? `\nFocus areas: ${focus.join(", ")}` : "";

	const prompt = `User request: "${intent}"${scopeHint}${depthHint}${focusHint}

Please analyze this request and the project to determine which teams should be run.

1. First, search your memory for past context about this project
2. Analyze the project structure, dependencies, languages, and configs
3. Select the appropriate teams based on the request and project
4. Output your decision as JSON

Remember to persist any valuable findings for future sessions.`;

	// Create agent context
	const context: AgentContext = {
		systemPrompt: leadPreset.systemPrompt,
		messages: [],
		tools: leadTools,
	};

	const prompts: AgentMessage[] = [
		{
			role: "user",
			content: prompt,
			timestamp: Date.now(),
		},
	];

	// Run agent loop
	let lastAssistantContent = "";
	const apiKey = await getApiKey();

	if (!apiKey) {
		debugLog("coop", "No API key available for lead analyzer", { provider: model.provider });
		return { output: null, error: `No API key configured for ${model.provider}` };
	}

	const agentStream = agentLoop(
		prompts,
		context,
		{
			model,
			temperature: leadPreset.temperature,
			reasoning: leadPreset.thinkingLevel === "off" ? undefined : leadPreset.thinkingLevel,
			convertToLlm: (msgs) =>
				msgs.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
			getApiKey: async () => apiKey,
		},
		signal,
		streamSimple,
	);

	let eventCount = 0;
	let lastError: string | undefined;
	// Cache tool args from start events (tool_execution_end doesn't have args)
	const toolArgsCache = new Map<string, Record<string, unknown>>();

	try {
		for await (const event of agentStream) {
			eventCount++;

			// Cache args from start events (for all tools, not just epsilon)
			if (event.type === "tool_execution_start") {
				toolArgsCache.set(event.toolCallId, event.args);

				// Emit tool start event for non-epsilon tools
				if (!event.toolName.startsWith("epsilon_task_") && !event.toolName.startsWith("delta_")) {
					const toolEvent = parseLeadToolStart(event.toolName, event.toolCallId, event.args);
					onToolEvent?.(toolEvent);
				}
			}

			// Capture tool end events
			if (event.type === "tool_execution_end") {
				const args = toolArgsCache.get(event.toolCallId) ?? {};
				toolArgsCache.delete(event.toolCallId);

				// Epsilon task events for UI progress display
				if (event.toolName.startsWith("epsilon_task_")) {
					const taskEvent = parseEpsilonTaskEvent(event.toolName, args, event.result);
					if (taskEvent) {
						onTaskEvent?.(taskEvent);
					}
				}
				// Non-epsilon/delta tool events for activity display
				else if (!event.toolName.startsWith("delta_")) {
					const toolEvent = parseLeadToolEnd(event.toolName, event.toolCallId, args, event.result, event.isError);
					onToolEvent?.(toolEvent);
				}
			}

			if (event.type === "message_end" && event.message.role === "assistant") {
				const content = event.message.content;
				if (typeof content === "string") {
					lastAssistantContent = content;
				} else {
					lastAssistantContent = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				}
				// Check for error in message
				const msg = event.message as { errorMessage?: string };
				if (msg.errorMessage) {
					lastError = msg.errorMessage;
				}
			}
		}
	} catch (streamError) {
		const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
		debugLog("coop", "Lead analyzer stream error", { error: errorMsg, eventCount });
		return { output: null, error: `Stream error: ${errorMsg}` };
	}

	debugLog("coop", "Lead analyzer stream completed", {
		eventCount,
		contentLength: lastAssistantContent.length,
		hasError: !!lastError,
		contentPreview: lastAssistantContent.slice(0, 200),
	});

	// Check for empty response
	if (!lastAssistantContent.trim()) {
		debugLog("coop", "Lead analyzer returned empty content", { lastError });
		return { output: null, error: lastError || "Lead analyzer returned no text content" };
	}

	// Parse JSON from response
	const parsed = parseLeadOutput(lastAssistantContent);
	if (!parsed) {
		return {
			output: null,
			error: `Failed to parse lead analyzer output. Response did not contain valid team selection JSON.\n\nResponse preview: ${lastAssistantContent.slice(0, 300)}`,
		};
	}

	return { output: parsed };
}

/**
 * Parse the lead analyzer's JSON output.
 */
function parseLeadOutput(content: string): LeadAnalyzerOutput | null {
	// Extract JSON block
	const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
	const jsonStr = jsonMatch ? jsonMatch[1].trim() : content;

	try {
		const parsed = JSON.parse(jsonStr);

		// Validate required fields
		if (!parsed.selectedTeams || !Array.isArray(parsed.selectedTeams)) {
			debugLog("coop", "Lead output missing selectedTeams", { parsed });
			return null;
		}

		// Filter to valid teams
		const selectedTeams = parsed.selectedTeams.filter((t: string) => VALID_TEAM_NAMES.has(t));

		if (selectedTeams.length === 0) {
			debugLog("coop", "No valid teams in lead output", { parsed });
			return null;
		}

		return {
			intent: parsed.intent || "general review",
			selectedTeams,
			executionWaves: parsed.executionWaves || [selectedTeams],
			reasoning: parsed.reasoning || "",
		};
	} catch (e) {
		debugLog("coop", "Failed to parse lead output", { error: e, content });
		return null;
	}
}

/**
 * Execute selected teams and collect findings.
 * Streams team events via onTeamEvent callback for UI progress display.
 */
async function executeTeams(
	teamNames: string[],
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	sessionTools: AgentTool[],
	onTeamEvent?: (event: TeamEvent, agentNames: string[]) => void,
	signal?: AbortSignal,
): Promise<TeamResult[]> {
	const results: TeamResult[] = [];

	// Import team command helpers dynamically to avoid circular deps
	const { createTeamStream, BUILTIN_TEAMS, getTeamAgentNames } = await import("../commands/team.js");

	for (const teamName of teamNames) {
		// Check for abort
		if (signal?.aborted) {
			break;
		}

		// Find the built-in team config
		const builtinTeam = BUILTIN_TEAMS.find((t) => t.name === teamName);
		if (!builtinTeam) {
			debugLog("coop", `Unknown team: ${teamName}`);
			continue;
		}

		try {
			// Get agent names for this team
			const agentNames = getTeamAgentNames(teamName);

			// Create team stream
			const { stream } = createTeamStream(teamName, {
				model,
				modelRegistry,
				tools: sessionTools,
				task: `Team review: ${teamName}`,
				signal,
			});

			// Consume stream, forwarding events for UI progress
			let result: TeamResult | undefined;
			for await (const event of stream) {
				// Forward all events for UI display
				onTeamEvent?.(event, agentNames);

				if (event.type === "team_end") {
					result = event.result;
				}
			}

			if (result) {
				results.push(result);
			}
		} catch (error) {
			debugLog("coop", `Team ${teamName} failed`, { error });
			// Continue with other teams
		}
	}

	return results;
}

/**
 * Aggregate findings from multiple team results.
 */
function aggregateFindings(results: TeamResult[]): Finding[] {
	const allFindings: Finding[] = [];

	for (const result of results) {
		if (result.findings) {
			allFindings.push(...result.findings);
		}
	}

	// Sort by severity (critical > high > medium > low > info)
	const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
	allFindings.sort((a, b) => {
		const aOrder = severityOrder[a.severity as keyof typeof severityOrder] ?? 5;
		const bOrder = severityOrder[b.severity as keyof typeof severityOrder] ?? 5;
		return aOrder - bOrder;
	});

	return allFindings;
}

/**
 * Generate executive summary from findings.
 */
function generateSummary(teamsRun: string[], findings: Finding[], executionTimeMs: number): string {
	const critical = findings.filter((f) => f.severity === "critical").length;
	const high = findings.filter((f) => f.severity === "high").length;
	const medium = findings.filter((f) => f.severity === "medium").length;
	const low = findings.filter((f) => f.severity === "low").length;
	const info = findings.filter((f) => f.severity === "info").length;

	const lines: string[] = [];

	lines.push(`## Team Review Summary`);
	lines.push(``);
	lines.push(`**Teams executed:** ${teamsRun.join(", ")}`);
	lines.push(`**Execution time:** ${(executionTimeMs / 1000).toFixed(1)}s`);
	lines.push(``);

	// Severity breakdown
	lines.push(`### Findings by Severity`);
	if (critical > 0) lines.push(`- 🔴 **Critical:** ${critical}`);
	if (high > 0) lines.push(`- 🟠 **High:** ${high}`);
	if (medium > 0) lines.push(`- 🟡 **Medium:** ${medium}`);
	if (low > 0) lines.push(`- 🟢 **Low:** ${low}`);
	if (info > 0) lines.push(`- ⚪ **Info:** ${info}`);
	if (findings.length === 0) lines.push(`- No findings`);
	lines.push(``);

	// Top critical/high findings
	const topFindings = findings.filter((f) => f.severity === "critical" || f.severity === "high").slice(0, 5);
	if (topFindings.length > 0) {
		lines.push(`### Top Priority Findings`);
		for (const finding of topFindings) {
			const location = finding.file ? ` in \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
			lines.push(`- **[${finding.severity.toUpperCase()}]** ${finding.title}${location}`);
			if (finding.description) {
				// Truncate long descriptions
				const desc =
					finding.description.length > 200 ? `${finding.description.slice(0, 200)}...` : finding.description;
				lines.push(`  ${desc}`);
			}
		}
	}

	return lines.join("\n");
}

// Tool factory

export interface CoopToolOptions {
	/** Working directory */
	cwd: string;
	/** Function to get current model (dynamic - model can change) */
	getModel: () => Model<Api> | undefined;
	/** Model registry for API key lookups and team execution */
	modelRegistry: ModelRegistry;
	/** Function to get session tools (dynamic - tools can change) */
	getSessionTools: () => AgentTool[];
}

/**
 * Create the coop tool for team cooperation.
 *
 * This tool uses accessor functions rather than direct values because:
 * - Model can change during a session (via /model command)
 * - Session tools can change (extensions can add/remove tools)
 */
export function createCoopTool(options: CoopToolOptions): AgentTool<typeof coopSchema, CoopToolDetails> {
	const { cwd, getModel, modelRegistry, getSessionTools } = options;

	return {
		name: "coop",
		label: "coop",
		description:
			"Coordinate team cooperation for any coding task. Describe your intent and the system selects optimal teams. Use for implementation, refactoring, reviews, audits, testing, and any complex task benefiting from specialized agents.",
		parameters: coopSchema,
		execute: async (
			_toolCallId: string,
			params: CoopParams,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<CoopToolDetails>,
		): Promise<AgentToolResult<CoopToolDetails>> => {
			const startTime = Date.now();
			const { intent, scope, depth, focus } = params;

			// Get current model
			const model = getModel();
			if (!model) {
				return {
					content: [{ type: "text", text: "No model configured. Cannot run coop." }],
					details: {
						teamsRun: [],
						findingCount: 0,
						criticalCount: 0,
						highCount: 0,
						executionTimeMs: Date.now() - startTime,
					},
				};
			}

			// Get session tools for team execution
			const sessionTools = getSessionTools();

			// Create getApiKey wrapper for this model
			const getApiKeyForModel = () => modelRegistry.getApiKey(model);

			// Helper to emit phase updates for UI progress display
			const emitPhaseUpdate = (phase: CoopPhase, extra?: Partial<CoopToolDetails>) => {
				onUpdate?.({
					content: [{ type: "text", text: `Team review: ${phase}` }],
					details: {
						teamsRun: [],
						findingCount: 0,
						criticalCount: 0,
						highCount: 0,
						executionTimeMs: Date.now() - startTime,
						phase,
						...extra,
					},
				});
			};

			// Helper to emit lead task events for UI progress display
			const emitLeadTaskEvent = (taskEvent: LeadTaskEvent) => {
				onUpdate?.({
					content: [{ type: "text", text: `Lead analyzing: task ${taskEvent.type}` }],
					details: {
						teamsRun: [],
						findingCount: 0,
						criticalCount: 0,
						highCount: 0,
						executionTimeMs: Date.now() - startTime,
						phase: "lead_analyzing",
						leadTaskEvent: taskEvent,
					},
				});
			};

			// Helper to emit lead tool events for UI progress display
			const emitLeadToolEvent = (toolEvent: LeadToolEvent) => {
				onUpdate?.({
					content: [{ type: "text", text: `Lead analyzing: ${toolEvent.toolName}` }],
					details: {
						teamsRun: [],
						findingCount: 0,
						criticalCount: 0,
						highCount: 0,
						executionTimeMs: Date.now() - startTime,
						phase: "lead_analyzing",
						leadToolEvent: toolEvent,
					},
				});
			};

			// Helper to stream team events via onUpdate for UI progress display
			const streamTeamEvent = (event: TeamEvent, agentNames: string[]) => {
				onUpdate?.({
					content: [{ type: "text", text: `Team execution in progress...` }],
					details: {
						teamsRun: [],
						findingCount: 0,
						criticalCount: 0,
						highCount: 0,
						executionTimeMs: Date.now() - startTime,
						phase: "team_executing",
						teamEvent: event,
						agentNames,
					},
				});
			};

			// Step 1: Run lead analyzer to select teams
			emitPhaseUpdate("lead_analyzing");

			let leadResult: LeadAnalyzerOutput | null = null;
			let leadError: string | undefined;

			try {
				const result = await runLeadAnalyzer(
					intent,
					scope,
					depth,
					focus,
					cwd,
					model,
					getApiKeyForModel,
					sessionTools,
					signal,
					emitLeadTaskEvent,
					emitLeadToolEvent,
				);
				leadResult = result.output;
				leadError = result.error;
			} catch (e) {
				leadError = e instanceof Error ? e.message : String(e);
				debugLog("coop", "Lead analyzer threw exception", { error: leadError });
			}

			if (!leadResult) {
				const errorMessage =
					leadError || "Lead analyzer could not determine which teams to run. Try a more specific intent.";
				emitPhaseUpdate("lead_failed", { errorMessage });
				return {
					content: [
						{
							type: "text",
							text: `Failed to analyze request and select teams.\n\nError: ${errorMessage}\n\nPlease try with a more specific intent like:\n- "security audit"\n- "code review before PR"\n- "prepare for production release"`,
						},
					],
					details: {
						teamsRun: [],
						findingCount: 0,
						criticalCount: 0,
						highCount: 0,
						executionTimeMs: Date.now() - startTime,
						phase: "lead_failed",
						errorMessage,
					},
				};
			}

			// Emit lead complete with selected teams
			emitPhaseUpdate("lead_complete", {
				selectedTeams: leadResult.selectedTeams,
				reasoning: leadResult.reasoning,
			});

			// Step 2: Execute selected teams (streaming events via onUpdate for UI progress)
			const teamResults = await executeTeams(
				leadResult.selectedTeams,
				model,
				modelRegistry,
				sessionTools,
				streamTeamEvent,
				signal,
			);

			// Step 3: Aggregate findings
			const findings = aggregateFindings(teamResults);
			const executionTimeMs = Date.now() - startTime;

			// Step 4: Generate summary
			const summary = generateSummary(leadResult.selectedTeams, findings, executionTimeMs);

			// Build detailed output
			const outputLines: string[] = [summary];

			// Add all findings
			if (findings.length > 0) {
				outputLines.push(``);
				outputLines.push(`### All Findings`);
				outputLines.push(``);

				for (const finding of findings) {
					const location = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
					outputLines.push(`#### [${finding.severity.toUpperCase()}] ${finding.title}`);
					if (location) outputLines.push(`**Location:** ${location}`);
					if (finding.category) outputLines.push(`**Category:** ${finding.category}`);
					if (finding.description) outputLines.push(`\n${finding.description}`);
					outputLines.push(``);
				}
			}

			return {
				content: [{ type: "text", text: outputLines.join("\n") }],
				details: {
					teamsRun: leadResult.selectedTeams,
					findingCount: findings.length,
					criticalCount: findings.filter((f) => f.severity === "critical").length,
					highCount: findings.filter((f) => f.severity === "high").length,
					executionTimeMs,
				},
			};
		},
	};
}
