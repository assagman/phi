/**
 * YAML-driven configuration system.
 *
 * Usage:
 *   import { loadConfig, type ResolvedConfig } from "./config/index.js";
 *   const config = loadConfig({ cwd: process.cwd() });
 *
 *   // Or use the adapter for compatibility with existing code:
 *   import { getYamlPresetTemplate, getYamlTeamAgents } from "./config/index.js";
 */

export * from "./adapter.js";
export * from "./loader.js";
export * from "./types.js";
