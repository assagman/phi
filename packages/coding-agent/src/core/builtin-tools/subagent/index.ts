/**
 * Subagent — First-class builtin agent delegation
 *
 * Delegates tasks to specialized agents with isolated context windows.
 * Combines agents package presets with file-based custom agents.
 *
 * Usage:
 *   Tool:  subagent({ agent: "security-auditor", task: "review auth" })
 *   Tool:  subagent({ parallel: [{agent, task}, ...] })
 *   Tool:  subagent({ chain: [{agent, task}, ...] })
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "agent";
import * as agentsPkg from "agents";
import type { Message, Model } from "ai";
import { extensionsLog } from "../../../utils/logger.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default maximum number of parallel tasks */
const DEFAULT_MAX_PARALLEL_TASKS = 8;
/** Default maximum concurrent subprocess executions */
const DEFAULT_MAX_CONCURRENCY = 4;
/** Log prefix for consistent error message formatting */
const LOG_PREFIX = "[subagent]";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AgentSource = "preset" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	source: AgentSource;
	filePath?: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	temperature?: number;
}

export interface SubagentTask {
	agent: string;
	task: string;
	cwd?: string;
}

/** A tool call happening inside a subagent subprocess */
export interface SubagentToolEvent {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	running: boolean;
	isError?: boolean;
}

export interface ExecutionResult {
	agent: string;
	source: AgentSource;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: ExecutionResult[];
	/** Currently running + recently completed tools inside the subprocess */
	activeTools?: SubagentToolEvent[];
	/** All tool events across the entire subprocess lifetime (read, bash, etc.) */
	allTools?: SubagentToolEvent[];
	/** Streaming assistant text from the subprocess */
	currentText?: string;
	/** Streaming thinking text from the subprocess */
	currentThinking?: string;
	/** Name of the agent being executed */
	agentName?: string;
	/** Task description */
	task?: string;
	/** Short ~50-char summary for collapsed display after delegation completes */
	summary?: string;
	/** Completed turns so far */
	turns?: number;
	/** Agent metadata for display */
	agentProvider?: string;
	agentModel?: string;
	agentThinkingLevel?: string;
	agentTemperature?: number;
	agentSource?: AgentSource;
}

// ─── Preset Registry ────────────────────────────────────────────────────────

const PRESET_MAP: Record<string, { template: agentsPkg.PresetTemplate; pkg: typeof agentsPkg }> = {};

function initPresets() {
	const presetExports = agentsPkg as unknown as Record<string, agentsPkg.PresetTemplate>;
	for (const [key, value] of Object.entries(presetExports)) {
		if (key.endsWith("Template") && typeof value === "object" && value?.name) {
			const name = value.name;
			PRESET_MAP[name] = { template: value, pkg: agentsPkg };
		}
	}
}
initPresets();

// ─── File-based Agent Discovery ─────────────────────────────────────────────

interface Frontmatter {
	name?: string;
	description?: string;
	model?: string;
	tools?: string;
	thinkingLevel?: string;
	temperature?: string;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") {
		return { frontmatter: {}, body: content };
	}

	const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (endIndex === -1) {
		return { frontmatter: {}, body: content };
	}

	const frontmatterLines = lines.slice(1, endIndex);
	const body = lines
		.slice(endIndex + 1)
		.join("\n")
		.trim();

	const frontmatter: Frontmatter = {};
	for (const line of frontmatterLines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		if (key === "tools") {
			frontmatter.tools = value;
		} else if (key === "temperature") {
			frontmatter.temperature = value;
		} else {
			(frontmatter as Record<string, string>)[key] = value;
		}
	}

	return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentDefinition[] {
	if (!existsSync(dir)) return [];

	const agents: AgentDefinition[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
	} catch (err) {
		extensionsLog.debug(`${LOG_PREFIX} Failed to read agents directory: ${dir}`, {
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}

	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const name = entry.name;
		if (typeof name !== "string" || !name.endsWith(".md")) continue;

		const filePath = join(dir, name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (err) {
			extensionsLog.debug(`${LOG_PREFIX} Failed to read agent file: ${filePath}`, {
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) {
			extensionsLog.debug(`${LOG_PREFIX} Agent file missing name or description: ${filePath}`);
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			source,
			filePath,
			model: frontmatter.model,
			tools: frontmatter.tools
				?.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
			systemPrompt: body,
			thinkingLevel: frontmatter.thinkingLevel as AgentDefinition["thinkingLevel"],
			temperature: frontmatter.temperature ? Number.parseFloat(frontmatter.temperature) : undefined,
		});
	}

	return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = join(currentDir, ".phi", "agents");
		if (existsSync(candidate)) return candidate;

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// ─── Agent Registry with Caching ────────────────────────────────────────────

export interface AgentRegistry {
	agents: AgentDefinition[];
	get(name: string): AgentDefinition | undefined;
	list(): AgentDefinition[];
	formatList(): string;
}

/** Cache for agent registries by cwd+scope */
const registryCache = new Map<string, { registry: AgentRegistry; timestamp: number }>();
/** Cache TTL in milliseconds (5 minutes) */
const REGISTRY_CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(cwd: string, scope: string): string {
	return `${cwd}:${scope}`;
}

export function createAgentRegistry(cwd: string, scope: "preset" | "user" | "project" | "all" = "all"): AgentRegistry {
	const cacheKey = getCacheKey(cwd, scope);
	const cached = registryCache.get(cacheKey);
	const now = Date.now();

	if (cached && now - cached.timestamp < REGISTRY_CACHE_TTL) {
		return cached.registry;
	}

	const agents: AgentDefinition[] = [];
	const seen = new Set<string>();

	// Load presets
	if (scope === "all" || scope === "preset") {
		for (const [name, { template }] of Object.entries(PRESET_MAP)) {
			agents.push({
				name: template.name,
				description: template.description,
				source: "preset",
				systemPrompt: template.systemPrompt,
				thinkingLevel: template.thinkingLevel,
				temperature: template.temperature,
				model: template.model,
				tools: template.tools,
			});
			seen.add(name);
		}
	}

	// Load user agents (~/.phi/agent/agents/)
	if (scope === "all" || scope === "user") {
		const userDir = join(homedir(), ".phi", "agent", "agents");
		for (const agent of loadAgentsFromDir(userDir, "user")) {
			if (!seen.has(agent.name)) {
				agents.push(agent);
				seen.add(agent.name);
			}
		}
	}

	// Load project agents (./.phi/agents/)
	if (scope === "all" || scope === "project") {
		const projectDir = findProjectAgentsDir(cwd);
		if (projectDir) {
			for (const agent of loadAgentsFromDir(projectDir, "project")) {
				if (!seen.has(agent.name)) {
					agents.push(agent);
					seen.add(agent.name);
				}
			}
		}
	}

	const registry: AgentRegistry = {
		agents,
		get(name: string) {
			return agents.find((a) => a.name === name);
		},
		list() {
			return [...agents];
		},
		formatList() {
			const maxNameLen = Math.max(...agents.map((a) => a.name.length));
			return agents
				.map((a) => {
					const icon = a.source === "preset" ? "◆" : a.source === "user" ? "○" : "▲";
					return `  ${icon} ${a.name.padEnd(maxNameLen)}  ${a.description}`;
				})
				.join("\n");
		},
	};

	registryCache.set(cacheKey, { registry, timestamp: now });
	return registry;
}

/** Clear registry cache (for testing or when agents change) */
export function clearRegistryCache(): void {
	registryCache.clear();
}

// ─── Subagent Execution ─────────────────────────────────────────────────────

/**
 * Get the canonical env var name(s) for a provider's API key.
 * Must stay in sync with getEnvApiKey() in the AI package (source of truth).
 *
 * Returns an array because some providers check multiple env vars
 * (e.g., anthropic checks ANTHROPIC_OAUTH_TOKEN and ANTHROPIC_API_KEY).
 * The first entry is the primary var where we SET the key.
 */
function getProviderEnvVars(provider: string): string[] {
	switch (provider) {
		case "anthropic":
			return ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"];
		case "openai":
			return ["OPENAI_API_KEY"];
		case "google":
			return ["GEMINI_API_KEY"];
		case "google-gemini-cli":
			return ["GEMINI_API_KEY"];
		case "google-vertex":
			return ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"];
		case "amazon-bedrock":
			return [
				"AWS_ACCESS_KEY_ID",
				"AWS_SECRET_ACCESS_KEY",
				"AWS_SESSION_TOKEN",
				"AWS_REGION",
				"AWS_DEFAULT_REGION",
				"AWS_PROFILE",
				"AWS_BEARER_TOKEN_BEDROCK",
				"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
				"AWS_CONTAINER_CREDENTIALS_FULL_URI",
				"AWS_WEB_IDENTITY_TOKEN_FILE",
			];
		case "github-copilot":
			return ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
		case "xai":
			return ["XAI_API_KEY"];
		case "groq":
			return ["GROQ_API_KEY"];
		case "cerebras":
			return ["CEREBRAS_API_KEY"];
		case "mistral":
			return ["MISTRAL_API_KEY"];
		case "openrouter":
			return ["OPENROUTER_API_KEY"];
		case "vercel-ai-gateway":
			return ["AI_GATEWAY_API_KEY"];
		case "zai":
			return ["ZAI_API_KEY"];
		case "minimax":
			return ["MINIMAX_API_KEY"];
		case "minimax-cn":
			return ["MINIMAX_CN_API_KEY"];
		case "opencode":
			return ["OPENCODE_API_KEY"];
		case "kimi-for-coding":
			return ["KIMI_API_KEY"];
		default:
			return [`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
	}
}

/**
 * Build minimal env vars for subprocess.
 * Only passes essential vars + the specific API key needed.
 * [P1-SEC-001] Prevents exposure of unrelated secrets.
 */
function buildSubprocessEnv(provider: string, apiKey: string): Record<string, string> {
	const env: Record<string, string> = {};

	// Essential system vars
	const essentialVars = ["PATH", "HOME", "TERM", "SHELL", "LANG", "LC_ALL", "USER", "LOGNAME"];
	for (const key of essentialVars) {
		if (process.env[key]) {
			env[key] = process.env[key]!;
		}
	}

	// For providers that use multiple env vars (bedrock, vertex, copilot),
	// pass through whichever vars are set in the parent process.
	// For simple API key providers, set the primary env var.
	const providerVars = getProviderEnvVars(provider);
	const needsPassthrough =
		provider === "amazon-bedrock" || provider === "google-vertex" || provider === "github-copilot";

	if (needsPassthrough) {
		for (const key of providerVars) {
			if (process.env[key]) {
				env[key] = process.env[key]!;
			}
		}
	} else {
		// Set the primary env var with the resolved API key
		env[providerVars[0]] = apiKey;
	}

	return env;
}

function createTempPromptFile(agentName: string, prompt: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "phi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const path = join(dir, `prompt-${safeName}.md`);
	// Secure file permissions (owner read/write only)
	const fd = require("node:fs").openSync(path, "w", 0o600);
	require("node:fs").writeSync(fd, prompt);
	require("node:fs").closeSync(fd);
	return { dir, path };
}

/**
 * Clean up temp files safely.
 */
function cleanupTempFiles(tmpDir: string | null, tmpPromptPath: string | null): void {
	const fs = require("node:fs");
	if (tmpPromptPath) {
		try {
			fs.rmSync(tmpPromptPath);
		} catch (err) {
			extensionsLog.debug(`${LOG_PREFIX} Failed to cleanup temp file: ${tmpPromptPath}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (tmpDir) {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch (err) {
			extensionsLog.debug(`${LOG_PREFIX} Failed to cleanup temp dir: ${tmpDir}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/** Progress snapshot from a running subprocess */
interface SubagentProgress {
	result: ExecutionResult;
	activeTools: SubagentToolEvent[];
	allTools: SubagentToolEvent[];
	currentText: string;
	currentThinking: string;
}

/**
 * Parse a "provider/modelId" string into its components.
 * Returns undefined if the string doesn't contain a slash.
 */
function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
	const slashIdx = spec.indexOf("/");
	if (slashIdx <= 0 || slashIdx === spec.length - 1) return undefined;
	return { provider: spec.substring(0, slashIdx), modelId: spec.substring(slashIdx + 1) };
}

/**
 * Resolve the provider and API key for a subagent subprocess.
 * When the agent has its own model, resolves the key for THAT provider.
 * Otherwise falls back to the parent model's provider.
 */
async function resolveSubprocessAuth(
	agent: AgentDefinition,
	parentModel: Model<any>,
	context: SubagentToolContext,
): Promise<{ provider: string; modelId: string; apiKey: string }> {
	if (agent.model) {
		const parsed = parseModelSpec(agent.model);
		if (parsed) {
			const apiKey = await context.getApiKeyForProvider(parsed.provider);
			return { provider: parsed.provider, modelId: parsed.modelId, apiKey };
		}
		// No slash — treat entire string as model ID, use parent provider
		const apiKey = await context.getApiKey(parentModel);
		return { provider: parentModel.provider, modelId: agent.model, apiKey };
	}
	// No agent model — use parent model
	const apiKey = await context.getApiKey(parentModel);
	return { provider: parentModel.provider, modelId: parentModel.id, apiKey };
}

async function runSubagent(
	agent: AgentDefinition,
	task: string,
	provider: string,
	modelId: string,
	apiKey: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((progress: SubagentProgress) => void) | undefined,
	step?: number,
): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		agent: agent.name,
		source: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model || modelId,
		step,
	};

	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	// Pass --provider and --model as separate flags so the subprocess resolves correctly
	args.push("--provider", provider, "--model", modelId);

	// Use agent's preferred tools if specified
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let wasAborted = false;

	// Build system prompt
	// Delta and epsilon are injected by the builtin tools lifecycle for all modes,
	// so we don't inject abbreviated versions here (avoids duplication/conflict)
	const systemPrompt = agent.systemPrompt;

	if (systemPrompt.trim()) {
		const tmp = createTempPromptFile(agent.name, systemPrompt);
		tmpDir = tmp.dir;
		tmpPromptPath = tmp.path;
		args.push("--append-system-prompt", tmpPromptPath);
	}

	args.push(`Task: ${task}`);

	// [P1-SEC-001] Use minimal env vars instead of spreading process.env
	const env = buildSubprocessEnv(provider, apiKey);

	return new Promise((resolve, reject) => {
		const proc = spawn("phi", args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";

		// Real-time progress tracking for subprocess tool calls
		const activeTools = new Map<string, SubagentToolEvent>();
		/** Accumulates ALL tool events across the entire subprocess lifetime */
		const allToolsList: SubagentToolEvent[] = [];
		let currentText = "";
		let currentThinking = "";
		let lastProgressEmit = 0;
		const PROGRESS_THROTTLE_MS = 100;

		const emitProgress = () => {
			if (!onUpdate) return;
			const now = Date.now();
			if (now - lastProgressEmit < PROGRESS_THROTTLE_MS) return;
			lastProgressEmit = now;
			onUpdate({
				result,
				activeTools: [...activeTools.values()],
				allTools: [...allToolsList],
				currentText,
				currentThinking,
			});
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			const evt = event as {
				type?: string;
				message?: Message;
				toolCallId?: string;
				toolName?: string;
				args?: Record<string, unknown>;
				isError?: boolean;
			};

			// Track subprocess tool calls
			if (evt.type === "tool_execution_start" && evt.toolCallId && evt.toolName) {
				const toolEvent: SubagentToolEvent = {
					toolCallId: evt.toolCallId,
					toolName: evt.toolName,
					args: evt.args ?? {},
					running: true,
				};
				activeTools.set(evt.toolCallId, toolEvent);
				allToolsList.push(toolEvent);
				emitProgress();
			}

			if (evt.type === "tool_execution_end" && evt.toolCallId) {
				const tool = activeTools.get(evt.toolCallId);
				if (tool) {
					// Same object is in allToolsList — mutation propagates
					tool.running = false;
					tool.isError = evt.isError;
				}
				emitProgress();
			}

			// Track streaming assistant text and thinking
			if (evt.type === "message_update" && evt.message?.role === "assistant") {
				const msg = evt.message;
				for (const part of msg.content) {
					if (part.type === "text") {
						currentText = part.text;
					} else if (part.type === "thinking") {
						currentThinking = (part as { type: "thinking"; thinking: string }).thinking;
					}
				}
				emitProgress();
			}

			if (evt.type === "message_end" && evt.message) {
				const msg = evt.message;
				result.messages.push(msg);

				if (msg.role === "assistant") {
					result.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!result.model && msg.model) result.model = msg.model;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
				}
				// Reset streaming text/thinking and clear completed tools between turns
				currentText = "";
				currentThinking = "";
				for (const [id, tool] of activeTools) {
					if (!tool.running) activeTools.delete(id);
				}
				onUpdate?.({
					result,
					activeTools: [...activeTools.values()],
					allTools: [...allToolsList],
					currentText,
					currentThinking,
				});
			}

			if (evt.type === "tool_result_end" && evt.message) {
				result.messages.push(evt.message);
				onUpdate?.({
					result,
					activeTools: [...activeTools.values()],
					allTools: [...allToolsList],
					currentText,
					currentThinking,
				});
			}
		};

		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			result.stderr += data.toString();
		});

		// [P1-BUG-002] Cleanup temp files AFTER process exits, not in finally block
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			result.exitCode = code ?? 1;

			// Clean up temp files after process completes
			cleanupTempFiles(tmpDir, tmpPromptPath);

			if (wasAborted) {
				reject(new Error(`${LOG_PREFIX} Aborted`));
			} else {
				resolve(result);
			}
		});

		proc.on("error", (err: Error) => {
			result.exitCode = 1;
			result.errorMessage = err.message;

			// Clean up temp files on error
			cleanupTempFiles(tmpDir, tmpPromptPath);

			reject(new Error(`${LOG_PREFIX} ${err.message}`));
		});

		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			signal.addEventListener("abort", killProc, { once: true });
		}
	});
}

/**
 * Map items with concurrency limit.
 * Uses atomic index acquisition to prevent race conditions.
 */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);

	// Index counter - safe in single-threaded JS event loop
	// Each worker synchronously increments before any await
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			// Atomically acquire next index (sync operation before await)
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});

	await Promise.all(workers);
	return results;
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task description (for single mode)" })),
	summary: Type.Optional(
		Type.String({
			description: "Short ~50-char summary of the task for display (shown after delegation completes)",
		}),
	),
	parallel: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Agent name" }),
				task: Type.String({ description: "Task description" }),
				cwd: Type.Optional(Type.String({ description: "Working directory" })),
			}),
			{ description: "Parallel execution tasks" },
		),
	),
	chain: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Agent name" }),
				task: Type.String({ description: "Task (use {previous} for prior output)" }),
				cwd: Type.Optional(Type.String({ description: "Working directory" })),
			}),
			{ description: "Sequential chain execution" },
		),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	scope: Type.Optional(Type.String({ description: "Agent scope: preset, user, project, all", default: "all" })),
	maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (parallel mode)", default: 4 })),
});

export interface SubagentToolContext {
	getModel(): Model<any> | undefined;
	getApiKey(model: Model<any>): Promise<string>;
	getApiKeyForProvider(provider: string): Promise<string>;
	getWorkingDir(): string;
}

/** Build agent metadata fields for SubagentDetails */
function agentMeta(
	agent: AgentDefinition,
	model: Model<any>,
): Pick<SubagentDetails, "agentProvider" | "agentModel" | "agentThinkingLevel" | "agentTemperature" | "agentSource"> {
	let provider: string;
	let modelId: string;

	if (agent.model) {
		const parsed = parseModelSpec(agent.model);
		if (parsed) {
			provider = parsed.provider;
			modelId = parsed.modelId;
		} else {
			provider = model.provider;
			modelId = agent.model;
		}
	} else {
		provider = model.provider;
		modelId = model.id;
	}

	return {
		agentProvider: provider,
		agentModel: modelId,
		agentThinkingLevel: agent.thinkingLevel,
		agentTemperature: agent.temperature,
		agentSource: agent.source,
	};
}

// ─── Result Formatting ──────────────────────────────────────────────────────

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Check if an execution result represents a failure.
 * Returns true for non-zero exit codes, error stop reasons, or aborted runs.
 */
function isFailedResult(result: ExecutionResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * Build an error-aware tool result from a subprocess execution.
 * Includes stderr and error details when the subprocess failed.
 */
function buildToolResult(
	output: string,
	result: ExecutionResult,
	mode: SubagentDetails["mode"],
	details: Partial<SubagentDetails>,
): AgentToolResult<SubagentDetails> {
	const failed = isFailedResult(result);
	let text = output;

	if (!text && failed) {
		// Subprocess failed with no assistant output — surface the error
		const parts: string[] = [`${LOG_PREFIX} Subprocess failed (exit code ${result.exitCode})`];
		if (result.errorMessage) parts.push(`Error: ${result.errorMessage}`);
		if (result.stderr.trim()) {
			const stderrLines = result.stderr.trim().split("\n").slice(0, 10);
			parts.push(`Stderr:\n${stderrLines.join("\n")}`);
		}
		text = parts.join("\n");
	} else if (!text) {
		text = "(no output)";
	}

	return {
		content: [{ type: "text", text }],
		details: { mode, results: [result], ...details } as SubagentDetails,
	};
}

// ─── Tool Factory ───────────────────────────────────────────────────────────

export function createSubagentTool(context: SubagentToolContext): AgentTool<typeof SubagentParams> {
	return {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized agents with isolated context.",
			"Modes: single (agent + task), parallel (array), chain (sequential).",
			"Agents from presets (agents package) + user (~/.phi/agent/agents) + project (.phi/agents).",
		].join(" "),
		parameters: SubagentParams,

		async execute(
			_toolCallId: string,
			params: {
				agent?: string;
				task?: string;
				summary?: string;
				parallel?: Array<{ agent: string; task: string; cwd?: string }>;
				chain?: Array<{ agent: string; task: string; cwd?: string }>;
				cwd?: string;
				scope?: string;
				maxConcurrency?: number;
			},
			signal?: AbortSignal,
			onUpdate?: (result: AgentToolResult<SubagentDetails>) => void,
		): Promise<AgentToolResult<SubagentDetails>> {
			const scope = (params.scope || "all") as "preset" | "user" | "project" | "all";
			const registry = createAgentRegistry(context.getWorkingDir(), scope);
			const model = context.getModel();

			if (!model) {
				return {
					content: [{ type: "text", text: `${LOG_PREFIX} Error: No model selected` }],
					details: { mode: "single", results: [] },
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasParallel = (params.parallel?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasParallel) + Number(hasSingle);

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `${LOG_PREFIX} Provide exactly one mode.\n\nAvailable agents:\n${registry.formatList()}`,
						},
					],
					details: { mode: "single", results: [] },
				};
			}

			// ─── Chain Mode ─────────────────────────────────────────────────────
			if (params.chain && params.chain.length > 0) {
				const results: ExecutionResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const agent = registry.get(step.agent);

					if (!agent) {
						return {
							content: [{ type: "text", text: `${LOG_PREFIX} Unknown agent: ${step.agent}` }],
							details: { mode: "chain", results },
						};
					}

					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Emit initial update with agent metadata for this step
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: "(starting...)" }],
							details: {
								mode: "chain",
								results: [...results],
								agentName: step.agent,
								task: taskWithContext,
								...agentMeta(agent, model),
							},
						});
					}

					const chainUpdate = onUpdate
						? (progress: SubagentProgress) => {
								const allResults = [...results, progress.result];
								onUpdate({
									content: [
										{
											type: "text",
											text:
												progress.currentText || getFinalOutput(progress.result.messages) || "(running...)",
										},
									],
									details: {
										mode: "chain",
										results: allResults,
										activeTools: progress.activeTools,
										allTools: progress.allTools,
										currentText: progress.currentText,
										currentThinking: progress.currentThinking,
										agentName: step.agent,
										task: taskWithContext,
										turns: progress.result.usage.turns,
										...agentMeta(agent!, model),
									},
								});
							}
						: undefined;

					try {
						const auth = await resolveSubprocessAuth(agent, model, context);
						const result = await runSubagent(
							agent,
							taskWithContext,
							auth.provider,
							auth.modelId,
							auth.apiKey,
							step.cwd || context.getWorkingDir(),
							signal,
							chainUpdate,
							i + 1,
						);
						results.push(result);

						if (isFailedResult(result)) {
							const errorMsg =
								result.errorMessage || result.stderr.trim() || getFinalOutput(result.messages) || "(no output)";
							return {
								content: [
									{
										type: "text",
										text: `${LOG_PREFIX} Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
									},
								],
								details: { mode: "chain", results },
							};
						}

						previousOutput = getFinalOutput(result.messages);
					} catch (err) {
						extensionsLog.error(`${LOG_PREFIX} Chain execution failed at step ${i + 1}`, {
							agent: step.agent,
							error: err instanceof Error ? err.message : String(err),
						});
						return {
							content: [{ type: "text", text: `${LOG_PREFIX} Chain failed at step ${i + 1}: ${String(err)}` }],
							details: { mode: "chain", results },
						};
					}
				}

				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: { mode: "chain", results },
				};
			}

			// ─── Parallel Mode ──────────────────────────────────────────────────
			if (params.parallel && params.parallel.length > 0) {
				if (params.parallel.length > DEFAULT_MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `${LOG_PREFIX} Max ${DEFAULT_MAX_PARALLEL_TASKS} parallel tasks` }],
						details: { mode: "parallel", results: [] },
					};
				}

				// Validate all agents first
				for (const t of params.parallel) {
					if (!registry.get(t.agent)) {
						return {
							content: [{ type: "text", text: `${LOG_PREFIX} Unknown agent: ${t.agent}` }],
							details: { mode: "parallel", results: [] },
						};
					}
				}

				const allResults: ExecutionResult[] = new Array(params.parallel.length);

				const emitUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r?.exitCode === -1).length;
						const done = allResults.filter((r) => r && r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `${LOG_PREFIX} Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: { mode: "parallel", results: allResults.filter(Boolean) },
						});
					}
				};

				// Pre-resolve auth for all agents before spawning subprocesses.
				// This prevents leaking running subprocesses if one agent's key fails.
				const parallelAuth = new Map<string, Awaited<ReturnType<typeof resolveSubprocessAuth>>>();
				for (const t of params.parallel) {
					if (!parallelAuth.has(t.agent)) {
						const agent = registry.get(t.agent)!;
						parallelAuth.set(t.agent, await resolveSubprocessAuth(agent, model, context));
					}
				}

				// Use configurable concurrency limit
				const concurrencyLimit = Math.min(
					params.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
					DEFAULT_MAX_PARALLEL_TASKS,
				);

				const results = await mapWithConcurrencyLimit(params.parallel, concurrencyLimit, async (t, index) => {
					const agent = registry.get(t.agent)!;
					const auth = parallelAuth.get(t.agent)!;
					const result = await runSubagent(
						agent,
						t.task,
						auth.provider,
						auth.modelId,
						auth.apiKey,
						t.cwd || context.getWorkingDir(),
						signal,
						(progress) => {
							allResults[index] = progress.result;
							emitUpdate();
						},
					);
					allResults[index] = result;
					emitUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"}: ${preview || "(no output)"}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `${LOG_PREFIX} Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: { mode: "parallel", results },
				};
			}

			// ─── Single Mode ────────────────────────────────────────────────────
			if (params.agent && params.task) {
				const agent = registry.get(params.agent);
				if (!agent) {
					return {
						content: [{ type: "text", text: `${LOG_PREFIX} Unknown agent: ${params.agent}` }],
						details: { mode: "single", results: [] },
					};
				}

				// Emit initial update with agent metadata so UI shows it immediately
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: "(starting...)" }],
						details: {
							mode: "single",
							results: [],
							agentName: agent.name,
							task: params.task,
							summary: params.summary,
							...agentMeta(agent, model),
						},
					});
				}

				// Direct execution without UI overlay
				// Status updates are sent via onUpdate callback for inline display
				try {
					const auth = await resolveSubprocessAuth(agent, model, context);
					const result = await runSubagent(
						agent,
						params.task,
						auth.provider,
						auth.modelId,
						auth.apiKey,
						params.cwd || context.getWorkingDir(),
						signal,
						onUpdate
							? (progress) =>
									onUpdate({
										content: [
											{
												type: "text",
												text:
													progress.currentText ||
													getFinalOutput(progress.result.messages) ||
													"(running...)",
											},
										],
										details: {
											mode: "single",
											results: [progress.result],
											activeTools: progress.activeTools,
											allTools: progress.allTools,
											currentText: progress.currentText,
											currentThinking: progress.currentThinking,
											agentName: agent.name,
											task: params.task,
											summary: params.summary,
											turns: progress.result.usage.turns,
											...agentMeta(agent, model),
										},
									})
							: undefined,
					);

					return buildToolResult(getFinalOutput(result.messages), result, "single", {});
				} catch (err) {
					extensionsLog.error(`${LOG_PREFIX} Single execution failed`, {
						agent: params.agent,
						error: err instanceof Error ? err.message : String(err),
					});
					return {
						content: [{ type: "text", text: `${LOG_PREFIX} Execution failed: ${String(err)}` }],
						details: { mode: "single", results: [] },
					};
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `${LOG_PREFIX} Invalid parameters.\n\nAvailable agents:\n${registry.formatList()}`,
					},
				],
				details: { mode: "single", results: [] },
			};
		},
	};
}
