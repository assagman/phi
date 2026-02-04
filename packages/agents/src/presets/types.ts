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
 * Standard tool usage instructions for team agents.
 * Appended to system prompts to enable codebase analysis and research.
 */
export const TOOL_USAGE_INSTRUCTIONS = `
## Available Tools

You have access to tools for analyzing the codebase and researching online. USE THEM.

### Codebase Analysis Tools

**read** - Read file contents
\`\`\`
read({ path: "src/auth/login.ts" })
read({ path: "package.json" })
\`\`\`

**bash** - Run shell commands for exploration (read-only operations)
\`\`\`
// Find files
bash({ command: "fd -e ts -e js src/" })
bash({ command: "find . -name '*.py' -type f" })

// Search code
bash({ command: "rg 'password|secret|key' --type ts -l" })
bash({ command: "grep -r 'TODO' src/" })

// List directory structure
bash({ command: "ls -la src/core/" })
bash({ command: "tree -L 2 packages/" })

// Get file info
bash({ command: "wc -l src/**/*.ts" })
bash({ command: "head -50 README.md" })
\`\`\`

### Web Search Tools (agentsbox)

If available, use agentsbox tools to research current information:

**agentsbox_search_bm25** - Find tools by description
\`\`\`
agentsbox_search_bm25({ text: "search the web" })
agentsbox_search_bm25({ text: "github repository" })
\`\`\`

**agentsbox_execute** - Run discovered tools
\`\`\`
// Web search (after discovering tool via search)
agentsbox_execute({ toolId: "tavily_search", arguments: '{"query": "best practices for JWT auth"}' })
agentsbox_execute({ toolId: "brave_web_search", arguments: '{"query": "CVE-2024 node.js"}' })
\`\`\`

### Memory Tools (delta)

Use delta to recall and store knowledge:
\`\`\`
delta_search({ query: "previous audit findings" })
delta_remember({ content: "Found critical XSS in auth module", tags: ["security", "finding"], importance: "high" })
\`\`\`

### Guidelines

1. **Read before analyzing** - Always read the actual code before making claims
2. **Search for patterns** - Use grep/rg to find all occurrences of patterns
3. **Verify with research** - Use web search to check current best practices and known vulnerabilities
4. **Explore structure first** - Use ls/tree/fd to understand project layout before diving in
`;

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
