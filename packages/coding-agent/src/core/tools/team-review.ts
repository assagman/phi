/**
 * Team Review Tool - Exposes multi-agent team capabilities to the main agent.
 *
 * This tool uses an intent-based interface where the main agent describes
 * what it needs reviewed/analyzed, and the lead-analyzer selects optimal teams.
 *
 * Usage:
 *   request_team_review({
 *     intent: "security audit before production release",
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

const teamReviewSchema = Type.Object({
	intent: Type.String({
		description:
			"What you need reviewed or analyzed. Examples: 'security audit', 'code review before PR', 'performance analysis', 'prepare for production'",
	}),
	scope: Type.Optional(
		Type.String({
			description:
				"Scope of the review. Examples: 'src/auth', 'recent changes', 'full codebase'. Default: full codebase",
		}),
	),
	depth: Type.Optional(
		Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("thorough")], {
			description: "Review depth. quick=fast scan, standard=balanced, thorough=comprehensive. Default: standard",
		}),
	),
	focus: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Areas to focus on. Examples: ['security', 'performance', 'types', 'testing']. Default: auto-selected based on intent",
		}),
	),
});

type TeamReviewParams = Static<typeof teamReviewSchema>;

// Types

export interface TeamReviewResult {
	teamsRun: string[];
	findings: Finding[];
	summary: string;
	executionTimeMs: number;
}

export interface TeamReviewToolDetails {
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
	/** Team event for streaming progress (only in updates, not final result) */
	teamEvent?: TeamEvent;
	/** Agent names for the current team (set at start) */
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
 * Run the lead analyzer to select teams based on intent.
 */
async function runLeadAnalyzer(
	intent: string,
	scope: string | undefined,
	depth: string | undefined,
	focus: string[] | undefined,
	cwd: string,
	model: Model<Api>,
	getApiKey: () => Promise<string | undefined>,
	deltaTools: AgentTool[],
	signal?: AbortSignal,
): Promise<LeadAnalyzerOutput | null> {
	// Create lead agent preset
	const leadPreset = createPreset(leadAnalyzerTemplate, model, {
		injectEpsilon: false, // Lead doesn't need epsilon
	});

	// Get project analyzer tools + delta tools
	const projectTools = getProjectAnalyzerToolsArray(cwd);
	const leadTools = [...projectTools, ...deltaTools];

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

	for await (const event of agentStream) {
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
		}
	}

	// Parse JSON from response
	return parseLeadOutput(lastAssistantContent);
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
			debugLog("team-review", "Lead output missing selectedTeams", { parsed });
			return null;
		}

		// Filter to valid teams
		const selectedTeams = parsed.selectedTeams.filter((t: string) => VALID_TEAM_NAMES.has(t));

		if (selectedTeams.length === 0) {
			debugLog("team-review", "No valid teams in lead output", { parsed });
			return null;
		}

		return {
			intent: parsed.intent || "general review",
			selectedTeams,
			executionWaves: parsed.executionWaves || [selectedTeams],
			reasoning: parsed.reasoning || "",
		};
	} catch (e) {
		debugLog("team-review", "Failed to parse lead output", { error: e, content });
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
			debugLog("team-review", `Unknown team: ${teamName}`);
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
			debugLog("team-review", `Team ${teamName} failed`, { error });
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

export interface TeamReviewToolOptions {
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
 * Create the team review tool.
 *
 * This tool uses accessor functions rather than direct values because:
 * - Model can change during a session (via /model command)
 * - Session tools can change (extensions can add/remove tools)
 */
export function createTeamReviewTool(
	options: TeamReviewToolOptions,
): AgentTool<typeof teamReviewSchema, TeamReviewToolDetails> {
	const { cwd, getModel, modelRegistry, getSessionTools } = options;

	return {
		name: "request_team_review",
		label: "request_team_review",
		description:
			"Request a multi-agent team review or audit. Describe your intent and the system selects optimal teams. Use for security audits, code reviews, performance analysis, pre-release checks, etc.",
		parameters: teamReviewSchema,
		execute: async (
			_toolCallId: string,
			params: TeamReviewParams,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<TeamReviewToolDetails>,
		): Promise<AgentToolResult<TeamReviewToolDetails>> => {
			const startTime = Date.now();
			const { intent, scope, depth, focus } = params;

			// Get current model
			const model = getModel();
			if (!model) {
				return {
					content: [{ type: "text", text: "No model configured. Cannot run team review." }],
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

			// Extract delta tools from session tools
			const deltaTools = sessionTools.filter((t) => t.name.startsWith("delta_"));

			// Create getApiKey wrapper for this model
			const getApiKeyForModel = () => modelRegistry.getApiKey(model);

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
						teamEvent: event,
						agentNames,
					},
				});
			};

			// Step 1: Run lead analyzer to select teams
			const leadResult = await runLeadAnalyzer(
				intent,
				scope,
				depth,
				focus,
				cwd,
				model,
				getApiKeyForModel,
				deltaTools,
				signal,
			);

			if (!leadResult) {
				return {
					content: [
						{
							type: "text",
							text: "Failed to analyze request and select teams. Please try with a more specific intent.",
						},
					],
					details: {
						teamsRun: [],
						findingCount: 0,
						criticalCount: 0,
						highCount: 0,
						executionTimeMs: Date.now() - startTime,
					},
				};
			}

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
