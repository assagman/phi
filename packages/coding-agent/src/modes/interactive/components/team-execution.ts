/**
 * Team execution progress component for inline chat display.
 * Shows hierarchical tree of agents with epsilon task progress.
 */

import type { AgentTaskInfo, TeamEvent } from "agents";
import { Container, Text, type TUI } from "tui";
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
		const status = this.running ? this.pulsed("running") : theme.fg("success", "complete");
		lines.push(`${theme.fg("accent", `⚑ Team: ${this.teamName}`)} ${theme.fg("muted", `(${elapsed}s)`)} ${status}`);
		lines.push("");

		// Agent tree with progress
		lines.push(theme.fg("muted", "Agents:"));
		const agentList = Array.from(this.agents.values());
		for (let i = 0; i < agentList.length; i++) {
			const agent = agentList[i];
			const isLast = i === agentList.length - 1;
			const treeBranch = isLast ? TREE.last : TREE.branch;
			const agentLine = this.formatAgentLine(agent, treeBranch);
			lines.push(agentLine);
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

	private truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return `${text.slice(0, maxLen - 3)}...`;
	}

	dispose(): void {
		this.stopPulse();
	}
}
