/**
 * Component for displaying bash command execution with streaming output.
 *
 * Performance: uses a persistent LiveFeed with incremental addItem/updateItem
 * to avoid O(n²) full-rebuild on each streaming chunk. Full rebuilds only
 * happen on state transitions (expand/collapse, completion, width change).
 */

import stripAnsi from "strip-ansi";
import { AnimatedLoader, type Component, Container, LiveFeed, Spacer, Text, type TUI } from "tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { editorKey } from "./keybinding-hints.js";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 5;

/**
 * Wrapper component that delegates render() to a LiveFeed instance.
 * Kept as a stable child in the contentContainer so we never recreate it.
 */
class LiveFeedComponent implements Component {
	private feed: LiveFeed;

	constructor(feed: LiveFeed) {
		this.feed = feed;
	}

	render(width: number): string[] {
		const feedLines = this.feed.render(Math.max(1, width - 2));
		return feedLines.length > 0 ? ["", ...feedLines] : [];
	}

	invalidate(): void {
		this.feed.invalidate();
	}
}

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: AnimatedLoader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;
	private colorKey: "dim" | "bashMode";

	// ── Persistent components (stable across appendOutput calls) ────────
	private header: Text;
	private previewFeed: LiveFeed;
	private feedComponent: LiveFeedComponent;
	private expandedText: Text;
	private statusText: Text;

	// ── Incremental tracking ────────────────────────────────────────────
	/** Number of lines already fed to previewFeed */
	private fedLineCount = 0;
	/** Tracks total byte length of outputLines to avoid re-computing */
	private totalBytes = 0;
	/** Whether context truncation was triggered for display */
	private contextTruncated = false;
	/** Last hidden line count for status display */
	private hiddenLineCount = 0;

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.command = command;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		const borderColor = (str: string) => theme.fg(this.colorKey, str);

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// ── Persistent children ─────────────────────────────────────────

		// Command header (always visible)
		this.header = new Text(theme.fg(this.colorKey, theme.bold(`$ ${command}`)), 1, 0);

		// LiveFeed for collapsed preview (persistent, incrementally updated)
		this.previewFeed = new LiveFeed({
			maxLines: PREVIEW_LINES,
			overflowText: (n) => theme.fg("muted", `… ${n} lines above`),
		});
		this.feedComponent = new LiveFeedComponent(this.previewFeed);

		// Text for expanded mode (rebuilt only on expand/state change)
		this.expandedText = new Text("", 1, 0);

		// Status text (shown after completion)
		this.statusText = new Text("", 1, 0);

		// Loader
		this.loader = new AnimatedLoader(
			ui,
			(spinner) => theme.fg(this.colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${editorKey("selectCancel")} to cancel)`,
		);

		// Build initial layout
		this.rebuildLayout();

		// Bottom border
		this.addChild(new DynamicBorder(borderColor));
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuildFull();
	}

	override invalidate(): void {
		super.invalidate();
		// Width may have changed — invalidate feed wrap cache and rebuild
		this.previewFeed.invalidate();
		this.rebuildFull();
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const chunkBytes = Buffer.byteLength(clean, "utf-8");

		// Append to output lines (same logic as before)
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}
		this.totalBytes += chunkBytes;

		// Check if we've exceeded context limits (triggers full rebuild once)
		if (
			!this.contextTruncated &&
			(this.outputLines.length > DEFAULT_MAX_LINES || this.totalBytes > DEFAULT_MAX_BYTES)
		) {
			this.contextTruncated = true;
			this.rebuildFull();
			return;
		}

		// If already truncated, we need full rebuild to re-apply truncation window
		if (this.contextTruncated) {
			this.rebuildFull();
			return;
		}

		// ── Fast path: incremental feed update (no truncation needed) ───
		this.incrementalFeedUpdate(newLines);
	}

	/**
	 * Incrementally add new lines to the persistent LiveFeed.
	 * Only updates/adds items that changed since last call.
	 */
	private incrementalFeedUpdate(newChunkLines: string[]): void {
		// First output arriving — need layout rebuild to insert feedComponent/expandedText
		const needsLayoutRebuild = this.fedLineCount === 0;

		if (this.expanded) {
			// Expanded mode uses Text, not LiveFeed — need to rebuild expanded text
			this.rebuildExpandedText();
			if (needsLayoutRebuild) this.rebuildLayout();
			return;
		}

		const lines = this.outputLines;

		// If the first chunk line was appended to the last existing line, update it
		if (this.fedLineCount > 0 && newChunkLines.length > 0) {
			const lastFedIdx = this.fedLineCount - 1;
			this.previewFeed.updateItem(`out:${lastFedIdx}`, theme.fg("muted", lines[lastFedIdx]));
		}

		// Add any new lines beyond what we've already fed
		for (let i = this.fedLineCount; i < lines.length; i++) {
			this.previewFeed.addItem({
				id: `out:${i}`,
				text: theme.fg("muted", lines[i]),
			});
		}
		this.fedLineCount = lines.length;
		this.hiddenLineCount = Math.max(0, lines.length - PREVIEW_LINES);

		// Insert feedComponent into layout if this is the first output
		if (needsLayoutRebuild) this.rebuildLayout();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		this.loader.stop();

		this.rebuildFull();
	}

	/**
	 * Full rebuild: recompute truncation, rebuild all display components.
	 * Called on state transitions: completion, expand/collapse, width change,
	 * and when context truncation is first triggered.
	 */
	private rebuildFull(): void {
		// Recompute available lines with truncation
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		this.contextTruncated = contextTruncation.truncated;

		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
		this.hiddenLineCount = Math.max(0, availableLines.length - PREVIEW_LINES);

		// Rebuild LiveFeed from scratch with truncated lines
		this.previewFeed.clear();
		for (let i = 0; i < availableLines.length; i++) {
			this.previewFeed.addItem({
				id: `out:${i}`,
				text: theme.fg("muted", availableLines[i]),
			});
		}
		this.fedLineCount = availableLines.length;

		// Rebuild expanded text
		if (this.expanded && availableLines.length > 0) {
			const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
			this.expandedText.setText(`\n${displayText}`);
		}

		// Rebuild status text
		this.rebuildStatusText(contextTruncation.truncated);

		// Rebuild layout structure
		this.rebuildLayout();
	}

	/**
	 * Rebuild the expanded text from current outputLines.
	 * Used in incremental path when expanded mode is active.
	 */
	private rebuildExpandedText(): void {
		const displayText = this.outputLines.map((line) => theme.fg("muted", line)).join("\n");
		this.expandedText.setText(`\n${displayText}`);
	}

	/**
	 * Rebuild the status text shown after completion.
	 */
	private rebuildStatusText(contextWasTruncated: boolean): void {
		if (this.status === "running") {
			this.statusText.setText("");
			return;
		}

		const statusParts: string[] = [];

		// Show how many lines are hidden (collapsed preview)
		if (this.hiddenLineCount > 0 && !this.expanded) {
			statusParts.push(theme.fg("muted", `... ${this.hiddenLineCount} more lines`));
		}

		if (this.status === "cancelled") {
			statusParts.push(theme.fg("warning", "(cancelled)"));
		} else if (this.status === "error") {
			statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
		}

		// Add truncation warning
		const wasTruncated = this.truncationResult?.truncated || contextWasTruncated;
		if (wasTruncated && this.fullOutputPath) {
			statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
		}

		if (statusParts.length > 0) {
			this.statusText.setText(`\n${statusParts.join("\n")}`);
		} else {
			this.statusText.setText("");
		}
	}

	/**
	 * Rebuild contentContainer child layout based on current state.
	 * Does NOT recreate components — just rearranges persistent children.
	 */
	private rebuildLayout(): void {
		this.contentContainer.clear();

		// Always show header
		this.contentContainer.addChild(this.header);

		// Output display (only if we have output)
		const hasOutput = this.outputLines.length > 0;
		if (hasOutput) {
			if (this.expanded) {
				this.contentContainer.addChild(this.expandedText);
			} else {
				this.contentContainer.addChild(this.feedComponent);
			}
		}

		// Loader (running) or status text (complete)
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusStr = this.statusText.render(999).join("\n");
			if (statusStr.trim()) {
				this.contentContainer.addChild(this.statusText);
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
