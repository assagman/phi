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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "agent";
import * as agentsPkg from "agents";
import type { Message, Model } from "ai";
import type { Component, OverlayOptions, TUI } from "tui";
import { BorderedLoader } from "../../../modes/interactive/components/bordered-loader.js";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import { extensionsLog } from "../../../utils/logger.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

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

export interface SubagentChainStep extends SubagentTask {
	/** Support {previous} placeholder for chaining */
	usesPrevious?: boolean;
}

interface ExecutionResult {
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

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: ExecutionResult[];
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
	const entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });

	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const name = entry.name;
		if (typeof name !== "string" || !name.endsWith(".md")) continue;

		const filePath = join(dir, name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) continue;

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
			temperature: frontmatter.temperature ? parseFloat(frontmatter.temperature) : undefined,
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

// ─── Agent Registry ─────────────────────────────────────────────────────────

export interface AgentRegistry {
	agents: AgentDefinition[];
	get(name: string): AgentDefinition | undefined;
	list(): AgentDefinition[];
	formatList(): string;
}

export function createAgentRegistry(cwd: string, scope: "preset" | "user" | "project" | "all" = "all"): AgentRegistry {
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

	return {
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
}

// ─── Subagent Execution ─────────────────────────────────────────────────────

function getApiKeyEnvVar(provider: string): string {
	const envVars: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		google: "GOOGLE_API_KEY",
		"google-vertex": "GOOGLE_VERTEX_API_KEY",
		"google-gemini-cli": "GOOGLE_API_KEY",
		"amazon-bedrock": "AWS_ACCESS_KEY_ID",
		xai: "XAI_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		mistral: "MISTRAL_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};
	return envVars[provider] || `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

function createTempPromptFile(agentName: string, prompt: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "phi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const path = join(dir, `prompt-${safeName}.md`);
	writeFileSync(path, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, path };
}

async function runSubagent(
	agent: AgentDefinition,
	task: string,
	model: Model<any>,
	apiKey: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((result: ExecutionResult) => void) | undefined,
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
		model: agent.model || model.id,
		step,
	};

	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	// Use agent's preferred model if specified, otherwise use current model
	if (agent.model) {
		args.push("--model", agent.model);
	} else {
		args.push("--model", `${model.provider}/${model.id}`);
	}

	// Use agent's preferred tools if specified
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let wasAborted = false;

	try {
		// Build system prompt
		let systemPrompt = agent.systemPrompt;

		// For presets, inject tool usage and epsilon instructions
		if (agent.source === "preset") {
			const presetInfo = PRESET_MAP[agent.name];
			if (presetInfo) {
				const preset = agentsPkg.createPreset(presetInfo.template, model, {
					injectToolUsage: true,
					injectEpsilon: true,
				});
				systemPrompt = preset.systemPrompt;
			}
		}

		if (systemPrompt.trim()) {
			const tmp = createTempPromptFile(agent.name, systemPrompt);
			tmpDir = tmp.dir;
			tmpPromptPath = tmp.path;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		const env = {
			...process.env,
			[getApiKeyEnvVar(model.provider)]: apiKey,
		} as Record<string, string>;

		return new Promise((resolve, reject) => {
			const proc = spawn("phi", args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				const evt = event as { type?: string; message?: Message };
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
					onUpdate?.(result);
				}

				if (evt.type === "tool_result_end" && evt.message) {
					result.messages.push(evt.message);
					onUpdate?.(result);
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

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				result.exitCode = code ?? 1;
				if (wasAborted) {
					reject(new Error("Aborted"));
				} else {
					resolve(result);
				}
			});

			proc.on("error", (err: Error) => {
				result.exitCode = 1;
				result.errorMessage = err.message;
				reject(err);
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
	} finally {
		if (tmpPromptPath) {
			try {
				rmSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
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
});

export interface SubagentUIContext {
	hasUI: boolean;
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: unknown,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
		},
	): Promise<T>;
}

export interface SubagentToolContext {
	getModel(): Model<any> | undefined;
	getApiKey(model: Model<any>): Promise<string>;
	getWorkingDir(): string;
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

// ─── Tool Factory ───────────────────────────────────────────────────────────

export function createSubagentTool(
	context: SubagentToolContext,
	ui: SubagentUIContext,
): AgentTool<typeof SubagentParams> {
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
				parallel?: Array<{ agent: string; task: string; cwd?: string }>;
				chain?: Array<{ agent: string; task: string; cwd?: string }>;
				cwd?: string;
				scope?: string;
			},
			signal?: AbortSignal,
			onUpdate?: (result: AgentToolResult<SubagentDetails>) => void,
		): Promise<AgentToolResult<SubagentDetails>> {
			const scope = (params.scope || "all") as "preset" | "user" | "project" | "all";
			const registry = createAgentRegistry(context.getWorkingDir(), scope);
			const model = context.getModel();

			if (!model) {
				return {
					content: [{ type: "text", text: "Error: No model selected" }],
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
							text: `Provide exactly one mode.\n\nAvailable agents:\n${registry.formatList()}`,
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
							content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
							details: { mode: "chain", results },
						};
					}

					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate = onUpdate
						? (current: ExecutionResult) => {
								const allResults = [...results, current];
								onUpdate({
									content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
									details: { mode: "chain", results: allResults },
								});
							}
						: undefined;

					try {
						const apiKey = await context.getApiKey(model);
						const result = await runSubagent(
							agent,
							taskWithContext,
							model,
							apiKey,
							step.cwd || context.getWorkingDir(),
							signal,
							chainUpdate,
							i + 1,
						);
						results.push(result);

						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						if (isError) {
							const errorMsg =
								result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
							return {
								content: [
									{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
								],
								details: { mode: "chain", results },
							};
						}

						previousOutput = getFinalOutput(result.messages);
					} catch (err) {
						return {
							content: [{ type: "text", text: `Chain failed at step ${i + 1}: ${String(err)}` }],
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
				if (params.parallel.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Max ${MAX_PARALLEL_TASKS} parallel tasks` }],
						details: { mode: "parallel", results: [] },
					};
				}

				// Validate all agents first
				for (const t of params.parallel) {
					if (!registry.get(t.agent)) {
						return {
							content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
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
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: { mode: "parallel", results: allResults.filter(Boolean) },
						});
					}
				};

				const apiKey = await context.getApiKey(model);

				const results = await mapWithConcurrencyLimit(params.parallel, MAX_CONCURRENCY, async (t, index) => {
					const agent = registry.get(t.agent)!;
					const result = await runSubagent(
						agent,
						t.task,
						model,
						apiKey,
						t.cwd || context.getWorkingDir(),
						signal,
						(current) => {
							allResults[index] = current;
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
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
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
						content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
						details: { mode: "single", results: [] },
					};
				}

				// UI wrapper for single mode
				if (ui.hasUI) {
					const result = await ui.custom<ExecutionResult>(
						(tui, theme, _kb, done) => {
							const loader = new BorderedLoader(tui, theme, `Running ${agent.name}...`);
							loader.onAbort = () => done({} as ExecutionResult);

							const run = async () => {
								const apiKey = await context.getApiKey(model);
								return runSubagent(
									agent!,
									params.task!,
									model,
									apiKey,
									params.cwd || context.getWorkingDir(),
									loader.signal,
									(current) => {
										onUpdate?.({
											content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
											details: { mode: "single", results: [current] },
										});
									},
								);
							};

							run()
								.then(done)
								.catch((err: unknown) => {
									extensionsLog.error("Subagent execution failed", {
										error: err instanceof Error ? err.message : String(err),
									});
									done({} as ExecutionResult);
								});

							return loader;
						},
						{
							overlay: true,
							overlayOptions: {
								anchor: "center",
								width: 60,
								minWidth: 40,
								maxHeight: 10,
								margin: 2,
							},
						},
					);

					return {
						content: [
							{
								type: "text",
								text: getFinalOutput(result.messages) || "(no output)",
							},
						],
						details: { mode: "single", results: [result] },
					};
				}

				// No UI - direct execution
				const apiKey = await context.getApiKey(model);
				const result = await runSubagent(
					agent,
					params.task,
					model,
					apiKey,
					params.cwd || context.getWorkingDir(),
					signal,
					onUpdate
						? (current) =>
								onUpdate({
									content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
									details: { mode: "single", results: [current] },
								})
						: undefined,
				);

				return {
					content: [
						{
							type: "text",
							text: getFinalOutput(result.messages) || "(no output)",
						},
					],
					details: { mode: "single", results: [result] },
				};
			}

			return {
				content: [{ type: "text", text: `Invalid parameters.\n\nAvailable agents:\n${registry.formatList()}` }],
				details: { mode: "single", results: [] },
			};
		},
	};
}
