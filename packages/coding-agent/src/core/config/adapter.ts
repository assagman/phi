/**
 * Configuration adapter - bridges YAML config to existing team/preset system.
 *
 * This adapter allows the existing team command to use YAML-defined presets and teams
 * while maintaining backward compatibility with the hardcoded registries.
 */

import type { MergeStrategyType, PresetTemplate } from "agents";
import { type LoadConfigOptions, loadConfig } from "./loader.js";
import type { ResolvedConfig, ResolvedPreset, ResolvedTeamConfig } from "./types.js";

// =============================================================================
// Singleton Config Instance
// =============================================================================

/**
 * Config caching strategy:
 *
 * The config is cached per-cwd because reloading YAML files on every call
 * would be expensive. This is acceptable for CLI tools where sessions are
 * short-lived and users expect to restart for config changes.
 *
 * For long-running scenarios (language servers, watch mode), consumers should
 * either call clearConfigCache() periodically or implement file watching
 * and call clearConfigCache() on changes to:
 * - ~/.phi/config.yaml
 * - .phi/config.yaml (in project tree)
 */
let cachedConfig: ResolvedConfig | null = null;
let configCwd: string | null = null;

/**
 * Get the loaded configuration, loading if needed.
 * Returns cached config if cwd hasn't changed.
 */
export function getConfig(options?: LoadConfigOptions): ResolvedConfig {
	const cwd = options?.cwd ?? process.cwd();

	// Return cached if same cwd
	if (cachedConfig && configCwd === cwd) {
		return cachedConfig;
	}

	// Load and cache
	cachedConfig = loadConfig({ ...options, cwd });
	configCwd = cwd;

	return cachedConfig;
}

/**
 * Clear the configuration cache.
 *
 * Call this to force reload of config files on next getConfig() call.
 * Useful for:
 * - Testing (reset between tests)
 * - File watcher callbacks (when config files change)
 * - Manual refresh commands (/config reload)
 */
export function clearConfigCache(): void {
	cachedConfig = null;
	configCwd = null;
}

// =============================================================================
// Preset Adapter
// =============================================================================

/**
 * Convert ResolvedPreset to PresetTemplate for compatibility with existing code.
 */
export function presetToTemplate(preset: ResolvedPreset): PresetTemplate {
	return {
		name: preset.name,
		description: preset.description,
		systemPrompt: preset.prompt,
		thinkingLevel: preset.thinking,
		temperature: preset.temperature,
		maxTokens: preset.maxTokens,
	};
}

/**
 * Get all preset names from YAML config.
 */
export function getYamlPresetNames(options?: LoadConfigOptions): string[] {
	const config = getConfig(options);
	return Array.from(config.presets.keys()).filter((name) => {
		const preset = config.presets.get(name);
		return preset && !preset.internal;
	});
}

/**
 * Get a preset template by name from YAML config.
 */
export function getYamlPresetTemplate(name: string, options?: LoadConfigOptions): PresetTemplate | undefined {
	const config = getConfig(options);
	const preset = config.presets.get(name);

	if (!preset) {
		return undefined;
	}

	return presetToTemplate(preset);
}

/**
 * Check if a preset exists in YAML config.
 */
export function isYamlPreset(name: string, options?: LoadConfigOptions): boolean {
	const config = getConfig(options);
	return config.presets.has(name);
}

// =============================================================================
// Team Adapter
// =============================================================================

/**
 * Team info for display in UI.
 */
export interface YamlTeamInfo {
	name: string;
	description?: string;
	agentCount: number;
	source: "builtin" | "user" | "project";
}

/**
 * Get all team info from YAML config.
 */
export function getYamlTeams(options?: LoadConfigOptions): YamlTeamInfo[] {
	const config = getConfig(options);

	return Array.from(config.teams.values()).map((team) => ({
		name: team.name,
		description: team.description,
		agentCount: team.agents.length,
		source: team.source,
	}));
}

/**
 * Get a team by name from YAML config.
 */
export function getYamlTeam(name: string, options?: LoadConfigOptions): ResolvedTeamConfig | undefined {
	const config = getConfig(options);
	return config.teams.get(name);
}

/**
 * Get team agent names (preset names) for a team.
 */
export function getYamlTeamAgents(teamName: string, options?: LoadConfigOptions): string[] {
	const team = getYamlTeam(teamName, options);
	return team?.agents ?? [];
}

/**
 * Get team strategy.
 */
export function getYamlTeamStrategy(teamName: string, options?: LoadConfigOptions): MergeStrategyType {
	const team = getYamlTeam(teamName, options);
	return team?.strategy ?? "verification";
}

// =============================================================================
// Settings Adapter
// =============================================================================

/**
 * Get application settings from YAML config.
 */
export function getYamlSettings(options?: LoadConfigOptions): ResolvedConfig["settings"] {
	const config = getConfig(options);
	return config.settings;
}

/**
 * Get model defaults from YAML config.
 */
export function getYamlModelDefaults(options?: LoadConfigOptions): ResolvedConfig["models"]["defaults"] {
	const config = getConfig(options);
	return config.models.defaults;
}
