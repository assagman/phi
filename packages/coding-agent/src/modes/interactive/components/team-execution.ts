/**
 * Team execution progress component for inline chat display.
 * Shows live agent status and high-level tool calls.
 */

import type { TeamEvent } from "agents";
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

// RGB for pulse animation
const PULSE_RGB: [number, number, number] = [95, 135, 255]; // accent blue

interface AgentStatus {
	name: string;
	status: "pending" | "running" | "success" | "error";
	toolCalls: string[];
	error?: string;
	findingCount?: number;
}

interface MergeStatus {
	phase: "idle" | "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing" | "done";
	findingCount: number;
	verifiedCount: number;
}

/**
 * Displays team execution progress inline in chat.
 * Updates in real-time as agents run and complete.
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

		// Initialize all agents as pending
		for (const name of agentNames) {
			this.agents.set(name, {
				name,
				status: "pending",
				toolCalls: [],
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

			case "agent_event": {
				const agent = this.agents.get(event.agentName);
				if (agent && event.event.type === "tool_execution_start") {
					// Add tool call summary (just name, not full args)
					const toolName = event.event.toolName;
					if (!agent.toolCalls.includes(toolName)) {
						agent.toolCalls.push(toolName);
					}
				}
				break;
			}

			case "agent_end": {
				const agent = this.agents.get(event.agentName);
				if (agent) {
					agent.status = event.result.success ? "success" : "error";
					agent.error = event.result.error;
					agent.findingCount = event.result.findings.length;
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
	 * Mark execution as complete
	 */
	complete(): void {
		this.running = false;
		this.stopPulse();
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

		// Agent status table
		lines.push(theme.fg("muted", "Agents:"));
		for (const agent of this.agents.values()) {
			const icon = this.formatStatusIcon(agent.status);
			const tools = agent.toolCalls.length > 0 ? theme.fg("muted", ` → ${agent.toolCalls.join(", ")}`) : "";
			const findings =
				agent.findingCount !== undefined ? theme.fg("muted", ` (${agent.findingCount} findings)`) : "";
			const error = agent.error ? theme.fg("error", ` Error: ${agent.error}`) : "";
			lines.push(`  ${icon} ${agent.name}${tools}${findings}${error}`);
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

	dispose(): void {
		this.stopPulse();
	}
}
