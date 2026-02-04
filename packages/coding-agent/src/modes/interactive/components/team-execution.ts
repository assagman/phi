/**
 * Team execution progress component for inline chat display.
 * Shows hierarchical tree of agents with epsilon task progress.
 *
 * Supports two modes:
 * 1. Direct team execution (via /team command) - shows single team's agents
 * 2. Team review tool - shows lead analyzer phase, then multiple teams
 *
 * Displays atomic, detailed events as they happen:
 * - Lead analyzer: tool calls (read, bash, analyze_*), epsilon tasks
 * - Team execution: agent progress, findings, merge phases
 */

import * as path from "node:path";
import type { AgentTaskInfo, TeamEvent } from "agents";
import { Container, Text, type TUI } from "tui";
import type { CoopPhase, LeadTaskEvent, LeadToolEvent } from "../../../core/tools/index.js";
import { theme } from "../theme/theme.js";

const PULSE_PERIOD_MS = 1500;

// Agent status icons
const STATUS_ICONS = {
	pending: "○", // Waiting
	running: "◐", // In progress (animated)
	success: "✓", // Completed successfully
	error: "✗", // Failed
};

// Tree characters
const TREE = {
	branch: "├──",
	last: "└──",
	pipe: "│  ",
	space: "   ",
};

// Progress bar characters
const PROGRESS = {
	filled: "█",
	empty: "░",
	width: 10,
};

// RGB for pulse animation
const PULSE_RGB: [number, number, number] = [95, 135, 255]; // accent blue

// Maximum number of activity items to show
const MAX_ACTIVITY_ITEMS = 8;
const MAX_COMPLETED_ITEMS = 5;

/** Activity log entry for detailed display */
interface ActivityEntry {
	id: string;
	type: "tool" | "task" | "memory" | "analysis";
	status: "active" | "done" | "error";
	icon: string;
	label: string;
	detail?: string;
	startTime: number;
	endTime?: number;
}

interface AgentStatus {
	name: string;
	status: "pending" | "running" | "success" | "error";
	error?: string;
	findingCount?: number;
	taskInfo: AgentTaskInfo;
}

interface MergeStatus {
	phase: "idle" | "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing" | "done";
	findingCount: number;
	verifiedCount: number;
}

/**
 * Displays team execution progress inline in chat.
 * Shows tree hierarchy with epsilon task progress per agent.
 */
export class TeamExecutionComponent extends Container {
	private text: Text;
	private teamName: string;
	private agents: Map<string, AgentStatus> = new Map();
	private mergeStatus: MergeStatus = { phase: "idle", findingCount: 0, verifiedCount: 0 };
	private running = true;
	private startTime = Date.now();
	private pulseTimer?: ReturnType<typeof setInterval>;
	private ui?: TUI;
	private onInvalidate?: () => void;

	// Team review tool specific state
	private reviewPhase: CoopPhase | undefined;
	private selectedTeams: string[] = [];
	private leadReasoning: string | undefined;
	private leadError: string | undefined;

	// Lead analyzer task tracking (driven by epsilon)
	private leadTasks: Map<number, { title: string; status: string }> = new Map();

	// Detailed activity log for atomic event display
	private activityLog: ActivityEntry[] = [];

	// Lead analyzer tool activity tracking
	private leadToolsActive: Map<string, LeadToolEvent> = new Map(); // toolCallId -> event
	private leadToolsCompleted: Array<{
		toolName?: string;
		path?: string;
		command?: string;
		lineCount?: number;
		isError?: boolean;
	}> = [];

	// Statistics counters
	private leadFilesScanned = 0;
	private leadSearchesRun = 0;
	private leadMemoryOps = 0;
	private leadAnalysisOps = 0;

	constructor(teamName: string, agentNames: string[], ui?: TUI, onInvalidate?: () => void) {
		super();
		this.teamName = teamName;
		this.ui = ui;
		this.onInvalidate = onInvalidate;
		this.text = new Text("", 1, 0);
		this.addChild(this.text);

		// Initialize all agents as pending with empty task info
		for (const name of agentNames) {
			this.agents.set(name, {
				name,
				status: "pending",
				taskInfo: { total: 0, completed: 0 },
			});
		}

		this.update();
		this.startPulse();
	}

	/**
	 * Process a team event and update display
	 */
	handleEvent(event: TeamEvent): void {
		switch (event.type) {
			case "agent_start": {
				const agent = this.agents.get(event.agentName);
				if (agent) {
					agent.status = "running";
				}
				break;
			}

			case "agent_task_update": {
				const agent = this.agents.get(event.agentName);
				if (agent) {
					agent.taskInfo = event.taskInfo;
				}
				break;
			}

			case "agent_end": {
				const agent = this.agents.get(event.agentName);
				if (agent) {
					agent.status = event.result.success ? "success" : "error";
					agent.error = event.result.error;
					agent.findingCount = event.result.findings.length;
					// Ensure progress bar shows 100% on completion
					if (agent.status === "success" && agent.taskInfo.total > 0) {
						agent.taskInfo.completed = agent.taskInfo.total;
					}
				}
				break;
			}

			case "agent_error": {
				const agent = this.agents.get(event.agentName);
				if (agent && !event.willRetry) {
					agent.status = "error";
					agent.error = event.error;
				}
				break;
			}

			case "merge_start":
				this.mergeStatus.phase = "parsing";
				this.mergeStatus.findingCount = event.findingCount;
				break;

			case "merge_progress":
				this.mergeStatus.phase = event.phase;
				break;

			case "merge_end":
				this.mergeStatus.phase = "done";
				this.mergeStatus.verifiedCount = event.verifiedCount;
				break;

			case "team_end":
				this.running = false;
				this.stopPulse();
				break;
		}

		this.update();
	}

	/**
	 * Set agent names (for when component is created before agents are known)
	 */
	setAgentNames(names: string[]): void {
		// Only set if we don't have agents yet
		if (this.agents.size === 0) {
			for (const name of names) {
				this.agents.set(name, {
					name,
					status: "pending",
					taskInfo: { total: 0, completed: 0 },
				});
			}
			this.update();
		}
	}

	/**
	 * Mark execution as complete
	 */
	complete(): void {
		this.running = false;
		this.stopPulse();
		this.update();
	}

	/**
	 * Set completion state with optional error flag
	 */
	setComplete(isError: boolean): void {
		this.running = false;
		this.reviewPhase = "complete";
		this.stopPulse();
		// Mark any still-running agents as errored if isError
		if (isError) {
			for (const agent of this.agents.values()) {
				if (agent.status === "running" || agent.status === "pending") {
					agent.status = "error";
				}
			}
		}
		this.update();
	}

	/**
	 * Update review phase (for team review tool multi-phase execution)
	 */
	setReviewPhase(
		phase: CoopPhase,
		options?: {
			selectedTeams?: string[];
			reasoning?: string;
			errorMessage?: string;
		},
	): void {
		this.reviewPhase = phase;
		if (options?.selectedTeams) {
			this.selectedTeams = options.selectedTeams;
		}
		if (options?.reasoning) {
			this.leadReasoning = options.reasoning;
		}
		if (options?.errorMessage) {
			this.leadError = options.errorMessage;
		}
		if (phase === "lead_failed" || phase === "complete") {
			this.running = false;
			this.stopPulse();
		}
		this.update();
	}

	/**
	 * Handle lead analyzer epsilon task event for progress display
	 */
	handleLeadTaskEvent(event: LeadTaskEvent): void {
		switch (event.type) {
			case "create":
				this.leadTasks.set(event.taskId, {
					title: event.title ?? `Task #${event.taskId}`,
					status: event.status ?? "todo",
				});
				break;
			case "update": {
				const existing = this.leadTasks.get(event.taskId);
				if (existing) {
					if (event.title) existing.title = event.title;
					if (event.status) existing.status = event.status;
				}
				break;
			}
			case "delete":
				this.leadTasks.delete(event.taskId);
				break;
		}
		this.update();
	}

	/**
	 * Handle lead analyzer tool activity event for progress display
	 */
	handleLeadToolEvent(event: LeadToolEvent): void {
		if (event.type === "start") {
			this.leadToolsActive.set(event.toolCallId, event);

			// Add to activity log
			const { icon, label, detail } = this.formatToolForActivity(event);
			this.addActivity({
				id: event.toolCallId,
				type: this.getToolActivityType(event.toolName),
				status: "active",
				icon,
				label,
				detail,
				startTime: Date.now(),
			});
		} else {
			// End event
			this.leadToolsActive.delete(event.toolCallId);

			// Update activity log entry
			this.updateActivityStatus(event.toolCallId, event.isError ? "error" : "done", Date.now());

			// Track completed tools for display
			const record: (typeof this.leadToolsCompleted)[0] = {
				toolName: event.toolName,
				isError: event.isError,
			};

			if (event.path) {
				record.path = event.path;
				this.leadFilesScanned++;
			}
			if (event.command) {
				record.command = event.command;
				// Count rg/fd commands as searches
				if (event.command.includes("rg ") || event.command.includes("fd ")) {
					this.leadSearchesRun++;
				}
			}
			if (event.lineCount) {
				record.lineCount = event.lineCount;
			}

			// Update statistics
			if (event.toolName.startsWith("delta_")) {
				this.leadMemoryOps++;
			} else if (event.toolName.startsWith("analyze_")) {
				this.leadAnalysisOps++;
			}

			// Keep last N completed tools for display
			this.leadToolsCompleted.push(record);
			if (this.leadToolsCompleted.length > MAX_COMPLETED_ITEMS) {
				this.leadToolsCompleted.shift();
			}
		}
		this.update();
	}

	/**
	 * Add an entry to the activity log
	 */
	private addActivity(entry: ActivityEntry): void {
		this.activityLog.push(entry);
		// Trim old completed entries if too many
		const activeCount = this.activityLog.filter((e) => e.status === "active").length;
		const completedCount = this.activityLog.length - activeCount;
		if (completedCount > MAX_ACTIVITY_ITEMS) {
			// Remove oldest completed entries
			const toRemove = completedCount - MAX_ACTIVITY_ITEMS;
			let removed = 0;
			this.activityLog = this.activityLog.filter((e) => {
				if (e.status !== "active" && removed < toRemove) {
					removed++;
					return false;
				}
				return true;
			});
		}
	}

	/**
	 * Update an activity entry's status
	 */
	private updateActivityStatus(id: string, status: "done" | "error", endTime: number): void {
		const entry = this.activityLog.find((e) => e.id === id);
		if (entry) {
			entry.status = status;
			entry.endTime = endTime;
		}
	}

	/**
	 * Get activity type from tool name
	 */
	private getToolActivityType(toolName: string): ActivityEntry["type"] {
		if (toolName.startsWith("delta_")) return "memory";
		if (toolName.startsWith("analyze_")) return "analysis";
		return "tool";
	}

	/**
	 * Format a tool event for activity display
	 */
	private formatToolForActivity(event: LeadToolEvent): { icon: string; label: string; detail?: string } {
		const toolName = event.toolName.toLowerCase();

		// Read tool
		if (toolName === "read" && event.path) {
			return {
				icon: "\uf02d", // nf-fa-book
				label: "Read",
				detail: this.shortenPath(event.path),
			};
		}

		// Bash/search tools
		if (toolName === "bash" && event.command) {
			if (event.pattern && event.command.includes("rg ")) {
				return {
					icon: "\uf002", // nf-fa-search
					label: "Search",
					detail: `"${event.pattern}" in ${this.shortenPath(event.directory || ".")}`,
				};
			}
			if (event.pattern && event.command.includes("fd ")) {
				return {
					icon: "\uf07c", // nf-fa-folder_open
					label: "Find",
					detail: `"${event.pattern}"`,
				};
			}
			return {
				icon: "\uf120", // nf-fa-terminal
				label: "Bash",
				detail: this.truncate(event.command, 40),
			};
		}

		// Project analysis tools
		if (toolName.startsWith("analyze_")) {
			const type = toolName.replace("analyze_", "").replace(/_/g, " ");
			return {
				icon: "\uf085", // nf-fa-cogs
				label: "Analyze",
				detail: type,
			};
		}

		// Delta memory tools
		if (toolName.startsWith("delta_")) {
			const op = toolName.replace("delta_", "");
			return {
				icon: "\uf1c0", // nf-fa-database
				label: "Memory",
				detail: op,
			};
		}

		// Default
		return {
			icon: "\uf013", // nf-fa-gear
			label: event.toolName,
		};
	}

	private startPulse(): void {
		if (this.pulseTimer) return;
		this.pulseTimer = setInterval(() => {
			if (this.running) {
				this.update();
				this.ui?.requestRender();
				this.onInvalidate?.();
			}
		}, 16);
	}

	private stopPulse(): void {
		if (this.pulseTimer) {
			clearInterval(this.pulseTimer);
			this.pulseTimer = undefined;
		}
	}

	private pulseColor(): string {
		const elapsed = Date.now() - this.startTime;
		const phase = (elapsed % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
		const brightness = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(phase * 2 * Math.PI));
		const [r, g, b] = PULSE_RGB;
		return `\x1b[38;2;${Math.round(r * brightness)};${Math.round(g * brightness)};${Math.round(b * brightness)}m`;
	}

	private pulsed(text: string): string {
		return `${this.pulseColor()}${text}\x1b[0m`;
	}

	private update(): void {
		const lines: string[] = [];

		// Header with team name
		const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
		const statusText = this.getStatusText();
		lines.push(
			`${theme.fg("accent", `⚑ Team: ${this.teamName}`)} ${theme.fg("muted", `(${elapsed}s)`)} ${statusText}`,
		);
		lines.push("");

		// If in lead analyzer phase (team review tool), show detailed atomic events
		if (this.reviewPhase === "lead_analyzing") {
			lines.push(
				`${this.pulsed("◐")} ${theme.fg("accent", "Lead Analyzer")} ${theme.fg("muted", "Analyzing project...")}`,
			);
			lines.push("");

			// Statistics bar
			const stats = this.buildStatsLine();
			if (stats) {
				lines.push(stats);
				lines.push("");
			}

			// Activity section header
			const activeCount = this.activityLog.filter((e) => e.status === "active").length;
			const doneCount = this.activityLog.filter((e) => e.status === "done").length;
			const hasActivity = this.activityLog.length > 0 || this.leadToolsActive.size > 0;

			if (!hasActivity && this.leadTasks.size === 0) {
				lines.push(theme.fg("muted", "  Initializing..."));
			} else {
				// Show activity header with counts
				if (activeCount > 0 || doneCount > 0) {
					const countText = activeCount > 0 ? `${activeCount} active` : "";
					const doneText = doneCount > 0 ? `${doneCount} done` : "";
					const separator = countText && doneText ? " • " : "";
					lines.push(theme.fg("muted", `Activity: ${countText}${separator}${doneText}`));
				}

				// Render active activities first (with pulsing indicator)
				const activeEntries = this.activityLog.filter((e) => e.status === "active");
				const doneEntries = this.activityLog.filter((e) => e.status !== "active").slice(-MAX_COMPLETED_ITEMS);

				for (let i = 0; i < activeEntries.length; i++) {
					const entry = activeEntries[i];
					const isLast = i === activeEntries.length - 1 && doneEntries.length === 0;
					const branch = isLast ? TREE.last : TREE.branch;
					const elapsedMs = Date.now() - entry.startTime;
					const elapsedText = elapsedMs > 1000 ? ` ${(elapsedMs / 1000).toFixed(1)}s` : "";

					const line = `  ${branch} ${this.pulsed("◐")} ${theme.fg("accent", entry.label)}${entry.detail ? ` ${theme.fg("muted", entry.detail)}` : ""}${theme.fg("muted", elapsedText)}`;
					lines.push(line);
				}

				// Render completed activities
				for (let i = 0; i < doneEntries.length; i++) {
					const entry = doneEntries[i];
					const isLast = i === doneEntries.length - 1 && this.leadTasks.size === 0;
					const branch = isLast ? TREE.last : TREE.branch;
					const icon = entry.status === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const durationMs = entry.endTime ? entry.endTime - entry.startTime : 0;
					const durationText = durationMs > 500 ? ` ${(durationMs / 1000).toFixed(1)}s` : "";

					const labelColor = entry.status === "error" ? "error" : "muted";
					const line = `  ${branch} ${icon} ${theme.fg(labelColor, entry.label)}${entry.detail ? ` ${theme.fg("muted", entry.detail)}` : ""}${theme.fg("muted", durationText)}`;
					lines.push(line);
				}

				// Show epsilon tasks if any
				if (this.leadTasks.size > 0) {
					lines.push("");
					const tasks = Array.from(this.leadTasks.entries());
					const tasksDone = tasks.filter(([, t]) => t.status === "done").length;
					const tasksTotal = tasks.length;

					lines.push(theme.fg("muted", `Tasks: ${tasksDone}/${tasksTotal}`));

					// Show only active or recent tasks (up to 5)
					const activeTasks = tasks.filter(([, t]) => t.status === "in_progress");
					const otherTasks = tasks.filter(([, t]) => t.status !== "in_progress").slice(-3);
					const visibleTasks = [...activeTasks, ...otherTasks].slice(0, 5);

					for (let i = 0; i < visibleTasks.length; i++) {
						const [, task] = visibleTasks[i];
						const isLast = i === visibleTasks.length - 1;
						const branch = isLast ? TREE.last : TREE.branch;
						const icon = this.formatTaskStatusIcon(task.status);
						const title = this.truncate(task.title, 50);
						lines.push(`  ${branch} ${icon} ${title}`);
					}

					// Show count of hidden tasks if any
					if (tasks.length > 5) {
						lines.push(theme.fg("muted", `  ${TREE.space}... and ${tasks.length - 5} more tasks`));
					}
				}
			}

			this.text.setText(lines.join("\n"));
			return;
		}

		// If lead analyzer failed, show error
		if (this.reviewPhase === "lead_failed") {
			lines.push(`${theme.fg("error", "✗")} Lead analyzer failed`);
			if (this.leadError) {
				lines.push("");
				lines.push(theme.fg("error", `  ${this.truncate(this.leadError, 60)}`));
			}
			this.text.setText(lines.join("\n"));
			return;
		}

		// If lead analyzer completed, show selected teams (before agents show up)
		if (this.reviewPhase === "lead_complete" && this.selectedTeams.length > 0 && this.agents.size === 0) {
			lines.push(`${theme.fg("success", "✓")} Teams selected: ${this.selectedTeams.join(", ")}`);
			if (this.leadReasoning) {
				lines.push("");
				lines.push(theme.fg("muted", `  ${this.truncate(this.leadReasoning, 80)}`));
			}
			lines.push("");
			lines.push(`${this.pulsed("◐")} ${theme.fg("muted", "Starting team execution...")}`);
			this.text.setText(lines.join("\n"));
			return;
		}

		// Show selected teams header if we have them (team review tool mode)
		if (this.selectedTeams.length > 0) {
			lines.push(theme.fg("muted", `Teams: ${this.selectedTeams.join(", ")}`));
			lines.push("");
		}

		// Agent tree with progress
		if (this.agents.size > 0) {
			lines.push(theme.fg("muted", "Agents:"));
			const agentList = Array.from(this.agents.values());
			for (let i = 0; i < agentList.length; i++) {
				const agent = agentList[i];
				const isLast = i === agentList.length - 1;
				const treeBranch = isLast ? TREE.last : TREE.branch;
				const agentLine = this.formatAgentLine(agent, treeBranch);
				lines.push(agentLine);
			}
		} else if (!this.reviewPhase) {
			// Direct team execution mode with no agents yet
			lines.push(theme.fg("muted", "Agents:"));
			lines.push(theme.fg("muted", "  (loading...)"));
		}

		// Team progress summary
		const { totalTasks, completedTasks } = this.getTeamProgress();
		if (totalTasks > 0) {
			lines.push("");
			const progressBar = this.renderProgressBar(completedTasks, totalTasks, 20);
			const percent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
			lines.push(
				`${theme.fg("muted", "Progress:")} ${progressBar} ${completedTasks}/${totalTasks} tasks (${percent}%)`,
			);
		}

		// Merge status (only show during/after merge phase)
		if (this.mergeStatus.phase !== "idle") {
			lines.push("");
			lines.push(theme.fg("muted", "Merge:"));
			const phaseText = this.formatMergePhase();
			lines.push(`  ${phaseText}`);
		}

		this.text.setText(lines.join("\n"));
	}

	private getStatusText(): string {
		if (this.reviewPhase === "lead_failed") {
			return theme.fg("error", "failed");
		}
		if (!this.running) {
			return theme.fg("success", "complete");
		}
		return this.pulsed("running");
	}

	private formatAgentLine(agent: AgentStatus, treeBranch: string): string {
		const icon = this.formatStatusIcon(agent.status);
		const name = agent.name;

		// Progress bar for this agent
		const { total, completed, activeTaskTitle } = agent.taskInfo;
		const progressBar = this.renderProgressBar(completed, total, PROGRESS.width);

		// Task count
		const taskCount = total > 0 ? `${completed}/${total}` : "0/0";

		// Active task or status text
		let statusText = "";
		if (agent.status === "pending") {
			statusText = theme.fg("muted", "(pending)");
		} else if (agent.status === "error" && agent.error) {
			statusText = theme.fg("error", `Error: ${this.truncate(agent.error, 30)}`);
		} else if (agent.status === "success") {
			const findings = agent.findingCount !== undefined ? ` (${agent.findingCount} findings)` : "";
			statusText = theme.fg("success", `Complete${findings}`);
		} else if (activeTaskTitle) {
			statusText = theme.fg("muted", this.truncate(activeTaskTitle, 40));
		} else if (agent.status === "running") {
			statusText = this.pulsed("working...");
		}

		// Build the line
		const namePadded = name.padEnd(24);
		return `${treeBranch} ${icon} ${namePadded} ${progressBar} ${taskCount.padStart(5)}  ${statusText}`;
	}

	private renderProgressBar(completed: number, total: number, width: number): string {
		if (total === 0) {
			return theme.fg("muted", PROGRESS.empty.repeat(width));
		}

		const filledCount = Math.round((completed / total) * width);
		const emptyCount = width - filledCount;

		const filled = theme.fg("success", PROGRESS.filled.repeat(filledCount));
		const empty = theme.fg("muted", PROGRESS.empty.repeat(emptyCount));

		return filled + empty;
	}

	private getTeamProgress(): { totalTasks: number; completedTasks: number } {
		let totalTasks = 0;
		let completedTasks = 0;

		for (const agent of this.agents.values()) {
			totalTasks += agent.taskInfo.total;
			completedTasks += agent.taskInfo.completed;
		}

		return { totalTasks, completedTasks };
	}

	private formatStatusIcon(status: AgentStatus["status"]): string {
		switch (status) {
			case "pending":
				return theme.fg("muted", STATUS_ICONS.pending);
			case "running":
				return this.pulsed(STATUS_ICONS.running);
			case "success":
				return theme.fg("success", STATUS_ICONS.success);
			case "error":
				return theme.fg("error", STATUS_ICONS.error);
		}
	}

	private formatTaskStatusIcon(status: string): string {
		switch (status) {
			case "todo":
				return theme.fg("muted", STATUS_ICONS.pending);
			case "in_progress":
				return this.pulsed(STATUS_ICONS.running);
			case "done":
				return theme.fg("success", STATUS_ICONS.success);
			case "blocked":
			case "cancelled":
				return theme.fg("error", STATUS_ICONS.error);
			default:
				return theme.fg("muted", STATUS_ICONS.pending);
		}
	}

	private formatMergePhase(): string {
		const { phase, findingCount, verifiedCount } = this.mergeStatus;
		switch (phase) {
			case "parsing":
				return `${this.pulsed("◐")} Parsing ${findingCount} findings...`;
			case "clustering":
				return `${this.pulsed("◐")} Clustering similar findings...`;
			case "verifying":
				return `${this.pulsed("◐")} Verifying against code...`;
			case "ranking":
				return `${this.pulsed("◐")} Ranking by severity...`;
			case "synthesizing":
				return `${this.pulsed("◐")} Synthesizing summary...`;
			case "done":
				return `${theme.fg("success", "✓")} ${verifiedCount}/${findingCount} findings verified`;
			default:
				return "";
		}
	}

	/**
	 * Build a statistics line showing counters for files, searches, memory ops, etc.
	 */
	private buildStatsLine(): string | null {
		const parts: string[] = [];

		if (this.leadFilesScanned > 0) {
			parts.push(`${theme.fg("accent", "\uf02d")} ${this.leadFilesScanned}`); // nf-fa-book
		}
		if (this.leadSearchesRun > 0) {
			parts.push(`${theme.fg("accent", "\uf002")} ${this.leadSearchesRun}`); // nf-fa-search
		}
		if (this.leadMemoryOps > 0) {
			parts.push(`${theme.fg("accent", "\uf1c0")} ${this.leadMemoryOps}`); // nf-fa-database
		}
		if (this.leadAnalysisOps > 0) {
			parts.push(`${theme.fg("accent", "\uf085")} ${this.leadAnalysisOps}`); // nf-fa-cogs
		}

		if (parts.length === 0) return null;
		return `  ${parts.join("  ")}`;
	}

	/**
	 * Shorten a path for display (replace home dir with ~, use basename for long paths)
	 */
	private shortenPath(filePath: string): string {
		// Replace home directory with ~
		const home = process.env.HOME || process.env.USERPROFILE || "";
		let shortened = filePath;
		if (home && shortened.startsWith(home)) {
			shortened = `~${shortened.slice(home.length)}`;
		}

		// If still too long, use directory + basename
		if (shortened.length > 50) {
			const dir = path.dirname(shortened);
			const base = path.basename(shortened);
			const dirParts = dir.split(path.sep);
			if (dirParts.length > 2) {
				shortened = `.../${dirParts[dirParts.length - 1]}/${base}`;
			}
		}

		return shortened;
	}

	private truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return `${text.slice(0, maxLen - 3)}...`;
	}

	dispose(): void {
		this.stopPulse();
	}
}
