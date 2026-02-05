import type { ThinkingLevel } from "agent";
import type { Api, Model } from "ai";

/**
 * Preset template - model-agnostic configuration.
 * The model is provided at runtime when creating an AgentPreset.
 */
export interface PresetTemplate {
	/** Unique identifier for this preset */
	name: string;
	/** Human-readable description */
	description: string;
	/** System prompt defining behavior */
	systemPrompt: string;
	/** Recommended thinking level */
	thinkingLevel?: ThinkingLevel;
	/** Recommended temperature */
	temperature?: number;
	/** Recommended max tokens */
	maxTokens?: number;
	/** Preferred model in provider/model-id format (e.g. "openai-codex/gpt-5.2") */
	model?: string;
	/** Allowed tools for this agent */
	tools?: string[];
}

/**
 * Standard tool usage instructions for team agents.
 * Appended to system prompts to enable codebase analysis and research.
 */
export const TOOL_USAGE_INSTRUCTIONS = `
## Tools

**read** - read({ path: "file.ts" })
**bash** - fd, rg, ls, tree for exploration

**phi_delta** (memory) via bash:
  recent [N] | search [q] | get ID | forget ID | tag ID TAG
  low/normal/high/critical "content"  # quick remember by importance
  Example: bash({ command: 'phi_delta high "Found XSS in auth"' })
`;

/**
 * Standard epsilon task tracking instructions for team agents.
 * Appended to system prompts to enable task progress tracking.
 */
export const EPSILON_TASK_INSTRUCTIONS = `
## Task Tracking (Required)

**phi_epsilon** via bash - MUST track progress for UI display:
  add "title" [--priority 3] | wip ID | done ID | drop ID
  backlog | next | todo | get ID

Workflow:
  bash({ command: 'phi_epsilon add "Scan auth" --priority 3' })
  bash({ command: 'phi_epsilon wip 1' })   # start
  bash({ command: 'phi_epsilon done 1' })  # complete
`;

export interface CreatePresetOptions
	extends Partial<Pick<PresetTemplate, "thinkingLevel" | "temperature" | "maxTokens">> {
	/** If true, append epsilon task tracking instructions to system prompt */
	injectEpsilon?: boolean;
	/** If true, append tool usage instructions to system prompt (default: true when injectEpsilon is true) */
	injectToolUsage?: boolean;
}

/**
 * Create an AgentPreset from a template and model.
 * @param model Any model type (Api is the union of all supported APIs)
 * @param overrides Optional overrides for thinking level, temperature, and instruction injection
 */
export function createPreset(template: PresetTemplate, model: Model<Api>, overrides?: CreatePresetOptions) {
	// Default: inject tool usage instructions when epsilon is injected
	const injectEpsilon = overrides?.injectEpsilon ?? false;
	const injectToolUsage = overrides?.injectToolUsage ?? injectEpsilon;

	let systemPrompt = template.systemPrompt;

	// Inject tool usage instructions first (agents need to know about tools)
	if (injectToolUsage) {
		systemPrompt = `${systemPrompt}\n${TOOL_USAGE_INSTRUCTIONS}`;
	}

	// Then inject epsilon task tracking instructions
	if (injectEpsilon) {
		systemPrompt = `${systemPrompt}\n${EPSILON_TASK_INSTRUCTIONS}`;
	}

	return {
		name: template.name,
		description: template.description,
		model,
		systemPrompt,
		thinkingLevel: overrides?.thinkingLevel ?? template.thinkingLevel,
		temperature: overrides?.temperature ?? template.temperature,
		maxTokens: overrides?.maxTokens ?? template.maxTokens,
	};
}
