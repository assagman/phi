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
}

/**
 * Standard epsilon task tracking instructions for team agents.
 * Appended to system prompts to enable task progress tracking.
 */
export const EPSILON_TASK_INSTRUCTIONS = `
## Task Tracking (Required)

You MUST use epsilon task management to track your work progress. This enables the UI to show your progress to the user.

### Workflow
1. **Start:** Create tasks for each major step of your analysis using \`epsilon_task_create\`
2. **Progress:** Update task status to \`in_progress\` when starting work on it
3. **Complete:** Update task status to \`done\` when finished

### Example
\`\`\`
// At start of analysis, create tasks:
epsilon_task_create({ title: "Scan authentication code", priority: "high", status: "in_progress" })
epsilon_task_create({ title: "Check input validation", priority: "high" })
epsilon_task_create({ title: "Review crypto usage", priority: "medium" })

// As you complete each task:
epsilon_task_update({ id: 1, status: "done" })
epsilon_task_update({ id: 2, status: "in_progress" })
// ... work on task 2 ...
epsilon_task_update({ id: 2, status: "done" })
\`\`\`

### Task Titles
Use short, descriptive titles (max 50 chars) that describe the current activity:
- "Scanning auth endpoints"
- "Checking SQL queries"  
- "Reviewing error handlers"
- "Analyzing API routes"

This is MANDATORY for proper UI progress display.
`;

/**
 * Create an AgentPreset from a template and model.
 * @param model Any model type (Api is the union of all supported APIs)
 * @param injectEpsilon If true, append epsilon task tracking instructions to system prompt
 */
export function createPreset(
	template: PresetTemplate,
	model: Model<Api>,
	overrides?: Partial<Pick<PresetTemplate, "thinkingLevel" | "temperature" | "maxTokens">> & {
		injectEpsilon?: boolean;
	},
) {
	const systemPrompt = overrides?.injectEpsilon
		? `${template.systemPrompt}\n${EPSILON_TASK_INSTRUCTIONS}`
		: template.systemPrompt;

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
