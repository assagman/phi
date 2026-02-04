/**
 * /team command - Multi-agent team orchestration
 *
 * ## Configuration Architecture
 *
 * **TypeScript Templates (Source of Truth for Behavior)**
 * - packages/agents/src/presets/*.ts - Define agent system prompts, thinking levels
 * - Registered in packages/coding-agent/src/core/preset-registry.ts
 * - Provides runtime guarantees via compile-time type checking
 *
 * **YAML Configuration (User Customization Layer)**
 * - packages/coding-agent/config/defaults.yaml - Built-in team definitions
 * - ~/.phi/config.yaml - User overrides
 * - .phi/config.yaml - Project overrides
 *
 * The TypeScript presets define WHAT agents do (prompts, behavior).
 * The YAML config defines HOW agents are grouped into teams.
 * YAML teams reference TypeScript presets by name.
 *
 * This separation ensures:
 * - Type safety for preset definitions (compile-time validation)
 * - Flexibility for team composition (YAML is easy to edit)
 * - Clear upgrade path (TypeScript presets can be improved without breaking user teams)
 */

import type { AgentTool } from "agent";
import {
	type AgentPreset,
	type AgentResult,
	createPreset,
	EPSILON_TASK_INSTRUCTIONS,
	type Finding,
	type MergeStrategyType,
	mergeSynthesizerTemplate,
	Team,
	type TeamConfig,
	type TeamEvent,
	type TeamEventEmitter,
	type TeamExecutionStorageInterface,
	type TeamResult,
} from "agents";
import type { Api, Model } from "ai";
import { getYamlTeamAgents, getYamlTeams } from "../config/index.js";
import type { ModelRegistry } from "../model-registry.js";
import { AGENT_INFO, getPresetTemplate, isPresetName, type PresetName } from "../preset-registry.js";
import {
	getAvailablePresets,
	loadCustomTeams,
	type ResolvedTeam,
	resolveModelFromParsed,
	validateTeamModels,
} from "../team-config.js";

// ============================================================================
// Built-in Team Configurations
// ============================================================================

export interface BuiltinTeam {
	name: string;
	description: string;
	agents: PresetName[];
	strategy: MergeStrategyType;
}

export const BUILTIN_TEAMS: BuiltinTeam[] = [
	// =========================================================================
	// UNDERSTAND - Requirements & Research Teams
	// =========================================================================
	{
		name: "understand",
		description: "Full requirements analysis: elicit, analyze context, guard scope",
		agents: ["requirements-elicitor", "context-analyzer", "scope-guardian"],
		strategy: "verification",
	},
	{
		name: "research",
		description: "Technology research and best practice synthesis",
		agents: ["research-synthesizer", "context-analyzer"],
		strategy: "verification",
	},
	{
		name: "kickoff",
		description: "Quick project kickoff: requirements, scope, initial architecture",
		agents: ["requirements-elicitor", "scope-guardian", "solution-architect"],
		strategy: "verification",
	},

	// =========================================================================
	// DESIGN - Architecture & Planning Teams
	// =========================================================================
	{
		name: "design",
		description: "Full design: architecture, API contracts, data modeling, integration",
		agents: ["solution-architect", "api-contract-designer", "data-modeler", "system-integrator"],
		strategy: "verification",
	},
	{
		name: "deep-design",
		description: "Deep design with context analysis",
		agents: ["context-analyzer", "solution-architect", "api-contract-designer", "data-modeler"],
		strategy: "verification",
	},

	// =========================================================================
	// IMPLEMENT - Execution Planning Teams
	// =========================================================================
	{
		name: "plan",
		description: "Implementation planning: task breakdown and strategy",
		agents: ["task-orchestrator", "implementation-strategist"],
		strategy: "verification",
	},
	{
		name: "implement",
		description: "Implementation guidance: code generation and refactoring advice",
		agents: ["code-generator", "refactoring-advisor"],
		strategy: "verification",
	},
	{
		name: "refactor",
		description: "Refactoring analysis with context and validation",
		agents: ["context-analyzer", "refactoring-advisor", "test-coverage-auditor"],
		strategy: "verification",
	},

	// =========================================================================
	// VALIDATE - Code Review & Audit Teams (existing + enhanced)
	// =========================================================================
	{
		name: "code-review",
		description: "Comprehensive code review with multiple perspectives",
		agents: ["code-reviewer", "security-auditor", "perf-analyzer"],
		strategy: "verification",
	},
	{
		name: "full-audit",
		description: "Full-spectrum audit: security, privacy, types, architecture, errors",
		agents: [
			"security-auditor",
			"privacy-auditor",
			"type-safety-auditor",
			"architecture-auditor",
			"error-handling-auditor",
		],
		strategy: "verification",
	},
	{
		name: "validate",
		description:
			"Combined code review + full audit (code-reviewer, security, privacy, types, architecture, errors, perf)",
		agents: [
			"code-reviewer",
			"security-auditor",
			"privacy-auditor",
			"type-safety-auditor",
			"architecture-auditor",
			"error-handling-auditor",
			"perf-analyzer",
		],
		strategy: "verification",
	},
	{
		name: "security-audit",
		description: "Deep security and privacy analysis",
		agents: ["security-auditor", "privacy-auditor"],
		strategy: "verification",
	},
	{
		name: "security-deep",
		description: "Security-only deep dive (OWASP, CWE, attack surface)",
		agents: ["security-auditor"],
		strategy: "union",
	},
	{
		name: "performance",
		description: "Performance, concurrency, and error handling analysis",
		agents: ["perf-analyzer", "concurrency-auditor", "error-handling-auditor"],
		strategy: "verification",
	},
	{
		name: "quality",
		description: "Code quality: types, testing, error handling",
		agents: ["type-safety-auditor", "test-coverage-auditor", "error-handling-auditor"],
		strategy: "verification",
	},
	{
		name: "types",
		description: "Type safety analysis",
		agents: ["type-safety-auditor"],
		strategy: "union",
	},
	{
		name: "testing",
		description: "Test coverage and quality analysis",
		agents: ["test-coverage-auditor"],
		strategy: "union",
	},
	{
		name: "architecture",
		description: "Architecture, API design, and dependency analysis",
		agents: ["architecture-auditor", "api-design-auditor", "dependency-auditor"],
		strategy: "verification",
	},
	{
		name: "api-review",
		description: "API design review",
		agents: ["api-design-auditor"],
		strategy: "union",
	},
	{
		name: "frontend",
		description: "Frontend review: accessibility, i18n, performance",
		agents: ["accessibility-auditor", "i18n-auditor", "perf-analyzer"],
		strategy: "verification",
	},
	{
		name: "accessibility",
		description: "Accessibility (WCAG) audit",
		agents: ["accessibility-auditor"],
		strategy: "union",
	},
	{
		name: "docs",
		description: "Documentation completeness review",
		agents: ["docs-auditor"],
		strategy: "union",
	},
	{
		name: "dependencies",
		description: "Dependency health and security audit",
		agents: ["dependency-auditor", "security-auditor"],
		strategy: "verification",
	},
	{
		name: "quality-gate",
		description: "Quality checkpoint: code review, security, types, tests",
		agents: ["code-reviewer", "security-auditor", "type-safety-auditor", "test-coverage-auditor"],
		strategy: "verification",
	},

	// =========================================================================
	// VERIFY - Testing Teams
	// =========================================================================
	{
		name: "verify",
		description: "Full verification: test strategy, cases, acceptance, regression",
		agents: ["test-strategist", "test-case-designer", "acceptance-verifier", "regression-analyst"],
		strategy: "verification",
	},
	{
		name: "test-planning",
		description: "Test planning: strategy and case design",
		agents: ["test-strategist", "test-case-designer"],
		strategy: "verification",
	},
	{
		name: "acceptance",
		description: "Acceptance verification and regression analysis",
		agents: ["acceptance-verifier", "regression-analyst"],
		strategy: "verification",
	},

	// =========================================================================
	// DELIVER - Release Teams
	// =========================================================================
	{
		name: "deliver",
		description: "Full delivery: changelog, deployment validation, release coordination",
		agents: ["changelog-generator", "deployment-validator", "release-coordinator"],
		strategy: "verification",
	},
	{
		name: "pre-release",
		description: "Pre-release checklist: validation, verification, delivery readiness",
		agents: ["security-auditor", "test-coverage-auditor", "acceptance-verifier", "deployment-validator"],
		strategy: "verification",
	},
	{
		name: "release-prep",
		description: "Release preparation: changelog and deployment validation",
		agents: ["changelog-generator", "deployment-validator"],
		strategy: "verification",
	},

	// =========================================================================
	// CROSS-PHASE Workflow Teams
	// =========================================================================
	{
		name: "before-coding",
		description: "Pre-implementation: requirements, design, planning",
		agents: ["requirements-elicitor", "scope-guardian", "solution-architect", "task-orchestrator"],
		strategy: "verification",
	},
	{
		name: "after-coding",
		description: "Post-implementation: validation, verification, delivery",
		agents: ["code-reviewer", "security-auditor", "acceptance-verifier", "changelog-generator"],
		strategy: "verification",
	},
	{
		name: "quick-fix",
		description: "Quick bug fix workflow: context analysis and code review",
		agents: ["context-analyzer", "code-reviewer", "test-coverage-auditor"],
		strategy: "verification",
	},
	{
		name: "feature",
		description: "Feature development: understand, design, validate",
		agents: ["requirements-elicitor", "solution-architect", "code-reviewer", "test-strategist"],
		strategy: "verification",
	},
	{
		name: "greenfield",
		description: "New project setup: full requirements, research, and design",
		agents: ["requirements-elicitor", "research-synthesizer", "solution-architect", "api-contract-designer"],
		strategy: "verification",
	},
	{
		name: "maintenance",
		description: "Maintenance workflow: dependencies, refactoring, tests, changelog",
		agents: ["dependency-auditor", "refactoring-advisor", "test-coverage-auditor", "changelog-generator"],
		strategy: "verification",
	},
	{
		name: "full-cycle",
		description: "Full SDLC: one key agent from each phase",
		agents: [
			"requirements-elicitor",
			"solution-architect",
			"task-orchestrator",
			"code-reviewer",
			"test-strategist",
			"changelog-generator",
		],
		strategy: "verification",
	},
];

// PRESET_REGISTRY is imported from ../preset-registry.js

// ============================================================================
// Helpers
// ============================================================================

function createAgentPresets(agentNames: PresetName[], model: Model<Api>): AgentPreset[] {
	return agentNames.map((name) => {
		const template = getPresetTemplate(name);
		// Template is guaranteed to exist since name is PresetName
		// Inject epsilon task tracking instructions for UI progress display
		return createPreset(template, model, { injectEpsilon: true });
	});
}

export function formatSeverityIcon(severity: Finding["severity"]): string {
	switch (severity) {
		case "critical":
			return "🔴";
		case "high":
			return "🟠";
		case "medium":
			return "🟡";
		case "low":
			return "🟢";
		case "info":
			return "ℹ️";
		default:
			return "⚪";
	}
}

// ============================================================================
// Team Execution State
// ============================================================================

export interface TeamExecutionState {
	phase: "starting" | "running" | "merging" | "complete" | "error";
	teamName: string;
	agentCount: number;
	currentAgent?: string;
	currentAgentIndex?: number;
	agentResults: Map<string, { status: "running" | "complete" | "error"; result?: AgentResult }>;
	mergePhase?: "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing";
	result?: TeamResult;
	error?: string;
}

export function formatTeamProgress(state: TeamExecutionState, theme: any): string {
	const lines: string[] = [];

	// Header
	lines.push(theme.bold(`Team: ${state.teamName}`) + theme.fg("muted", ` (${state.agentCount} agents)`));
	lines.push("");

	// Agent status
	for (const [name, info] of state.agentResults) {
		const icon =
			info.status === "running"
				? theme.fg("warning", "⏳")
				: info.status === "complete"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
		let status = `${icon} ${name}`;
		if (info.result) {
			const findingCount = info.result.findings.length;
			status += theme.fg("muted", ` (${findingCount} findings)`);
		} else if (info.status === "running") {
			status += theme.fg("dim", " analyzing...");
		}
		lines.push(status);
	}

	// Merge phase
	if (state.phase === "merging" && state.mergePhase) {
		lines.push("");
		lines.push(theme.fg("accent", `Merge phase: ${state.mergePhase}`));
	}

	return lines.join("\n");
}

export function handleTeamEvent(event: TeamEvent, state: TeamExecutionState): void {
	switch (event.type) {
		case "team_start":
			state.phase = "running";
			state.teamName = event.teamName;
			state.agentCount = event.agentCount;
			break;

		case "agent_start":
			state.currentAgent = event.agentName;
			state.currentAgentIndex = event.index;
			state.agentResults.set(event.agentName, { status: "running" });
			break;

		case "agent_end":
			state.agentResults.set(event.agentName, {
				status: event.result.success ? "complete" : "error",
				result: event.result,
			});
			break;

		case "agent_error":
			if (!event.willRetry) {
				const existing = state.agentResults.get(event.agentName);
				if (existing) {
					existing.status = "error";
				}
			}
			break;

		case "merge_start":
			state.phase = "merging";
			break;

		case "merge_progress":
			state.mergePhase = event.phase;
			break;

		case "team_end":
			state.phase = "complete";
			state.result = event.result;
			break;
	}
}

// ============================================================================
// Available Agents for Free-text Mode
// ============================================================================

// Re-export AGENT_INFO from preset-registry for backwards compatibility
export const AVAILABLE_AGENTS = AGENT_INFO;

// ============================================================================
// Team Discovery (combines built-in + custom teams)
// ============================================================================

/** Unified team info for selector UI */
export interface TeamInfo {
	name: string;
	description: string;
	agentCount: number;
	source: "builtin" | "user" | "project";
	/** Original resolved team (only for custom teams) */
	resolved?: ResolvedTeam;
}

/** Load all teams from YAML config (builtin + user + project) */
export function loadAllTeams(cwd: string): { teams: TeamInfo[]; errors: string[] } {
	// Get teams from YAML config (already merged: defaults < user < project)
	const yamlTeams = getYamlTeams({ cwd });

	const teams: TeamInfo[] = yamlTeams.map((t) => ({
		name: t.name,
		description: t.description || `Team (${t.agentCount} agents)`,
		agentCount: t.agentCount,
		source: t.source,
	}));

	// Also load legacy custom teams from teams.yaml for backward compatibility
	const customResult = loadCustomTeams(cwd);
	for (const custom of customResult.teams) {
		// Only add if not already in YAML config
		if (!teams.some((t) => t.name === custom.name)) {
			teams.push({
				name: custom.name,
				description: custom.description || `Custom team (${custom.agents.length} agents)`,
				agentCount: custom.agents.length,
				source: custom.source,
				resolved: custom,
			});
		}
	}

	return { teams, errors: customResult.errors };
}

/** Format team info for selector display */
export function formatTeamSelectorOption(team: TeamInfo): string {
	const sourceIcon = team.source === "builtin" ? "" : team.source === "project" ? " [project]" : " [user]";
	return `${team.name}${sourceIcon}: ${team.description} (${team.agentCount} agents)`;
}

/**
 * Get agent names for a team by name.
 * Unified lookup that checks YAML config first, then falls back to BUILTIN_TEAMS.
 * This provides a single entry point for all team agent lookups.
 */
export function getTeamAgentNames(teamName: string, cwd?: string): string[] {
	// Try YAML config first (includes merged builtin + user + project)
	const yamlAgents = getYamlTeamAgents(teamName, cwd ? { cwd } : undefined);
	if (yamlAgents.length > 0) {
		return yamlAgents;
	}
	// Fallback to hardcoded BUILTIN_TEAMS for backward compatibility
	const team = BUILTIN_TEAMS.find((t) => t.name === teamName);
	return team?.agents ?? [];
}

/** Parse selector option back to team name */
export function parseTeamSelectorOption(option: string): string {
	// Extract name before first colon or bracket
	const match = option.match(/^([^\s:[\]]+)/);
	return match ? match[1] : option;
}

// ============================================================================
// Team Execution
// ============================================================================

export interface TeamCommandOptions {
	/** Model to use for agents (accepts any API type for multi-provider flexibility) */
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	tools?: AgentTool[];
	task?: string;
	signal?: AbortSignal;
	onProgress?: (state: TeamExecutionState) => void;
}

/**
 * Execute a predefined built-in team by name.
 */
export async function executeTeam(teamName: string, options: TeamCommandOptions): Promise<TeamResult | null> {
	// Find built-in team
	const builtinTeam = BUILTIN_TEAMS.find((t) => t.name === teamName);
	if (!builtinTeam) {
		throw new Error(`Unknown team: ${teamName}. Available: ${BUILTIN_TEAMS.map((t) => t.name).join(", ")}`);
	}

	return executeTeamWithAgents(builtinTeam.name, builtinTeam.agents, builtinTeam.strategy, options);
}

/**
 * Internal helper to execute a team and process events.
 * Shared by executeResolvedTeam, executeTeamWithAgents, and executeCustomTeam.
 */
async function executeTeamInternal(teamConfig: TeamConfig, options: TeamCommandOptions): Promise<TeamResult | null> {
	const { modelRegistry, task, signal, onProgress } = options;

	// Initialize state
	const state: TeamExecutionState = {
		phase: "starting",
		teamName: teamConfig.name,
		agentCount: teamConfig.agents.length,
		agentResults: new Map(),
	};

	const teamInstance = new Team(teamConfig);

	try {
		const stream = teamInstance.run({
			task,
			signal,
			getApiKey: async (provider: string) => {
				return modelRegistry.getApiKeyForProvider(provider);
			},
		});

		// Process events
		for await (const event of stream) {
			handleTeamEvent(event, state);
			onProgress?.(state);
		}

		return await stream.result();
	} catch (error) {
		state.phase = "error";
		state.error = error instanceof Error ? error.message : String(error);
		onProgress?.(state);
		return null;
	}
}

/**
 * Execute a resolved team (from config file).
 */
export async function executeResolvedTeam(team: ResolvedTeam, options: TeamCommandOptions): Promise<TeamResult | null> {
	const { model, modelRegistry, tools = [] } = options;

	// Validate models against registry
	const modelErrors = validateTeamModels(team, modelRegistry);
	if (modelErrors.length > 0) {
		throw new Error(`Team model validation failed:\n${modelErrors.join("\n")}`);
	}

	// Create agent presets from resolved agents
	const agentPresets: AgentPreset[] = team.agents.map((agent) => {
		// Resolve model: agent's model from config, or fallback to session model
		let agentModel: Model<Api> = model;
		if (agent.parsedModel) {
			const resolved = resolveModelFromParsed(agent.parsedModel, modelRegistry);
			if (resolved) {
				agentModel = resolved;
			}
		}

		// Inject epsilon task tracking instructions for UI progress display
		const systemPrompt = `${agent.systemPrompt}\n${EPSILON_TASK_INSTRUCTIONS}`;

		return {
			name: agent.name,
			description: `Custom agent: ${agent.name}`,
			model: agentModel,
			systemPrompt,
			thinkingLevel: agent.thinkingLevel,
			temperature: agent.temperature,
		};
	});

	// Create merge agent if using verification strategy
	const mergeAgent = team.strategy === "verification" ? createPreset(mergeSynthesizerTemplate, model) : undefined;

	// Build team config
	const teamConfig: TeamConfig = {
		name: team.name,
		description: team.description,
		agents: agentPresets,
		tools,
		strategy: "parallel",
		merge: {
			strategy: team.strategy,
			mergeAgent,
		},
		maxRetries: 1,
		continueOnError: true,
	};

	return executeTeamInternal(teamConfig, options);
}

/**
 * Execute a custom team with specified agents and task.
 */
export async function executeCustomTeam(
	taskDescription: string,
	agentNames: string[],
	options: TeamCommandOptions,
): Promise<TeamResult | null> {
	// Validate agent names and narrow to PresetName[]
	const validatedNames: PresetName[] = [];
	for (const name of agentNames) {
		if (!isPresetName(name)) {
			throw new Error(`Unknown agent: ${name}`);
		}
		validatedNames.push(name);
	}

	// Use verification strategy if multiple agents, union if single
	const strategy: MergeStrategyType = validatedNames.length > 1 ? "verification" : "union";

	return executeTeamWithAgents(`custom: ${taskDescription.slice(0, 30)}...`, validatedNames, strategy, options);
}

// ============================================================================
// Streaming Team Execution (returns EventStream for real-time UI updates)
// ============================================================================

export interface TeamStreamOptions {
	/** Model to use for agents (accepts any API type for multi-provider flexibility) */
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	tools?: AgentTool[];
	task: string;
	signal?: AbortSignal;
	/** Optional storage for persisting execution state (SQLite-backed) */
	storage?: TeamExecutionStorageInterface;
	/** Optional event emitter for SQLite-backed event persistence */
	eventEmitter?: TeamEventEmitter;
}

export interface TeamStreamResult {
	team: Team;
	stream: ReturnType<Team["run"]>;
	agentNames: string[];
}

/**
 * Create a team stream for a built-in team.
 * Returns the Team instance and its event stream for real-time UI updates.
 */
export function createTeamStream(teamName: string, options: TeamStreamOptions): TeamStreamResult {
	const builtinTeam = BUILTIN_TEAMS.find((t) => t.name === teamName);
	if (!builtinTeam) {
		throw new Error(`Unknown team: ${teamName}. Available: ${BUILTIN_TEAMS.map((t) => t.name).join(", ")}`);
	}

	return createTeamStreamInternal(builtinTeam.name, builtinTeam.agents, builtinTeam.strategy, options);
}

/**
 * Create a team stream for a resolved (custom) team.
 * Returns the Team instance and its event stream for real-time UI updates.
 */
export function createResolvedTeamStream(team: ResolvedTeam, options: TeamStreamOptions): TeamStreamResult {
	const { model, modelRegistry, tools = [], task, signal, storage, eventEmitter } = options;

	// Validate models against registry
	const modelErrors = validateTeamModels(team, modelRegistry);
	if (modelErrors.length > 0) {
		throw new Error(`Team model validation failed:\n${modelErrors.join("\n")}`);
	}

	// Create agent presets from resolved agents
	const agentPresets: AgentPreset[] = team.agents.map((agent) => {
		let agentModel: Model<Api> = model;
		if (agent.parsedModel) {
			const resolved = resolveModelFromParsed(agent.parsedModel, modelRegistry);
			if (resolved) {
				agentModel = resolved;
			}
		}

		// Inject epsilon task tracking instructions for UI progress display
		const systemPrompt = `${agent.systemPrompt}\n${EPSILON_TASK_INSTRUCTIONS}`;

		return {
			name: agent.name,
			description: `Custom agent: ${agent.name}`,
			model: agentModel,
			systemPrompt,
			thinkingLevel: agent.thinkingLevel,
			temperature: agent.temperature,
		};
	});

	const mergeAgent = team.strategy === "verification" ? createPreset(mergeSynthesizerTemplate, model) : undefined;

	const teamConfig: TeamConfig = {
		name: team.name,
		description: team.description,
		agents: agentPresets,
		tools,
		strategy: "parallel",
		merge: {
			strategy: team.strategy,
			mergeAgent,
		},
		maxRetries: 1,
		continueOnError: true,
	};

	const teamInstance = new Team(teamConfig);
	const stream = teamInstance.run({
		task,
		signal,
		storage,
		eventEmitter,
		getApiKey: async (provider: string) => {
			return modelRegistry.getApiKeyForProvider(provider);
		},
	});

	return {
		team: teamInstance,
		stream,
		agentNames: team.agents.map((a) => a.name),
	};
}

function createTeamStreamInternal(
	teamName: string,
	agentNames: PresetName[],
	strategy: MergeStrategyType,
	options: TeamStreamOptions,
): TeamStreamResult {
	const { model, modelRegistry, tools = [], task, signal, storage, eventEmitter } = options;

	// model cast is safe - we only care about provider for API key lookup
	const agentPresets = createAgentPresets(agentNames, model as Model<Api>);
	const mergeAgent = strategy === "verification" ? createPreset(mergeSynthesizerTemplate, model) : undefined;

	const teamConfig: TeamConfig = {
		name: teamName,
		agents: agentPresets,
		tools,
		strategy: "parallel",
		merge: {
			strategy,
			mergeAgent,
		},
		maxRetries: 1,
		continueOnError: true,
	};

	const team = new Team(teamConfig);
	const stream = team.run({
		task,
		signal,
		storage,
		eventEmitter,
		getApiKey: async (provider: string) => {
			return modelRegistry.getApiKeyForProvider(provider);
		},
	});

	return { team, stream, agentNames };
}

/**
 * Internal: Execute team with given agents.
 */
async function executeTeamWithAgents(
	teamName: string,
	agentNames: PresetName[],
	strategy: MergeStrategyType,
	options: TeamCommandOptions,
): Promise<TeamResult | null> {
	const { model, tools = [] } = options;

	// Create agent presets (model cast is safe - we only care about provider for API key lookup)
	const agentPresets = createAgentPresets(agentNames, model as Model<Api>);

	// Create merge agent if using verification strategy
	const mergeAgent = strategy === "verification" ? createPreset(mergeSynthesizerTemplate, model) : undefined;

	// Build team config
	const teamConfig: TeamConfig = {
		name: teamName,
		agents: agentPresets,
		tools,
		strategy: "parallel",
		merge: {
			strategy,
			mergeAgent,
		},
		maxRetries: 1,
		continueOnError: true,
	};

	return executeTeamInternal(teamConfig, options);
}

// ============================================================================
// Help Formatting
// ============================================================================

/** Format /team help output */
export function formatTeamHelp(cwd: string): string {
	const { teams, errors } = loadAllTeams(cwd);
	const lines: string[] = [];

	lines.push("## Available Teams\n");

	// Group by source
	const builtinTeams = teams.filter((t) => t.source === "builtin");
	const userTeams = teams.filter((t) => t.source === "user");
	const projectTeams = teams.filter((t) => t.source === "project");

	if (builtinTeams.length > 0) {
		lines.push("### Built-in Teams\n");
		for (const t of builtinTeams) {
			lines.push(`- **${t.name}** (${t.agentCount} agents): ${t.description}`);
		}
		lines.push("");
	}

	if (projectTeams.length > 0) {
		lines.push("### Project Teams (.phi/teams.yaml)\n");
		for (const t of projectTeams) {
			lines.push(`- **${t.name}** (${t.agentCount} agents): ${t.description}`);
		}
		lines.push("");
	}

	if (userTeams.length > 0) {
		lines.push("### User Teams (~/.phi/teams.yaml)\n");
		for (const t of userTeams) {
			lines.push(`- **${t.name}** (${t.agentCount} agents): ${t.description}`);
		}
		lines.push("");
	}

	lines.push("### Usage\n");
	lines.push("```");
	lines.push("/team                    # Show team selector");
	lines.push("/team <name>             # Run a team");
	lines.push("/team help               # Show this help");
	lines.push("/team help <name>        # Show team details");
	lines.push("/team presets            # List available presets for config");
	lines.push("```\n");

	if (errors.length > 0) {
		lines.push("### Config Errors\n");
		for (const err of errors) {
			lines.push(`- ⚠️ ${err}`);
		}
	}

	return lines.join("\n");
}

/** Format detailed help for a specific team */
export function formatTeamDetailHelp(teamName: string, cwd: string): string {
	const { teams } = loadAllTeams(cwd);
	const team = teams.find((t) => t.name === teamName);

	if (!team) {
		return `Team not found: **${teamName}**\n\nRun \`/team help\` to see available teams.`;
	}

	const lines: string[] = [];
	lines.push(`## Team: ${team.name}\n`);
	lines.push(`**Source:** ${team.source}`);
	lines.push(`**Description:** ${team.description}`);
	lines.push(`**Agents:** ${team.agentCount}\n`);

	if (team.source === "builtin") {
		const builtin = BUILTIN_TEAMS.find((t) => t.name === teamName);
		if (builtin) {
			lines.push("### Agents\n");
			for (const agentName of builtin.agents) {
				const agent = AVAILABLE_AGENTS.find((a) => a.name === agentName);
				lines.push(`- **${agentName}**: ${agent?.description || "Built-in agent"}`);
			}
			lines.push("");
			lines.push(`**Strategy:** ${builtin.strategy}`);
		}
	} else if (team.resolved) {
		lines.push("### Agents\n");
		for (const agent of team.resolved.agents) {
			const modelStr = agent.parsedModel
				? `${agent.parsedModel.provider}:${agent.parsedModel.modelId}${agent.parsedModel.thinking ? `:${agent.parsedModel.thinking}` : ""}`
				: "(session model)";
			lines.push(`- **${agent.name}** [${modelStr}]`);
			if (agent.temperature !== undefined) {
				lines.push(`  - Temperature: ${agent.temperature}`);
			}
			if (agent.thinkingLevel) {
				lines.push(`  - Thinking: ${agent.thinkingLevel}`);
			}
		}
		lines.push("");
		lines.push(`**Strategy:** ${team.resolved.strategy}`);
	}

	return lines.join("\n");
}

/** Format /team presets output */
export function formatTeamPresets(): string {
	const lines: string[] = [];
	lines.push("## Available Presets\n");
	lines.push("Use these preset names in your teams.yaml config:\n");

	const presets = getAvailablePresets();
	for (const name of presets) {
		const template = getPresetTemplate(name);
		if (template) {
			lines.push(`- **${name}**: ${template.description}`);
		}
	}

	lines.push("\n### Example Config\n");
	lines.push("```yaml");
	lines.push("teams:");
	lines.push("  my-review:");
	lines.push('    description: "Custom review team"');
	lines.push("    strategy: verification");
	lines.push("    agents:");
	lines.push("      - preset: security-auditor");
	lines.push("        model: anthropic:claude-3-5-sonnet-20241022:medium");
	lines.push("      - preset: code-reviewer");
	lines.push("        appendPrompt: true");
	lines.push("        prompt: |");
	lines.push("          Focus especially on error handling.");
	lines.push("```");

	return lines.join("\n");
}

// ============================================================================
// Result Formatting
// ============================================================================

export function formatTeamResults(result: TeamResult): string {
	const lines: string[] = [];

	lines.push(`## Team Review: ${result.teamName}`);
	lines.push("");

	// Stats
	const successCount = result.agentResults.filter((r: AgentResult) => r.success).length;
	lines.push(`**Agents:** ${successCount}/${result.agentResults.length} completed`);
	lines.push(`**Findings:** ${result.findings.length} total`);
	if (result.clusters.length > 0) {
		lines.push(`**Clusters:** ${result.clusters.length} (grouped by similarity)`);
	}
	lines.push(`**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
	if (result.totalUsage) {
		lines.push(`**Tokens:** ↑${result.totalUsage.inputTokens} ↓${result.totalUsage.outputTokens}`);
	}
	lines.push("");

	// Summary from merge agent
	if (result.summary) {
		lines.push("### Summary");
		lines.push(result.summary);
		lines.push("");
	}

	// Findings by severity
	if (result.findings.length > 0) {
		const bySeverity = new Map<string, Finding[]>();
		for (const f of result.findings) {
			const list = bySeverity.get(f.severity) || [];
			list.push(f);
			bySeverity.set(f.severity, list);
		}

		lines.push("### Findings");
		for (const severity of ["critical", "high", "medium", "low", "info"]) {
			const findings = bySeverity.get(severity);
			if (!findings || findings.length === 0) continue;

			lines.push("");
			lines.push(`#### ${severity.toUpperCase()} (${findings.length})`);
			for (const f of findings) {
				const icon = formatSeverityIcon(f.severity);
				const file = f.file ? `\`${f.file}\`` : "";
				const line = f.line ? `:${Array.isArray(f.line) ? `${f.line[0]}-${f.line[1]}` : f.line}` : "";
				lines.push(`- ${icon} **${f.title}** ${file}${line}`);
				lines.push(`  ${f.description}`);
				if (f.suggestion) {
					lines.push(`  → ${f.suggestion}`);
				}
			}
		}
	} else {
		lines.push("*No findings reported.*");
	}

	return lines.join("\n");
}
