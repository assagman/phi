/**
 * Permission prompt UI — TUI card component for permission requests.
 *
 * Renders a bordered card with:
 *   - Description of what is being requested
 *   - 4 options: Allow once, Allow session, Allow future, Reject
 *   - On reject: inline text input for user's alternative suggestion
 *
 * Modeled after the Sigma UI pattern.
 */

import { Editor, type EditorTheme, Key, matchesKey, type TUI, visibleWidth, wrapTextWithAnsi } from "tui";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { PermissionPromptResult, PermissionRequest } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

const PAD = 2;
const ICON = "🔒";

interface PermissionOption {
	key: string;
	label: string;
	description: string;
	value: "once" | "session" | "persistent" | "reject";
}

const OPTIONS: PermissionOption[] = [
	{ key: "1", label: "Allow once", description: "Grant access for this turn only", value: "once" },
	{
		key: "2",
		label: "Allow for session",
		description: "Grant access until phi exits",
		value: "session",
	},
	{
		key: "3",
		label: "Allow always",
		description: "Remember this permission across sessions",
		value: "persistent",
	},
	{
		key: "4",
		label: "Reject",
		description: "Deny access (optionally suggest alternative)",
		value: "reject",
	},
];

// ── Factory ─────────────────────────────────────────────────────────────────

export function createPermissionPromptUI(
	tui: TUI,
	theme: Theme,
	request: PermissionRequest,
	done: (result: PermissionPromptResult) => void,
) {
	// ── State ────────────────────────────────────────────────────────────
	let selectedIndex = 0;
	let rejectInputMode = false;
	let cachedLines: string[] | undefined;

	// ── Editor for reject message ────────────────────────────────────────
	const editorTheme: EditorTheme = {
		borderColor: (s: string) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	function refresh() {
		cachedLines = undefined;
		tui.requestRender();
	}

	function submit(result: PermissionPromptResult) {
		done(result);
	}

	// ── Editor submit ────────────────────────────────────────────────────
	editor.onSubmit = (value: string) => {
		const trimmed = value.trim();
		submit({ action: "deny", userMessage: trimmed || undefined });
	};

	// ── Input handling ───────────────────────────────────────────────────

	function handleInput(data: string) {
		if (rejectInputMode) {
			if (matchesKey(data, Key.escape)) {
				rejectInputMode = false;
				editor.setText("");
				refresh();
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		// Option navigation
		if (matchesKey(data, Key.ctrl("p")) || matchesKey(data, Key.up) || data === "k") {
			selectedIndex = Math.max(0, selectedIndex - 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.down) || data === "j") {
			selectedIndex = Math.min(OPTIONS.length - 1, selectedIndex + 1);
			refresh();
			return;
		}

		// Number keys for quick selection
		for (let i = 0; i < OPTIONS.length; i++) {
			if (data === OPTIONS[i].key) {
				selectOption(i);
				return;
			}
		}

		// Enter to select
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("y"))) {
			selectOption(selectedIndex);
			return;
		}

		// Escape to reject without message
		if (matchesKey(data, Key.escape)) {
			submit({ action: "deny" });
			return;
		}
	}

	function selectOption(index: number) {
		const option = OPTIONS[index];
		if (option.value === "reject") {
			rejectInputMode = true;
			editor.setText("");
			refresh();
			return;
		}
		submit({ action: "allow", scope: option.value });
	}

	// ── Rendering ────────────────────────────────────────────────────────

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const innerW = width - 2;
		const usable = innerW - PAD * 2;

		const lines: string[] = [];

		// Top border
		lines.push(theme.fg("warning", `╭${"─".repeat(Math.max(0, width - 2))}╮`));

		// Banner
		const bannerText = ` ${ICON} ${theme.bold("Permission Required")}`;
		const bannerPad = Math.max(0, innerW - visibleWidth(bannerText));
		lines.push(
			theme.fg("warning", "│") + theme.fg("warning", bannerText) + " ".repeat(bannerPad) + theme.fg("warning", "│"),
		);

		// Separator
		lines.push(
			theme.fg("warning", "├") + theme.fg("dim", "┄".repeat(Math.max(0, innerW))) + theme.fg("warning", "┤"),
		);

		// Request description
		const descLines = usable > 10 ? wrapTextWithAnsi(request.description, usable) : [request.description];
		for (const dl of descLines) {
			const pad = Math.max(0, innerW - visibleWidth(" ".repeat(PAD) + dl));
			lines.push(
				theme.fg("warning", "│") +
					" ".repeat(PAD) +
					theme.fg("text", dl) +
					" ".repeat(pad) +
					theme.fg("warning", "│"),
			);
		}

		// Tool info
		const toolInfo = `Tool: ${request.toolName}`;
		const toolPad = Math.max(0, innerW - visibleWidth(" ".repeat(PAD) + toolInfo));
		lines.push(
			theme.fg("warning", "│") +
				" ".repeat(PAD) +
				theme.fg("muted", toolInfo) +
				" ".repeat(toolPad) +
				theme.fg("warning", "│"),
		);

		// Empty line
		const emptyPad = " ".repeat(Math.max(0, innerW));
		lines.push(theme.fg("warning", "│") + emptyPad + theme.fg("warning", "│"));

		// Options
		for (let i = 0; i < OPTIONS.length; i++) {
			const opt = OPTIONS[i];
			const isSelected = i === selectedIndex && !rejectInputMode;

			let badge: string;
			let label: string;
			let desc: string;

			if (isSelected) {
				badge = theme.fg("accent", theme.bold(`[${opt.key}]`));
				label = theme.fg("accent", theme.bold(opt.label));
				desc = theme.fg("muted", opt.description);
			} else if (rejectInputMode) {
				badge = theme.fg("dim", `[${opt.key}]`);
				label = theme.fg("dim", opt.label);
				desc = theme.fg("dim", opt.description);
			} else {
				badge = theme.fg("muted", `[${opt.key}]`);
				label = theme.fg("text", opt.label);
				desc = theme.fg("dim", opt.description);
			}

			const optLine = `${" ".repeat(PAD)}${badge}  ${label}  ${desc}`;
			const optPad = Math.max(0, innerW - visibleWidth(optLine));
			lines.push(theme.fg("warning", "│") + optLine + " ".repeat(optPad) + theme.fg("warning", "│"));
		}

		// Reject input area
		if (rejectInputMode) {
			lines.push(theme.fg("warning", "│") + emptyPad + theme.fg("warning", "│"));

			const inputLabel = " ".repeat(PAD) + theme.fg("muted", "Alternative suggestion (optional, Enter to submit):");
			const inputLabelPad = Math.max(0, innerW - visibleWidth(inputLabel));
			lines.push(theme.fg("warning", "│") + inputLabel + " ".repeat(inputLabelPad) + theme.fg("warning", "│"));

			const editorW = Math.max(10, innerW - PAD * 2);
			for (const editorLine of editor.render(editorW)) {
				const el = " ".repeat(PAD) + editorLine;
				const elPad = Math.max(0, innerW - visibleWidth(el));
				lines.push(theme.fg("warning", "│") + el + " ".repeat(elPad) + theme.fg("warning", "│"));
			}

			const hint = " ".repeat(PAD) + theme.fg("dim", "Enter to submit · Esc to cancel");
			const hintPad = Math.max(0, innerW - visibleWidth(hint));
			lines.push(theme.fg("warning", "│") + hint + " ".repeat(hintPad) + theme.fg("warning", "│"));
		}

		// Empty line
		lines.push(theme.fg("warning", "│") + emptyPad + theme.fg("warning", "│"));

		// Help footer
		const helpParts = rejectInputMode
			? [
					`${theme.fg("muted", "[⏎]")} ${theme.fg("dim", "submit")}  ${theme.fg("muted", "[Esc]")} ${theme.fg("dim", "back")}`,
				]
			: [
					`${theme.fg("muted", "[↑/↓]")} ${theme.fg("dim", "nav")}`,
					`${theme.fg("muted", "[1-4]")} ${theme.fg("dim", "pick")}`,
					`${theme.fg("muted", "[⏎]")} ${theme.fg("dim", "select")}`,
					`${theme.fg("muted", "[Esc]")} ${theme.fg("dim", "reject")}`,
				];
		const helpLine = " ".repeat(PAD) + helpParts.join("  ");
		const helpPad = Math.max(0, innerW - visibleWidth(helpLine));
		lines.push(theme.fg("warning", "│") + helpLine + " ".repeat(helpPad) + theme.fg("warning", "│"));

		// Bottom border
		lines.push(theme.fg("warning", `╰${"─".repeat(Math.max(0, width - 2))}╯`));

		cachedLines = lines;
		return lines;
	}

	return {
		render,
		invalidate: () => {
			cachedLines = undefined;
		},
		handleInput,
	};
}
