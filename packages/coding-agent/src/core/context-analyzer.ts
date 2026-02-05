/**
 * Context token analyzer — breaks down where tokens are spent in the context window.
 *
 * Pure functions that analyze the current agent state (system prompt, tools, messages)
 * and return a structured breakdown with per-category token counts and reduction suggestions.
 */

import type { AgentMessage } from "agent";
import type { AssistantMessage, Tool } from "ai";
import { estimateTokens } from "./compaction/compaction.js";

// ============================================================================
// Types
// ============================================================================

export interface ContextBreakdownCategory {
	label: string;
	tokens: number;
	percent: number;
	/** Individual items within this category (e.g., each message) */
	items?: ContextBreakdownItem[];
}

export interface ContextBreakdownItem {
	label: string;
	tokens: number;
	/** Message index in the messages array, if applicable */
	messageIndex?: number;
}

export interface ContextReductionSuggestion {
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	model: string;
	provider: string;
	contextWindow: number;
	categories: ContextBreakdownCategory[];
	totalTokens: number;
	usagePercent: number;
	suggestions: ContextReductionSuggestion[];
}

export interface AnalyzeContextInput {
	systemPrompt: string;
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>;
	messages: AgentMessage[];
	contextWindow: number;
	model: string;
	provider: string;
}

// ============================================================================
// Token estimation helpers
// ============================================================================

/** Estimate tokens for a string using chars/4 heuristic (same as compaction.ts) */
function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Estimate tokens for tool definitions (serialized as JSON) */
function estimateToolTokens(tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>): {
	total: number;
	items: ContextBreakdownItem[];
} {
	let total = 0;
	const items: ContextBreakdownItem[] = [];
	for (const tool of tools) {
		const serialized = JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		});
		const tokens = estimateStringTokens(serialized);
		total += tokens;
		items.push({ label: tool.name, tokens });
	}
	return { total, items };
}

// ============================================================================
// Message categorization
// ============================================================================

interface CategorizedTokens {
	userMessages: { total: number; items: ContextBreakdownItem[] };
	assistantText: { total: number; items: ContextBreakdownItem[] };
	thinking: { total: number; items: ContextBreakdownItem[] };
	toolCalls: { total: number; items: ContextBreakdownItem[] };
	toolResults: { total: number; items: ContextBreakdownItem[] };
	custom: { total: number; items: ContextBreakdownItem[] };
}

function categorizeMessages(messages: AgentMessage[]): CategorizedTokens {
	const result: CategorizedTokens = {
		userMessages: { total: 0, items: [] },
		assistantText: { total: 0, items: [] },
		thinking: { total: 0, items: [] },
		toolCalls: { total: 0, items: [] },
		toolResults: { total: 0, items: [] },
		custom: { total: 0, items: [] },
	};

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		switch (msg.role) {
			case "user": {
				const tokens = estimateTokens(msg);
				result.userMessages.total += tokens;
				const preview = truncatePreview(getUserText(msg), 40);
				result.userMessages.items.push({ label: `msg#${i} ${preview}`, tokens, messageIndex: i });
				break;
			}
			case "assistant": {
				const assistantMsg = msg as AssistantMessage;
				let textTokens = 0;
				let thinkingTokens = 0;
				let toolCallTokens = 0;

				for (const block of assistantMsg.content) {
					if (block.type === "text") {
						textTokens += estimateStringTokens(block.text);
					} else if (block.type === "thinking") {
						thinkingTokens += estimateStringTokens(block.thinking);
					} else if (block.type === "toolCall") {
						toolCallTokens += estimateStringTokens(block.name + JSON.stringify(block.arguments));
					}
				}

				if (textTokens > 0) {
					result.assistantText.total += textTokens;
					const preview = truncatePreview(getAssistantTextPreview(assistantMsg), 40);
					result.assistantText.items.push({ label: `msg#${i} ${preview}`, tokens: textTokens, messageIndex: i });
				}
				if (thinkingTokens > 0) {
					result.thinking.total += thinkingTokens;
					result.thinking.items.push({ label: `msg#${i} thinking`, tokens: thinkingTokens, messageIndex: i });
				}
				if (toolCallTokens > 0) {
					result.toolCalls.total += toolCallTokens;
					result.toolCalls.items.push({ label: `msg#${i} tool calls`, tokens: toolCallTokens, messageIndex: i });
				}
				break;
			}
			case "toolResult": {
				const tokens = estimateTokens(msg);
				result.toolResults.total += tokens;
				result.toolResults.items.push({
					label: `msg#${i} (${msg.toolName})`,
					tokens,
					messageIndex: i,
				});
				break;
			}
			case "bashExecution": {
				if (msg.excludeFromContext) break;
				const tokens = estimateTokens(msg);
				result.custom.total += tokens;
				result.custom.items.push({
					label: `msg#${i} bash: ${truncatePreview(msg.command, 30)}`,
					tokens,
					messageIndex: i,
				});
				break;
			}
			case "custom": {
				const tokens = estimateTokens(msg);
				result.custom.total += tokens;
				result.custom.items.push({
					label: `msg#${i} custom:${msg.customType}`,
					tokens,
					messageIndex: i,
				});
				break;
			}
			case "compactionSummary": {
				const tokens = estimateTokens(msg);
				result.custom.total += tokens;
				result.custom.items.push({
					label: `msg#${i} compaction summary`,
					tokens,
					messageIndex: i,
				});
				break;
			}
			case "branchSummary": {
				const tokens = estimateTokens(msg);
				result.custom.total += tokens;
				result.custom.items.push({
					label: `msg#${i} branch summary`,
					tokens,
					messageIndex: i,
				});
				break;
			}
		}
	}

	return result;
}

// ============================================================================
// Suggestions
// ============================================================================

/** Token threshold above which a single item is flagged (8K tokens) */
const LARGE_ITEM_THRESHOLD = 8192;

/** Top N largest items to surface as suggestions */
const TOP_N_SUGGESTIONS = 5;

function generateSuggestions(
	categorized: CategorizedTokens,
	systemPromptTokens: number,
	toolTokens: { total: number; items: ContextBreakdownItem[] },
): ContextReductionSuggestion[] {
	const suggestions: ContextReductionSuggestion[] = [];

	// Collect all items across categories with their source
	const allItems: Array<{ label: string; tokens: number; source: string }> = [];

	for (const item of categorized.toolResults.items) {
		allItems.push({ label: item.label, tokens: item.tokens, source: "tool result" });
	}
	for (const item of categorized.assistantText.items) {
		allItems.push({ label: item.label, tokens: item.tokens, source: "assistant" });
	}
	for (const item of categorized.custom.items) {
		allItems.push({ label: item.label, tokens: item.tokens, source: "custom" });
	}
	for (const item of categorized.userMessages.items) {
		allItems.push({ label: item.label, tokens: item.tokens, source: "user" });
	}

	// Sort by tokens descending, take top N items above threshold
	allItems.sort((a, b) => b.tokens - a.tokens);
	for (const item of allItems.slice(0, TOP_N_SUGGESTIONS)) {
		if (item.tokens >= LARGE_ITEM_THRESHOLD) {
			suggestions.push({
				label: `${item.source} ${item.label}: ${formatTokenCount(item.tokens)}`,
				tokens: item.tokens,
			});
		}
	}

	// Flag if tool definitions are disproportionately large (>15% of context)
	if (toolTokens.total > 0) {
		const totalEstimate =
			systemPromptTokens +
			toolTokens.total +
			categorized.userMessages.total +
			categorized.assistantText.total +
			categorized.thinking.total +
			categorized.toolCalls.total +
			categorized.toolResults.total +
			categorized.custom.total;
		const toolPercent = (toolTokens.total / totalEstimate) * 100;
		if (toolPercent > 15) {
			suggestions.push({
				label: `Tool definitions use ${toolPercent.toFixed(1)}% of total token usage (${formatTokenCount(toolTokens.total)})`,
				tokens: toolTokens.total,
			});
		}
	}

	// Flag thinking blocks if significant
	if (categorized.thinking.total > LARGE_ITEM_THRESHOLD) {
		suggestions.push({
			label: `${categorized.thinking.items.length} thinking blocks: ${formatTokenCount(categorized.thinking.total)} — lower thinking level to reduce`,
			tokens: categorized.thinking.total,
		});
	}

	return suggestions;
}

// ============================================================================
// Main analysis
// ============================================================================

/**
 * Analyze context token usage and produce a structured breakdown.
 */
export function analyzeContext(input: AnalyzeContextInput): ContextBreakdown {
	const { systemPrompt, tools, messages, contextWindow, model, provider } = input;

	// 1. System prompt
	const systemPromptTokens = estimateStringTokens(systemPrompt);

	// 2. Tool definitions
	const toolTokensResult = estimateToolTokens(tools);

	// 3. Messages
	const categorized = categorizeMessages(messages);

	// 4. Build categories (skip empty ones)
	const categories: ContextBreakdownCategory[] = [];
	const totalTokens =
		systemPromptTokens +
		toolTokensResult.total +
		categorized.userMessages.total +
		categorized.assistantText.total +
		categorized.thinking.total +
		categorized.toolCalls.total +
		categorized.toolResults.total +
		categorized.custom.total;

	const pct = (tokens: number) => (totalTokens > 0 ? (tokens / totalTokens) * 100 : 0);

	categories.push({
		label: "System prompt",
		tokens: systemPromptTokens,
		percent: pct(systemPromptTokens),
	});

	if (toolTokensResult.total > 0) {
		categories.push({
			label: "Tool definitions",
			tokens: toolTokensResult.total,
			percent: pct(toolTokensResult.total),
			items: toolTokensResult.items,
		});
	}

	if (categorized.userMessages.total > 0) {
		categories.push({
			label: "User messages",
			tokens: categorized.userMessages.total,
			percent: pct(categorized.userMessages.total),
			items: categorized.userMessages.items,
		});
	}

	if (categorized.assistantText.total > 0) {
		categories.push({
			label: "Assistant messages",
			tokens: categorized.assistantText.total,
			percent: pct(categorized.assistantText.total),
			items: categorized.assistantText.items,
		});
	}

	if (categorized.thinking.total > 0) {
		categories.push({
			label: "Thinking",
			tokens: categorized.thinking.total,
			percent: pct(categorized.thinking.total),
			items: categorized.thinking.items,
		});
	}

	if (categorized.toolCalls.total > 0) {
		categories.push({
			label: "Tool calls",
			tokens: categorized.toolCalls.total,
			percent: pct(categorized.toolCalls.total),
			items: categorized.toolCalls.items,
		});
	}

	if (categorized.toolResults.total > 0) {
		categories.push({
			label: "Tool results",
			tokens: categorized.toolResults.total,
			percent: pct(categorized.toolResults.total),
			items: categorized.toolResults.items,
		});
	}

	if (categorized.custom.total > 0) {
		categories.push({
			label: "Other",
			tokens: categorized.custom.total,
			percent: pct(categorized.custom.total),
			items: categorized.custom.items,
		});
	}

	// 5. Suggestions
	const suggestions = generateSuggestions(categorized, systemPromptTokens, toolTokensResult);

	// 6. Usage percent
	const usagePercent = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;

	return {
		model,
		provider,
		contextWindow,
		categories,
		totalTokens,
		usagePercent,
		suggestions,
	};
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a ContextBreakdown into a displayable string.
 * Uses box-drawing characters for a clean table look.
 */
export function formatContextBreakdown(breakdown: ContextBreakdown): string {
	const { model, provider, contextWindow, categories, totalTokens, usagePercent, suggestions } = breakdown;

	const lines: string[] = [];

	// Header
	lines.push(`Context Token Usage (${provider}/${model} · ${formatTokenCount(contextWindow)} window)`);
	lines.push("━".repeat(56));

	// Category table
	const catLabel = "Category";
	const catLabelWidth = 22;
	const tokensWidth = 10;
	const pctWidth = 7;

	lines.push(`${padRight(catLabel, catLabelWidth)}  ${padLeft("Tokens", tokensWidth)}  ${padLeft("%", pctWidth)}`);
	lines.push("─".repeat(56));

	for (const cat of categories) {
		lines.push(
			`${padRight(cat.label, catLabelWidth)}  ${padLeft(formatTokenCount(cat.tokens), tokensWidth)}  ${padLeft(`${cat.percent.toFixed(1)}%`, pctWidth)}`,
		);
	}

	lines.push("─".repeat(56));
	lines.push(
		`${padRight("Total", catLabelWidth)}  ${padLeft(formatTokenCount(totalTokens), tokensWidth)}  ${padLeft(`${usagePercent.toFixed(1)}%`, pctWidth)} of ${contextWindow > 0 ? formatTokenCount(contextWindow) : "unknown"}`,
	);

	// Suggestions
	if (suggestions.length > 0) {
		lines.push("");
		lines.push("Reduction opportunities:");
		for (const s of suggestions) {
			lines.push(`  * ${s.label}`);
		}
	}

	return lines.join("\n");
}

// ============================================================================
// Utility helpers
// ============================================================================

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toLocaleString();
}

function padRight(s: string, width: number): string {
	return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function truncatePreview(text: string, maxLen: number): string {
	const clean = text.replace(/\n/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	return `${clean.slice(0, maxLen - 1)}…`;
}

function getUserText(msg: AgentMessage): string {
	if (msg.role !== "user") return "";
	const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c.type === "text" && c.text)
			.map((c) => c.text!)
			.join(" ");
	}
	return "";
}

function getAssistantTextPreview(msg: AssistantMessage): string {
	for (const block of msg.content) {
		if (block.type === "text") return block.text;
	}
	return "(no text)";
}
