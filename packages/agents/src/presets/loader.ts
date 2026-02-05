/**
 * Runtime YAML loader for agent preset definitions.
 *
 * Reads *.yaml files from the definitions/ directory at import time,
 * resolves !file references to load external markdown prompts,
 * and returns typed PresetTemplate objects.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PresetTemplate } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const DEFINITIONS_DIR = resolve(import.meta.dirname!, "definitions");

// ─── !file tag resolution ───────────────────────────────────────────────────

/**
 * Resolve !file references in raw YAML content before parsing.
 * Replaces `!file path.md` with the file's content as a YAML block scalar.
 */
function resolveFileReferences(content: string, yamlDir: string): string {
	return content.replace(/!file\s+(\S+)/g, (_match, filePath: string) => {
		const absPath = resolve(yamlDir, filePath);
		const fileContent = readFileSync(absPath, "utf-8");
		const indented = fileContent
			.split("\n")
			.map((line, i) => (i === 0 ? line : `  ${line}`))
			.join("\n");
		return `|\n  ${indented}`;
	});
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateDef(
	file: string,
	def: Record<string, unknown>,
): asserts def is Record<string, unknown> & {
	name: string;
	description: string;
	systemPrompt: string;
} {
	if (!def.name || typeof def.name !== "string") {
		throw new Error(`${file}: missing or invalid 'name'`);
	}
	if (!def.description || typeof def.description !== "string") {
		throw new Error(`${file}: missing or invalid 'description'`);
	}
	if (!def.systemPrompt || typeof def.systemPrompt !== "string") {
		throw new Error(`${file}: missing or invalid 'systemPrompt'`);
	}
	if (def.thinkingLevel && !VALID_THINKING_LEVELS.has(def.thinkingLevel as string)) {
		throw new Error(
			`${file}: invalid thinkingLevel '${def.thinkingLevel}'. Valid: ${[...VALID_THINKING_LEVELS].join(", ")}`,
		);
	}
	if (def.temperature !== undefined && typeof def.temperature !== "number") {
		throw new Error(`${file}: temperature must be a number`);
	}
	if (def.maxTokens !== undefined && typeof def.maxTokens !== "number") {
		throw new Error(`${file}: maxTokens must be a number`);
	}
}

// ─── Loader ─────────────────────────────────────────────────────────────────

function loadPresetFromYaml(filePath: string): PresetTemplate {
	const rawContent = readFileSync(filePath, "utf-8");
	const yamlDir = dirname(filePath);
	const resolvedContent = resolveFileReferences(rawContent, yamlDir);
	const def = parseYaml(resolvedContent) as Record<string, unknown>;
	const fileName = filePath.split("/").pop() ?? filePath;

	validateDef(fileName, def);

	const template: PresetTemplate = {
		name: def.name,
		description: def.description,
		systemPrompt: (def.systemPrompt as string).trimEnd(),
	};

	if (def.thinkingLevel) {
		template.thinkingLevel = def.thinkingLevel as PresetTemplate["thinkingLevel"];
	}
	if (def.temperature !== undefined) {
		template.temperature = def.temperature as number;
	}
	if (def.maxTokens !== undefined) {
		template.maxTokens = def.maxTokens as number;
	}
	if (def.model && typeof def.model === "string") {
		template.model = def.model;
	}
	if (Array.isArray(def.tools)) {
		template.tools = def.tools as string[];
	}

	return template;
}

/**
 * Load all preset templates from YAML definitions.
 * Returns a Map keyed by preset name.
 */
export function loadAllPresets(): Map<string, PresetTemplate> {
	const presets = new Map<string, PresetTemplate>();

	const files = readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

	for (const file of files) {
		const preset = loadPresetFromYaml(join(DEFINITIONS_DIR, file));
		presets.set(preset.name, preset);
	}

	return presets;
}

// ─── Eagerly load all presets at import time ────────────────────────────────

const ALL_PRESETS = loadAllPresets();

/** Get a preset by name. */
export function getPreset(name: string): PresetTemplate | undefined {
	return ALL_PRESETS.get(name);
}

/** Get all loaded presets. */
export function getAllPresets(): ReadonlyMap<string, PresetTemplate> {
	return ALL_PRESETS;
}

// ─── Named exports for backward compatibility ──────────────────────────────

function requirePreset(name: string): PresetTemplate {
	const p = ALL_PRESETS.get(name);
	if (!p) throw new Error(`Preset '${name}' not found in ${DEFINITIONS_DIR}`);
	return p;
}

export const committerTemplate: PresetTemplate = requirePreset("committer");
export const explorerTemplate: PresetTemplate = requirePreset("explorer");
export const plannerTemplate: PresetTemplate = requirePreset("planner");
export const reviewerTemplate: PresetTemplate = requirePreset("reviewer");
