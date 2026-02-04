import type { ThinkingLevel } from "agent";
import type { Model } from "ai";

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
}

/**
 * Create an AgentPreset from a template and model.
 */
export function createPreset(
	template: PresetTemplate,
	model: Model<any>,
	overrides?: Partial<Pick<PresetTemplate, "thinkingLevel" | "temperature" | "maxTokens">>,
) {
	return {
		name: template.name,
		description: template.description,
		model,
		systemPrompt: template.systemPrompt,
		thinkingLevel: overrides?.thinkingLevel ?? template.thinkingLevel,
		temperature: overrides?.temperature ?? template.temperature,
		maxTokens: overrides?.maxTokens ?? template.maxTokens,
	};
}
