/**
 * Configuration types for YAML-driven configuration system.
 */

import type { ThinkingLevel } from "agent";
import type { MergeStrategyType } from "agents";

// =============================================================================
// Preset Configuration
// =============================================================================

/**
 * Agent preset configuration from YAML.
 */
export interface PresetConfig {
	/** Human-readable description */
	description: string;
	/** System prompt for the agent */
	prompt: string;
	/** Thinking level (off, low, medium, high) */
	thinking?: ThinkingLevel;
	/** Temperature (0-1) */
	temperature?: number;
	/** Max tokens for response */
	maxTokens?: number;
	/** Internal preset (not shown in UI) */
	internal?: boolean;
}

// =============================================================================
// Team Configuration
// =============================================================================

/**
 * Team agent reference - can be preset name or inline config.
 */
export type TeamAgentRef = string | TeamAgentInline;

/**
 * Inline agent definition within a team.
 */
export interface TeamAgentInline {
	/** Base preset to extend */
	preset?: string;
	/** Custom name (overrides preset name) */
	name?: string;
	/** Model override (provider:model-id[:thinking]) */
	model?: string;
	/** Prompt override or extension */
	prompt?: string;
	/** Append prompt to preset instead of replacing */
	appendPrompt?: boolean;
	/** Temperature override */
	temperature?: number;
	/** Thinking level override */
	thinking?: ThinkingLevel;
}

/**
 * Team configuration from YAML.
 */
export interface TeamConfig {
	/** Human-readable description */
	description?: string;
	/** Merge strategy */
	strategy?: MergeStrategyType;
	/** List of agents (preset names or inline configs) */
	agents: TeamAgentRef[];
}

// =============================================================================
// Model Configuration
// =============================================================================

/**
 * Model definition in config.
 */
export interface ModelConfig {
	/** Model ID (e.g., "claude-sonnet-4-20250514") */
	id: string;
	/** Display name */
	name: string;
	/** Context window size in tokens */
	contextWindow: number;
	/** Maximum output tokens */
	maxOutput: number;
	/** Supports extended thinking */
	supportsThinking?: boolean;
	/** Supports vision/images */
	supportsVision?: boolean;
}

/**
 * Provider configuration.
 */
export interface ProviderConfig {
	/** Available models for this provider */
	models: ModelConfig[];
	/** Default model ID for this provider */
	default?: string;
}

/**
 * Default model settings.
 */
export interface ModelDefaults {
	/** Default model for single-agent operations */
	agent?: string;
	/** Default model for team operations */
	team?: string;
}

/**
 * Models configuration section.
 */
export interface ModelsConfig {
	/** Default model settings */
	defaults?: ModelDefaults;
	/** Provider-specific configurations */
	providers?: Record<string, ProviderConfig>;
}

// =============================================================================
// Settings Configuration
// =============================================================================

/**
 * Editor settings.
 */
export interface EditorSettings {
	tabSize?: number;
	insertSpaces?: boolean;
}

/**
 * Display settings.
 */
export interface DisplaySettings {
	showThinking?: boolean;
	showTokenUsage?: boolean;
	compactMode?: boolean;
}

/**
 * Team execution settings.
 */
export interface TeamSettings {
	maxRetries?: number;
	continueOnError?: boolean;
	defaultStrategy?: MergeStrategyType;
}

/**
 * Git settings.
 */
export interface GitSettings {
	autoStage?: boolean;
	signCommits?: boolean;
}

/**
 * Keybinding settings.
 */
export type KeybindingSettings = Record<string, string>;

/**
 * All settings.
 */
export interface SettingsConfig {
	editor?: EditorSettings;
	display?: DisplaySettings;
	team?: TeamSettings;
	git?: GitSettings;
	keybindings?: KeybindingSettings;
}

// =============================================================================
// Root Configuration
// =============================================================================

/**
 * Complete configuration file structure.
 */
export interface AppConfig {
	/** Agent preset definitions */
	presets?: Record<string, PresetConfig>;
	/** Team definitions */
	teams?: Record<string, TeamConfig>;
	/** Model configurations */
	models?: ModelsConfig;
	/** Application settings */
	settings?: SettingsConfig;
}

// =============================================================================
// Resolved Types (after loading and merging)
// =============================================================================

/**
 * Fully resolved preset ready for use.
 */
export interface ResolvedPreset {
	name: string;
	description: string;
	prompt: string;
	thinking?: ThinkingLevel;
	temperature?: number;
	maxTokens?: number;
	internal: boolean;
	source: "builtin" | "user" | "project";
}

/**
 * Fully resolved team ready for use.
 */
export interface ResolvedTeamConfig {
	name: string;
	description?: string;
	strategy: MergeStrategyType;
	agents: string[]; // Resolved preset names
	source: "builtin" | "user" | "project";
}

/**
 * Fully resolved configuration.
 */
export interface ResolvedConfig {
	presets: Map<string, ResolvedPreset>;
	teams: Map<string, ResolvedTeamConfig>;
	models: ModelsConfig;
	settings: Required<SettingsConfig>;
	/** Errors encountered during config loading (non-fatal) */
	configErrors?: string[];
}
