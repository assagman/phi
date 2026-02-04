/**
 * Team selector component with fzf-style search and review page.
 *
 * Flow:
 * 1. Search screen: type to filter, ↑↓ navigate, Enter to add, Tab to review
 * 2. Review screen: shows selected teams, Tab to go back, Enter to submit
 */

import { Container, getEditorKeybindings, Spacer, Text, type TUI } from "tui";
import type { TeamInfo } from "../../../core/commands/team.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { rawKeyHint } from "./keybinding-hints.js";

export interface TeamSelectorOptions {
	tui?: TUI;
}

type Screen = "search" | "review";

export class TeamSelectorComponent extends Container {
	private teams: TeamInfo[];
	private filteredTeams: TeamInfo[] = [];
	private selectedIndex = 0;
	private selectedTeams: Map<string, TeamInfo> = new Map();
	private searchQuery = "";
	private screen: Screen = "search";

	private contentContainer: Container;
	private onSelectCallback: (teams: TeamInfo[]) => void;
	private onCancelCallback: () => void;
	private tui: TUI | undefined;

	constructor(
		_title: string,
		teams: TeamInfo[],
		onSelect: (teams: TeamInfo[]) => void,
		onCancel: () => void,
		opts?: TeamSelectorOptions,
	) {
		super();

		this.teams = teams;
		this.filteredTeams = [...teams];
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.tui = opts?.tui;

		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.renderScreen();
	}

	private renderScreen(): void {
		this.contentContainer.clear();

		if (this.screen === "search") {
			this.renderSearchScreen();
		} else {
			this.renderReviewScreen();
		}

		this.tui?.requestRender();
	}

	private renderSearchScreen(): void {
		const c = this.contentContainer;

		c.addChild(new DynamicBorder());
		c.addChild(new Spacer(1));

		// Title with selection count
		const selCount = this.selectedTeams.size;
		const title = selCount > 0 ? `Select teams (${selCount} selected)` : "Select teams";
		c.addChild(new Text(theme.fg("accent", title), 1, 0));
		c.addChild(new Spacer(1));

		// Search input
		const cursor = "█";
		const searchLine = theme.fg("muted", "> ") + this.searchQuery + theme.fg("accent", cursor);
		c.addChild(new Text(searchLine, 1, 0));
		c.addChild(new Text(theme.fg("border", "─".repeat(60)), 1, 0));

		// Filtered list (max 15 visible)
		const maxVisible = 15;
		const startIdx = Math.max(0, this.selectedIndex - Math.floor(maxVisible / 2));
		const endIdx = Math.min(this.filteredTeams.length, startIdx + maxVisible);

		for (let i = startIdx; i < endIdx; i++) {
			const team = this.filteredTeams[i];
			const isCursor = i === this.selectedIndex;
			const isSelected = this.selectedTeams.has(team.name);

			const cursor = isCursor ? theme.fg("accent", "→ ") : "  ";
			const check = isSelected ? theme.fg("success", "✓ ") : "  ";
			const name = isCursor ? theme.fg("accent", team.name) : theme.fg("text", team.name);
			const agents = theme.fg("muted", ` (${team.agentCount} agents)`);

			c.addChild(new Text(cursor + check + name + agents, 1, 0));
		}

		// Show scroll indicator if list is long
		if (this.filteredTeams.length > maxVisible) {
			const indicator = theme.fg("muted", `  ... ${this.filteredTeams.length - maxVisible} more`);
			c.addChild(new Text(indicator, 1, 0));
		}

		// Empty state
		if (this.filteredTeams.length === 0) {
			c.addChild(new Text(theme.fg("muted", "  No matches"), 1, 0));
		}

		c.addChild(new Spacer(1));

		// Hints
		const hints =
			rawKeyHint("↑↓", "navigate") +
			"  " +
			rawKeyHint("enter", "add") +
			"  " +
			rawKeyHint("tab", "review") +
			"  " +
			rawKeyHint("esc", "cancel");
		c.addChild(new Text(hints, 1, 0));
		c.addChild(new Spacer(1));
		c.addChild(new DynamicBorder());
	}

	private renderReviewScreen(): void {
		const c = this.contentContainer;
		const selected = Array.from(this.selectedTeams.values());
		const totalAgents = selected.reduce((sum, t) => sum + t.agentCount, 0);

		c.addChild(new DynamicBorder());
		c.addChild(new Spacer(1));

		// Title
		const title = `Review selection (${selected.length} teams, ${totalAgents} agents)`;
		c.addChild(new Text(theme.fg("accent", title), 1, 0));
		c.addChild(new Spacer(1));

		if (selected.length === 0) {
			c.addChild(new Text(theme.fg("warning", "  No teams selected"), 1, 0));
			c.addChild(new Text(theme.fg("muted", "  Press Tab to go back and select teams"), 1, 0));
		} else {
			// List selected teams
			for (const team of selected) {
				const check = theme.fg("success", "✓ ");
				const name = theme.fg("text", team.name);
				const agents = theme.fg("muted", ` (${team.agentCount} agents)`);
				const desc = team.description ? theme.fg("muted", ` - ${team.description}`) : "";
				c.addChild(new Text(`  ${check}${name}${agents}${desc}`, 1, 0));
			}
		}

		c.addChild(new Spacer(1));

		// Hints
		const hints =
			rawKeyHint("tab", "back") +
			"  " +
			(selected.length > 0 ? `${rawKeyHint("enter", "submit")}  ` : "") +
			rawKeyHint("esc", "cancel");
		c.addChild(new Text(hints, 1, 0));
		c.addChild(new Spacer(1));
		c.addChild(new DynamicBorder());
	}

	private filterTeams(): void {
		const query = this.searchQuery.toLowerCase();
		if (!query) {
			this.filteredTeams = [...this.teams];
		} else {
			// Fuzzy match: all query chars must appear in order
			this.filteredTeams = this.teams.filter((t) => {
				const name = t.name.toLowerCase();
				const desc = (t.description ?? "").toLowerCase();
				const text = `${name} ${desc}`;

				let qi = 0;
				for (const char of text) {
					if (char === query[qi]) {
						qi++;
						if (qi === query.length) return true;
					}
				}
				return false;
			});
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTeams.length - 1));
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (this.screen === "search") {
			this.handleSearchInput(keyData, kb);
		} else {
			this.handleReviewInput(keyData, kb);
		}
	}

	private handleSearchInput(keyData: string, kb: ReturnType<typeof getEditorKeybindings>): void {
		// Navigation
		if (kb.matches(keyData, "selectUp") || keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.renderScreen();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "\x1b[B") {
			this.selectedIndex = Math.min(this.filteredTeams.length - 1, this.selectedIndex + 1);
			this.renderScreen();
			return;
		}

		// Enter - add/remove team to selection
		if (keyData === "\r" || keyData === "\n") {
			const team = this.filteredTeams[this.selectedIndex];
			if (team) {
				if (this.selectedTeams.has(team.name)) {
					this.selectedTeams.delete(team.name);
				} else {
					this.selectedTeams.set(team.name, team);
				}
				this.renderScreen();
			}
			return;
		}

		// Tab - go to review screen
		if (keyData === "\t") {
			this.screen = "review";
			this.renderScreen();
			return;
		}

		// Escape - cancel
		if (kb.matches(keyData, "selectCancel") || keyData === "\x1b") {
			this.onCancelCallback();
			return;
		}

		// Backspace
		if (keyData === "\x7f" || keyData === "\b") {
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.filterTeams();
				this.renderScreen();
			}
			return;
		}

		// Printable characters - add to search
		if (keyData.length === 1 && keyData >= " " && keyData <= "~") {
			this.searchQuery += keyData;
			this.filterTeams();
			this.renderScreen();
		}
	}

	private handleReviewInput(keyData: string, kb: ReturnType<typeof getEditorKeybindings>): void {
		// Tab - back to search
		if (keyData === "\t") {
			this.screen = "search";
			this.renderScreen();
			return;
		}

		// Enter - submit if we have selections
		if (keyData === "\r" || keyData === "\n") {
			const selected = Array.from(this.selectedTeams.values());
			if (selected.length > 0) {
				this.onSelectCallback(selected);
			}
			return;
		}

		// Escape - cancel
		if (kb.matches(keyData, "selectCancel") || keyData === "\x1b") {
			this.onCancelCallback();
			return;
		}
	}

	dispose(): void {
		// Nothing to clean up
	}
}
