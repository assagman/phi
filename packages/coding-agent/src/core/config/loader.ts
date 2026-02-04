/**
 * Configuration loader - loads and merges YAML configuration files.
 *
 * Load order (later overrides earlier):
 * 1. Embedded defaults (packages/coding-agent/config/defaults.yaml)
 * 2. User config (~/.phi/config.yaml)
 * 3. Project config (.phi/config.yaml)
 *
 * Merge behavior: Deep merge with array replacement.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MergeStrategyType } from "agents";
import { parse as parseYaml } from "yaml";
import type {
	AppConfig,
	ModelsConfig,
	ResolvedConfig,
	ResolvedPreset,
	ResolvedTeamConfig,
	SettingsConfig,
	TeamAgentInline,
	TeamConfig,
} from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.resolve(__dirname, "../../../config/defaults.yaml");
const USER_CONFIG_PATH = path.join(os.homedir(), ".phi", "config.yaml");

// =============================================================================
// Deep Merge
// =============================================================================

/**
 * Check if value is a plain object (not array, null, etc.).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep merge two objects. Arrays are replaced, not merged.
 * Later values override earlier values.
 */
export function deepMerge<T extends object>(base: T, override: Partial<T>): T {
	const result = { ...base } as T;

	for (const key of Object.keys(override)) {
		const k = key as keyof T;
		const baseValue = base[k];
		const overrideValue = override[k];

		if (overrideValue === undefined) {
			continue;
		}

		if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
			// Recursively merge objects
			(result as Record<string, unknown>)[key] = deepMerge(
				baseValue as Record<string, unknown>,
				overrideValue as Record<string, unknown>,
			);
		} else {
			// Replace value (including arrays)
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

// =============================================================================
// File Loading
// =============================================================================

/**
 * Load and parse a YAML config file.
 * Returns null if file doesn't exist or is invalid.
 */
function loadYamlFile(filePath: string): AppConfig | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseYaml(content);

		// Basic validation
		if (parsed === null || typeof parsed !== "object") {
			return null;
		}

		return parsed as AppConfig;
	} catch {
		return null;
	}
}

/**
 * Find project config by walking up from cwd.
 */
function findProjectConfig(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".phi", "config.yaml");
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			// Continue searching
		}

		// Also check for legacy teams.yaml
		const legacyCandidate = path.join(dir, ".phi", "teams.yaml");
		try {
			fs.accessSync(legacyCandidate, fs.constants.R_OK);
			return legacyCandidate;
		} catch {
			// Continue searching
		}

		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// =============================================================================
// Configuration Resolution
// =============================================================================

/**
 * Resolve presets from config, tracking source.
 */
function resolvePresets(
	config: AppConfig,
	source: "builtin" | "user" | "project",
	existing: Map<string, ResolvedPreset>,
): Map<string, ResolvedPreset> {
	const result = new Map(existing);

	if (!config.presets) {
		return result;
	}

	for (const [name, preset] of Object.entries(config.presets)) {
		const existingPreset = result.get(name);

		if (existingPreset && source !== "builtin") {
			// Merge with existing preset (user/project extends builtin)
			const merged: ResolvedPreset = {
				name,
				description: preset.description ?? existingPreset.description,
				prompt: preset.prompt ?? existingPreset.prompt,
				thinking: preset.thinking ?? existingPreset.thinking,
				temperature: preset.temperature ?? existingPreset.temperature,
				maxTokens: preset.maxTokens ?? existingPreset.maxTokens,
				internal: preset.internal ?? existingPreset.internal,
				source,
			};
			result.set(name, merged);
		} else {
			// New preset
			result.set(name, {
				name,
				description: preset.description,
				prompt: preset.prompt,
				thinking: preset.thinking,
				temperature: preset.temperature,
				maxTokens: preset.maxTokens,
				internal: preset.internal ?? false,
				source,
			});
		}
	}

	return result;
}

/**
 * Resolve teams from config, tracking source.
 */
function resolveTeams(
	config: AppConfig,
	source: "builtin" | "user" | "project",
	existing: Map<string, ResolvedTeamConfig>,
	presets: Map<string, ResolvedPreset>,
): Map<string, ResolvedTeamConfig> {
	const result = new Map(existing);

	if (!config.teams) {
		return result;
	}

	for (const [name, team] of Object.entries(config.teams)) {
		const existingTeam = result.get(name);
		const resolvedAgents = resolveTeamAgents(team, presets);

		if (existingTeam && source !== "builtin") {
			// Merge with existing team
			const merged: ResolvedTeamConfig = {
				name,
				description: team.description ?? existingTeam.description,
				strategy: team.strategy ?? existingTeam.strategy,
				agents: resolvedAgents.length > 0 ? resolvedAgents : existingTeam.agents,
				source,
			};
			result.set(name, merged);
		} else {
			// New team
			const defaultStrategy: MergeStrategyType = resolvedAgents.length > 1 ? "verification" : "union";
			result.set(name, {
				name,
				description: team.description,
				strategy: team.strategy ?? defaultStrategy,
				agents: resolvedAgents,
				source,
			});
		}
	}

	return result;
}

/**
 * Resolve team agent references to preset names.
 */
function resolveTeamAgents(team: TeamConfig, presets: Map<string, ResolvedPreset>): string[] {
	const agents: string[] = [];

	for (const agentRef of team.agents) {
		if (typeof agentRef === "string") {
			// Direct preset reference
			if (presets.has(agentRef)) {
				agents.push(agentRef);
			}
		} else {
			// Inline agent - use preset name or custom name
			const inline = agentRef as TeamAgentInline;
			const name = inline.name ?? inline.preset;
			if (name && presets.has(inline.preset ?? name)) {
				agents.push(inline.preset ?? name);
			}
		}
	}

	return agents;
}

/**
 * Merge models configuration.
 */
function mergeModels(base: ModelsConfig, override: ModelsConfig | undefined): ModelsConfig {
	if (!override) {
		return base;
	}

	return deepMerge(base, override);
}

/**
 * Merge settings with defaults.
 */
function mergeSettings(base: SettingsConfig, override: SettingsConfig | undefined): Required<SettingsConfig> {
	const defaults: Required<SettingsConfig> = {
		editor: {
			tabSize: 2,
			insertSpaces: true,
		},
		display: {
			showThinking: true,
			showTokenUsage: true,
			compactMode: false,
		},
		team: {
			maxRetries: 1,
			continueOnError: true,
			defaultStrategy: "verification",
		},
		git: {
			autoStage: false,
			signCommits: true,
		},
		keybindings: {
			submit: "Enter",
			newline: "Shift+Enter",
			cancel: "Escape",
			model: "Ctrl+M",
			settings: "Ctrl+,",
			help: "Ctrl+?",
			copy: "Ctrl+C",
			paste: "Ctrl+V",
		},
	};

	const merged = deepMerge(defaults, base);
	if (override) {
		return deepMerge(merged, override);
	}
	return merged;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Configuration loader options.
 */
export interface LoadConfigOptions {
	/** Current working directory for project config lookup */
	cwd?: string;
	/** Skip loading user config */
	skipUserConfig?: boolean;
	/** Skip loading project config */
	skipProjectConfig?: boolean;
	/** Custom defaults path (for testing) */
	defaultsPath?: string;
	/** Custom user config path (for testing) */
	userConfigPath?: string;
}

/**
 * Load and merge all configuration sources.
 *
 * @returns Fully resolved configuration
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
	const cwd = options.cwd ?? process.cwd();
	const defaultsPath = options.defaultsPath ?? DEFAULTS_PATH;
	const userConfigPath = options.userConfigPath ?? USER_CONFIG_PATH;

	// Start with empty collections
	let presets = new Map<string, ResolvedPreset>();
	let teams = new Map<string, ResolvedTeamConfig>();
	let models: ModelsConfig = { defaults: {}, providers: {} };
	let settings: Required<SettingsConfig> = mergeSettings({}, undefined);

	// 1. Load embedded defaults
	const defaults = loadYamlFile(defaultsPath);
	if (defaults) {
		presets = resolvePresets(defaults, "builtin", presets);
		teams = resolveTeams(defaults, "builtin", teams, presets);
		if (defaults.models) {
			models = mergeModels(models, defaults.models);
		}
		settings = mergeSettings(defaults.settings ?? {}, undefined);
	}

	// 2. Load user config
	if (!options.skipUserConfig) {
		const userConfig = loadYamlFile(userConfigPath);
		if (userConfig) {
			presets = resolvePresets(userConfig, "user", presets);
			teams = resolveTeams(userConfig, "user", teams, presets);
			if (userConfig.models) {
				models = mergeModels(models, userConfig.models);
			}
			if (userConfig.settings) {
				settings = mergeSettings(settings, userConfig.settings);
			}
		}
	}

	// 3. Load project config
	if (!options.skipProjectConfig) {
		const projectConfigPath = findProjectConfig(cwd);
		if (projectConfigPath) {
			const projectConfig = loadYamlFile(projectConfigPath);
			if (projectConfig) {
				presets = resolvePresets(projectConfig, "project", presets);
				teams = resolveTeams(projectConfig, "project", teams, presets);
				if (projectConfig.models) {
					models = mergeModels(models, projectConfig.models);
				}
				if (projectConfig.settings) {
					settings = mergeSettings(settings, projectConfig.settings);
				}
			}
		}
	}

	return { presets, teams, models, settings };
}

/**
 * Get the path to the user config file.
 */
export function getUserConfigPath(): string {
	return USER_CONFIG_PATH;
}

/**
 * Get the path to the defaults config file.
 */
export function getDefaultsConfigPath(): string {
	return DEFAULTS_PATH;
}

/**
 * Check if user config exists.
 */
export function userConfigExists(): boolean {
	try {
		fs.accessSync(USER_CONFIG_PATH, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create default user config file from template.
 */
export function createUserConfig(): void {
	const userDir = path.dirname(USER_CONFIG_PATH);

	// Create directory if needed
	if (!fs.existsSync(userDir)) {
		fs.mkdirSync(userDir, { recursive: true });
	}

	// Create minimal config with comments
	const template = `# Pi Coding Agent - User Configuration
# This file overrides defaults from the embedded configuration.
# See: https://github.com/anthropics/pi/docs/configuration.md

# Example: Override default model
# models:
#   defaults:
#     agent: "anthropic:claude-opus-4-20250514"

# Example: Add custom team
# teams:
#   my-review:
#     description: "My custom review team"
#     agents:
#       - security-auditor
#       - perf-analyzer

# Example: Custom keybinding
# settings:
#   keybindings:
#     submit: "Ctrl+Enter"
`;

	fs.writeFileSync(USER_CONFIG_PATH, template, "utf-8");
}
