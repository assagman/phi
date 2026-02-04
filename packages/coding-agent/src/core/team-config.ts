/**
 * Team configuration loader
 *
 * Loads custom team definitions from:
 * 1. .pi/teams.yaml (project-specific)
 * 2. ~/.pi/teams.yaml (user global)
 *
 * Model string format: provider:model-id[:thinking]
 * Examples:
 *   - anthropic:claude-3-5-sonnet-20241022
 *   - openai:gpt-4o:medium
 *   - google:gemini-2.0-flash-exp:high
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "agent";
import {
	codeReviewerTemplate,
	type MergeStrategyType,
	mergeSynthesizerTemplate,
	type PresetTemplate,
	perfAnalyzerTemplate,
	securityAuditorTemplate,
} from "agents";
import type { Api, Model } from "ai";
import { parse as parseYaml } from "yaml";

// ============================================================================
// Types
// ============================================================================

/** Agent definition in config file */
export interface AgentConfigDefinition {
	/** Custom agent name (required for full definitions) */
	name?: string;
	/** Use a built-in preset as base */
	preset?: string;
	/** Model string: provider:model-id[:thinking] (e.g., "anthropic:claude-3-5-sonnet:medium") */
	model?: string;
	/** System prompt (full replacement or append) */
	prompt?: string;
	/** Append to preset prompt instead of replacing */
	appendPrompt?: boolean;
	/** Temperature (0-1) */
	temperature?: number;
	/** Thinking level (can also be specified in model string) */
	thinking?: ThinkingLevel;
	/** Allowed tools */
	tools?: string[];
}

/** Parsed model string */
export interface ParsedModelString {
	provider: string;
	modelId: string;
	thinking?: ThinkingLevel;
}

/** Team definition in config file */
export interface TeamConfigDefinition {
	/** Human-readable description */
	description?: string;
	/** Merge strategy */
	strategy?: MergeStrategyType;
	/** List of agents */
	agents: AgentConfigDefinition[];
}

/** Root config structure */
export interface TeamsConfigFile {
	teams?: Record<string, TeamConfigDefinition>;
}

/** Resolved agent ready for execution */
export interface ResolvedAgent {
	name: string;
	/** Parsed model info (provider + modelId), undefined means use session model */
	parsedModel?: ParsedModelString;
	systemPrompt: string;
	temperature?: number;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
}

/** Resolved team ready for execution */
export interface ResolvedTeam {
	name: string;
	description?: string;
	strategy: MergeStrategyType;
	agents: ResolvedAgent[];
	source: "builtin" | "user" | "project";
}

// ============================================================================
// Built-in Presets Registry
// ============================================================================

const PRESET_REGISTRY: Record<string, PresetTemplate> = {
	"code-reviewer": codeReviewerTemplate,
	"security-auditor": securityAuditorTemplate,
	"perf-analyzer": perfAnalyzerTemplate,
	"merge-synthesizer": mergeSynthesizerTemplate,
};

// ============================================================================
// Model String Parsing
// ============================================================================

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

/**
 * Parse a model string in format: provider:model-id[:thinking]
 *
 * Examples:
 *   - "anthropic:claude-3-5-sonnet-20241022" → { provider: "anthropic", modelId: "claude-3-5-sonnet-20241022" }
 *   - "openai:gpt-4o:medium" → { provider: "openai", modelId: "gpt-4o", thinking: "medium" }
 *
 * @returns ParsedModelString or null if invalid format
 */
export function parseModelString(modelStr: string): ParsedModelString | null {
	if (!modelStr || typeof modelStr !== "string") {
		return null;
	}

	const parts = modelStr.split(":");
	if (parts.length < 2 || parts.length > 3) {
		return null;
	}

	const [provider, modelId, thinkingStr] = parts;
	if (!provider || !modelId) {
		return null;
	}

	let thinking: ThinkingLevel | undefined;
	if (thinkingStr) {
		if (!VALID_THINKING_LEVELS.includes(thinkingStr as ThinkingLevel)) {
			return null;
		}
		thinking = thinkingStr as ThinkingLevel;
	}

	return { provider, modelId, thinking };
}

/**
 * Validate a parsed model against the model registry.
 *
 * @returns Error message if invalid, undefined if valid
 */
export function validateModelAgainstRegistry(
	parsed: ParsedModelString,
	modelRegistry: { find: (provider: string, modelId: string) => Model<Api> | undefined },
): string | undefined {
	const model = modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		return `Model not found: ${parsed.provider}:${parsed.modelId}`;
	}
	return undefined;
}

// ============================================================================
// Config Loading
// ============================================================================

function findProjectConfig(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "teams.yaml");
		if (fs.existsSync(candidate)) return candidate;

		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function getUserConfig(): string | null {
	const userConfig = path.join(os.homedir(), ".pi", "teams.yaml");
	return fs.existsSync(userConfig) ? userConfig : null;
}

function loadConfigFile(filePath: string): TeamsConfigFile | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return parseYaml(content) as TeamsConfigFile;
	} catch {
		return null;
	}
}

// ============================================================================
// Agent Resolution
// ============================================================================

interface ResolveAgentResult {
	agent: ResolvedAgent | null;
	error?: string;
}

function resolveAgent(config: AgentConfigDefinition): ResolveAgentResult {
	let basePrompt = "";
	let baseName = config.name || "custom-agent";
	let baseTemperature: number | undefined;
	let baseThinking: ThinkingLevel | undefined;

	// If using a preset, load base values
	if (config.preset) {
		const preset = PRESET_REGISTRY[config.preset];
		if (!preset) {
			return { agent: null, error: `Unknown preset: ${config.preset}` };
		}
		baseName = config.name || preset.name;
		basePrompt = preset.systemPrompt;
		baseTemperature = preset.temperature;
		baseThinking = preset.thinkingLevel;
	}

	// Parse model string if provided
	let parsedModel: ParsedModelString | undefined;
	if (config.model) {
		const parsed = parseModelString(config.model);
		if (!parsed) {
			return {
				agent: null,
				error: `Invalid model format: "${config.model}". Expected: provider:model-id[:thinking]`,
			};
		}
		parsedModel = parsed;
	}

	// Apply overrides
	let finalPrompt = basePrompt;
	if (config.prompt) {
		if (config.appendPrompt && basePrompt) {
			finalPrompt = `${basePrompt}\n\n${config.prompt}`;
		} else {
			finalPrompt = config.prompt;
		}
	}

	if (!finalPrompt) {
		return { agent: null, error: `Agent ${baseName} has no prompt` };
	}

	// Thinking level: model string > config.thinking > preset default
	const thinkingLevel = parsedModel?.thinking ?? config.thinking ?? baseThinking;

	return {
		agent: {
			name: baseName,
			parsedModel,
			systemPrompt: finalPrompt,
			temperature: config.temperature ?? baseTemperature,
			thinkingLevel,
			tools: config.tools,
		},
	};
}

// ============================================================================
// Team Resolution
// ============================================================================

const VALID_STRATEGIES: MergeStrategyType[] = ["verification", "union", "intersection", "custom"];

interface ResolveTeamResult {
	team: ResolvedTeam | null;
	errors: string[];
}

function resolveTeam(name: string, config: TeamConfigDefinition, source: "user" | "project"): ResolveTeamResult {
	const agents: ResolvedAgent[] = [];
	const errors: string[] = [];

	// Validate strategy if specified
	if (config.strategy && !VALID_STRATEGIES.includes(config.strategy)) {
		errors.push(`Team "${name}": invalid strategy "${config.strategy}". Valid: ${VALID_STRATEGIES.join(", ")}`);
	}

	// Validate agents array exists
	if (!config.agents || !Array.isArray(config.agents)) {
		return { team: null, errors: [`Team "${name}": agents array is required`] };
	}

	if (config.agents.length === 0) {
		return { team: null, errors: [`Team "${name}": agents array cannot be empty`] };
	}

	for (let i = 0; i < config.agents.length; i++) {
		const agentConfig = config.agents[i];
		const result = resolveAgent(agentConfig);
		if (result.agent) {
			agents.push(result.agent);
		}
		if (result.error) {
			errors.push(`Team "${name}", agent[${i}]: ${result.error}`);
		}
	}

	if (agents.length === 0) {
		return { team: null, errors };
	}

	return {
		team: {
			name,
			description: config.description,
			strategy: config.strategy || (agents.length > 1 ? "verification" : "union"),
			agents,
			source,
		},
		errors,
	};
}

// ============================================================================
// Public API
// ============================================================================

export interface LoadTeamsResult {
	teams: ResolvedTeam[];
	errors: string[];
}

/**
 * Load all custom teams from config files.
 */
export function loadCustomTeams(cwd: string): LoadTeamsResult {
	const teams: ResolvedTeam[] = [];
	const errors: string[] = [];

	// Load user global config
	const userConfigPath = getUserConfig();
	if (userConfigPath) {
		const userConfig = loadConfigFile(userConfigPath);
		if (userConfig?.teams) {
			for (const [name, def] of Object.entries(userConfig.teams)) {
				const result = resolveTeam(name, def, "user");
				if (result.team) {
					teams.push(result.team);
				}
				errors.push(...result.errors);
			}
		}
	}

	// Load project config (overrides user config for same names)
	const projectConfigPath = findProjectConfig(cwd);
	if (projectConfigPath) {
		const projectConfig = loadConfigFile(projectConfigPath);
		if (projectConfig?.teams) {
			for (const [name, def] of Object.entries(projectConfig.teams)) {
				// Remove user team with same name
				const existingIndex = teams.findIndex((t) => t.name === name);
				if (existingIndex >= 0) {
					teams.splice(existingIndex, 1);
				}

				const result = resolveTeam(name, def, "project");
				if (result.team) {
					teams.push(result.team);
				}
				errors.push(...result.errors);
			}
		}
	}

	return { teams, errors };
}

/**
 * Get list of available presets for reference in configs.
 */
export function getAvailablePresets(): string[] {
	return Object.keys(PRESET_REGISTRY);
}

/**
 * Get preset template by name.
 */
export function getPresetTemplate(name: string): PresetTemplate | undefined {
	return PRESET_REGISTRY[name];
}

/**
 * Validate a resolved team's models against the registry.
 * Returns errors for any models not found in the registry.
 */
export function validateTeamModels(
	team: ResolvedTeam,
	modelRegistry: { find: (provider: string, modelId: string) => Model<Api> | undefined },
): string[] {
	const errors: string[] = [];

	for (const agent of team.agents) {
		if (agent.parsedModel) {
			const error = validateModelAgainstRegistry(agent.parsedModel, modelRegistry);
			if (error) {
				errors.push(`Team "${team.name}", agent "${agent.name}": ${error}`);
			}
		}
	}

	return errors;
}

/**
 * Resolve a model from parsed model string using the registry.
 */
export function resolveModelFromParsed(
	parsed: ParsedModelString,
	modelRegistry: { find: (provider: string, modelId: string) => Model<Api> | undefined },
): Model<Api> | undefined {
	return modelRegistry.find(parsed.provider, parsed.modelId);
}
