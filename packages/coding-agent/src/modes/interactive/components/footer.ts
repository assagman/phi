import type { AssistantMessage } from "ai";
import { type Component, truncateToWidth, visibleWidth } from "tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Sanitize text for display in a single-line status.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Format bytes to human readable (KB, MB, GB)
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
	if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}M`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

/**
 * Render a progress bar with filled/empty blocks
 */
function renderProgressBar(percent: number, width: number): string {
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	return "▓".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
}

// CPU tracking state
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let cpuPercent = 0;

/**
 * Get CPU usage percentage since last call
 */
function getCpuPercent(): number {
	const now = Date.now();
	const elapsed = now - lastCpuTime;
	if (elapsed < 100) return cpuPercent;

	const currentUsage = process.cpuUsage(lastCpuUsage);
	const totalCpuMs = (currentUsage.user + currentUsage.system) / 1000;
	cpuPercent = (totalCpuMs / elapsed) * 100;

	lastCpuUsage = process.cpuUsage();
	lastCpuTime = now;

	return cpuPercent;
}

/**
 * Footer component with 2-row layout:
 * Row 1: [path (branch)]                 [↑in ↓out] [Rread Wwrite] [$cost] [▓▓░░░░░░] [ctx/max %]
 * Row 2: [PID:xxxx] [RSS:xxxM] [CPU:x.x%]                              [provider:model:thinking]
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {}
	dispose(): void {}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Get last assistant message for context calculation
		const lastAssistantMessage = state.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;
		const contextWindow = state.model?.contextWindow || 0;
		const contextPercentValue = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		// ===== ROW 1: Path + Stats =====
		// Left: [pwd (branch)]
		let pwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Right: bracketed stats with colors
		const statsParts: string[] = [];

		// Token I/O - accent color
		if (totalInput || totalOutput) {
			statsParts.push(theme.fg("accent", `[↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}]`));
		}

		// Cache R/W - magenta
		if (totalCacheRead || totalCacheWrite) {
			statsParts.push(theme.fg("muted", `[R${formatTokens(totalCacheRead)} W${formatTokens(totalCacheWrite)}]`));
		}

		// Cost - yellow/green based on subscription
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription) {
			const costText = `[$${totalCost.toFixed(2)}${usingSubscription ? " sub" : ""}]`;
			statsParts.push(usingSubscription ? theme.fg("success", costText) : theme.fg("warning", costText));
		}

		// Progress bar - color based on context usage
		const barWidth = 10;
		const bar = renderProgressBar(contextPercentValue, barWidth);
		let coloredBar: string;
		if (contextPercentValue > 70) {
			coloredBar = theme.fg("error", `[${bar}]`);
		} else if (contextPercentValue >= 50) {
			coloredBar = theme.fg("warning", `[${bar}]`);
		} else {
			coloredBar = theme.fg("success", `[${bar}]`);
		}
		statsParts.push(coloredBar);

		// Context info - same color as progress bar
		const autoIndicator = this.autoCompactEnabled ? "" : " manual";
		const contextText = `${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${contextPercentValue.toFixed(1)}%${autoIndicator})`;
		let coloredContext: string;
		if (contextPercentValue > 70) {
			coloredContext = theme.fg("error", `[${contextText}]`);
		} else if (contextPercentValue >= 50) {
			coloredContext = theme.fg("warning", `[${contextText}]`);
		} else {
			coloredContext = theme.fg("dim", `[${contextText}]`);
		}
		statsParts.push(coloredContext);

		const statsRight = statsParts.join(" ");
		const statsRightWidth = visibleWidth(statsRight);

		// Calculate space for path
		const pathMaxWidth = width - statsRightWidth - 2;
		let pathDisplay = pwd;
		if (visibleWidth(pwd) > pathMaxWidth && pathMaxWidth > 10) {
			pathDisplay = truncateToWidth(pwd, pathMaxWidth - 2, "…");
		} else if (pathMaxWidth <= 10) {
			pathDisplay = "";
		}
		const bracketedPath = pathDisplay ? theme.fg("dim", `[${pathDisplay}]`) : "";

		const pathWidth = visibleWidth(bracketedPath);
		const padding1 = Math.max(0, width - pathWidth - statsRightWidth);
		const row1 = bracketedPath + " ".repeat(padding1) + statsRight;

		// ===== ROW 2: Process stats + Model =====
		// Left: [PID:xxxx] [RSS:xxxM] [CPU:x.x%]
		const pidPart = theme.fg("dim", `[PID:${process.pid}]`);
		const rssPart = theme.fg("dim", `[RSS:${formatBytes(process.memoryUsage().rss)}]`);
		const cpuPart = theme.fg("dim", `[CPU:${getCpuPercent().toFixed(1)}%]`);
		const processStats = `${pidPart} ${rssPart} ${cpuPart}`;

		// Right: [provider:model:thinkingLevel]
		const provider = state.model?.provider || "unknown";
		const modelName = state.model?.id || "no-model";
		let modelDisplay = `${provider}:${modelName}`;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			modelDisplay = `${provider}:${modelName}:${thinkingLevel}`;
		}
		const bracketedModel = theme.fg("accent", `[${modelDisplay}]`);

		const processWidth = visibleWidth(processStats);
		const modelWidth = visibleWidth(bracketedModel);

		// Truncate model if needed
		let finalModel = bracketedModel;
		if (processWidth + 2 + modelWidth > width) {
			const available = width - processWidth - 4; // -4 for brackets and spacing
			if (available > 10) {
				const truncated = truncateToWidth(modelDisplay, available, "…");
				finalModel = theme.fg("accent", `[${truncated}]`);
			} else {
				finalModel = "";
			}
		}

		const finalPadding = Math.max(0, width - processWidth - visibleWidth(finalModel));
		const row2 = processStats + " ".repeat(finalPadding) + finalModel;

		const lines = [row1, row2];

		// Add extension statuses on a third line if present
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => `[${sanitizeStatusText(text)}]`);
			const statusLine = theme.fg("dim", sortedStatuses.join(" "));
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
		}

		return lines;
	}
}
