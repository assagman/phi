/**
 * Sigma UI — Card component for the Sigma tool.
 *
 * Features:
 *   - Vim-style keybindings: j/k scroll, C-n/C-p option nav, h/l context
 *   - Number keys [0-9] for quick option selection
 *   - Tab navigation for multi-question mode
 *   - Scrollable content with ▲/▼ indicators
 *   - Context view (l) to see recent assistant messages
 *   - Always-present "Type something" option
 */

import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "tui";
import { getMarkdownTheme, type Theme } from "../../../modes/interactive/theme/theme.js";
import { buildOptions } from "./helpers.js";
import type { Answer, AskResult, Question, RenderOption } from "./types.js";

// ── Visual constants ────────────────────────────────────────────────────────

const REVERSE = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const PAD = 2;
const ICON = "󱜹";

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the Sigma TUI component.
 */
export function createSigmaUI(
	tui: TUI,
	theme: Theme,
	done: (result: AskResult) => void,
	questions: Question[],
	contextMessages?: string[],
) {
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1; // questions + Submit
	const hasContext = contextMessages && contextMessages.length > 0;

	// ── State ────────────────────────────────────────────────────────────
	let viewMode: "question" | "context" = "question";
	let currentTab = 0;
	let optionIndex = 0;
	let inputMode = false;
	let inputQuestionId: string | null = null;
	let cachedLines: string[] | undefined;
	const answers = new Map<string, Answer>();

	// Scroll state
	let scrollOffset = 0;
	let fixedBodyHeight: number | null = null;
	let manualScroll = false;

	// Context body cache
	let contextBodyCache: { lines: string[]; width: number } | undefined;

	// Memoised options per question
	const optionsCache = new Map<string, RenderOption[]>();

	// ── Editor for custom input ──────────────────────────────────────────
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

	// ── Core helpers ─────────────────────────────────────────────────────

	function refresh() {
		cachedLines = undefined;
		tui.requestRender();
	}

	function submit(cancelled: boolean) {
		done({ questions, answers: Array.from(answers.values()), cancelled });
	}

	function currentQuestion(): Question | undefined {
		return questions[currentTab];
	}

	function currentOptions(): RenderOption[] {
		const q = currentQuestion();
		if (!q) return [];
		let cached = optionsCache.get(q.id);
		if (!cached) {
			cached = buildOptions(q);
			optionsCache.set(q.id, cached);
		}
		return cached;
	}

	function allAnswered(): boolean {
		return questions.every((q) => answers.has(q.id));
	}

	function advanceAfterAnswer() {
		if (!isMulti) {
			submit(false);
			return;
		}
		if (currentTab < questions.length - 1) {
			currentTab++;
		} else {
			currentTab = questions.length; // Submit tab
		}
		optionIndex = 0;
		refresh();
	}

	function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
		answers.set(questionId, { id: questionId, value, label, wasCustom, index });
	}

	function selectOptionAtIndex(idx: number) {
		const q = currentQuestion();
		const opts = currentOptions();
		if (!q || idx < 0 || idx >= opts.length) return;

		const opt = opts[idx];
		if (opt.isOther) {
			inputMode = true;
			inputQuestionId = q.id;
			editor.setText("");
			refresh();
			return;
		}
		saveAnswer(q.id, opt.value, opt.label, false, idx + 1);
		advanceAfterAnswer();
	}

	// ── Editor submit callback ───────────────────────────────────────────
	editor.onSubmit = (value: string) => {
		if (!inputQuestionId) return;
		const trimmed = value.trim() || "(no response)";
		saveAnswer(inputQuestionId, trimmed, trimmed, true);
		inputMode = false;
		inputQuestionId = null;
		editor.setText("");
		advanceAfterAnswer();
	};

	// ── Input handling ───────────────────────────────────────────────────

	function handleEditorInput(data: string): boolean {
		if (!inputMode) return false;
		if (matchesKey(data, Key.escape)) {
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			refresh();
			return true;
		}
		editor.handleInput(data);
		refresh();
		return true;
	}

	function handleScrollKeys(data: string): boolean {
		if (data === "j") {
			scrollOffset++;
			manualScroll = true;
			refresh();
			return true;
		}
		if (data === "k") {
			scrollOffset = Math.max(0, scrollOffset - 1);
			manualScroll = true;
			refresh();
			return true;
		}
		return false;
	}

	function handleContextFlip(data: string): boolean {
		if (!hasContext) return false;
		if (viewMode === "question" && data === "l") {
			viewMode = "context";
			scrollOffset = 0;
			manualScroll = false;
			fixedBodyHeight = null;
			refresh();
			return true;
		}
		if (viewMode === "context" && data === "h") {
			viewMode = "question";
			scrollOffset = 0;
			manualScroll = false;
			fixedBodyHeight = null;
			refresh();
			return true;
		}
		return false;
	}

	function handleTabNavigation(data: string): boolean {
		if (!isMulti) return false;
		if (matchesKey(data, Key.tab)) {
			currentTab = (currentTab + 1) % totalTabs;
			optionIndex = 0;
			scrollOffset = 0;
			manualScroll = false;
			refresh();
			return true;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			currentTab = (currentTab - 1 + totalTabs) % totalTabs;
			optionIndex = 0;
			scrollOffset = 0;
			manualScroll = false;
			refresh();
			return true;
		}
		return false;
	}

	function handleSubmitTab(data: string): boolean {
		if (currentTab !== questions.length) return false;
		if ((matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("y"))) && allAnswered()) {
			submit(false);
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			submit(true);
			return true;
		}
		return true;
	}

	function handleOptionNavigation(data: string): boolean {
		const opts = currentOptions();
		if (matchesKey(data, Key.ctrl("p")) || matchesKey(data, Key.up)) {
			optionIndex = Math.max(0, optionIndex - 1);
			manualScroll = false;
			refresh();
			return true;
		}
		if (matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.down)) {
			optionIndex = Math.min(opts.length - 1, optionIndex + 1);
			manualScroll = false;
			refresh();
			return true;
		}
		return false;
	}

	function handleNumberKeys(data: string): boolean {
		const opts = currentOptions();
		if (data === "0") {
			const lastIdx = opts.length - 1;
			if (lastIdx >= 0 && opts[lastIdx].isOther) {
				selectOptionAtIndex(lastIdx);
				return true;
			}
			return false;
		}
		if (data.length !== 1 || data < "1" || data > "9") return false;
		const idx = Number.parseInt(data, 10) - 1;
		if (idx < opts.length - 1) {
			selectOptionAtIndex(idx);
			return true;
		}
		return false;
	}

	function handleEnterKey(data: string): boolean {
		if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.ctrl("y"))) return false;
		if (currentQuestion()) {
			selectOptionAtIndex(optionIndex);
			return true;
		}
		return false;
	}

	function handleEscapeKey(data: string): boolean {
		if (!matchesKey(data, Key.escape)) return false;
		submit(true);
		return true;
	}

	function handleInput(data: string) {
		if (handleEditorInput(data)) return;
		if (handleContextFlip(data)) return;

		if (viewMode === "context") {
			if (handleScrollKeys(data)) return;
			if (matchesKey(data, Key.escape) || data === "q") {
				viewMode = "question";
				scrollOffset = 0;
				manualScroll = false;
				fixedBodyHeight = null;
				refresh();
			}
			return;
		}

		if (data === "q") {
			submit(true);
			return;
		}

		if (handleScrollKeys(data)) return;
		if (handleTabNavigation(data)) return;
		if (handleSubmitTab(data)) return;
		if (handleOptionNavigation(data)) return;
		if (handleNumberKeys(data)) return;
		if (handleEnterKey(data)) return;
		handleEscapeKey(data);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// ── RENDERING
	// ═══════════════════════════════════════════════════════════════════════

	function padRight(text: string, targetWidth: number): string {
		const vis = visibleWidth(text);
		if (vis > targetWidth) return truncateToWidth(text, targetWidth);
		if (vis === targetWidth) return text;
		return text + " ".repeat(targetWidth - vis);
	}

	// ── Section renderers ────────────────────────────────────────────────

	function renderTabBar(_innerW: number): string[] {
		if (!isMulti) return [];

		const pills: string[] = [];
		for (let i = 0; i < questions.length; i++) {
			const isActive = i === currentTab;
			const isAnswered = answers.has(questions[i].id);
			const lbl = questions[i].label;

			if (isActive) {
				pills.push(theme.fg("accent", `${REVERSE} ${lbl} ${REVERSE_OFF}`));
			} else if (isAnswered) {
				pills.push(theme.fg("success", `✓ ${lbl}`));
			} else {
				pills.push(theme.fg("muted", `  ${lbl}`));
			}
		}

		const isSubmitActive = currentTab === questions.length;
		const canSubmit = allAnswered();

		if (isSubmitActive) {
			pills.push(theme.fg("accent", `${REVERSE} Submit ${REVERSE_OFF}`));
		} else if (canSubmit) {
			pills.push(theme.fg("success", "✓ Submit"));
		} else {
			pills.push(theme.fg("dim", "  Submit"));
		}

		return [" ".repeat(PAD) + pills.join("  ")];
	}

	function renderPrompt(q: Question, innerW: number): string[] {
		const usable = innerW - PAD * 2;
		if (usable <= 10) {
			return [" ".repeat(PAD) + theme.fg("text", q.prompt)];
		}
		const wrapped = wrapTextWithAnsi(q.prompt, usable);
		return wrapped.map((line) => " ".repeat(PAD) + theme.fg("text", line));
	}

	function renderOptionsList(opts: RenderOption[], innerW: number): { lines: string[]; focusIdx: number } {
		const lines: string[] = [];
		let focusIdx = 0;
		const regularOpts = opts.filter((o) => !o.isOther);
		const otherOpt = opts.find((o) => o.isOther);
		const isDimmed = inputMode;

		for (let i = 0; i < regularOpts.length; i++) {
			const opt = regularOpts[i];
			const isSelected = i === optionIndex && !isDimmed;
			const num = `${i + 1}`;

			if (isSelected) focusIdx = lines.length;

			let badge: string;
			let label: string;

			if (isSelected) {
				badge = theme.fg("accent", theme.bold(`[${num}]`));
				label = theme.fg("accent", theme.bold(opt.label));
			} else if (isDimmed) {
				badge = theme.fg("dim", `[${num}]`);
				label = theme.fg("dim", opt.label);
			} else {
				badge = theme.fg("muted", `[${num}]`);
				label = theme.fg("text", opt.label);
			}

			lines.push(`${" ".repeat(PAD)}${badge}  ${label}`);

			if (opt.description) {
				const descIndent = PAD + 6;
				const descAvail = innerW - descIndent - 1;
				if (descAvail > 10) {
					const bar = theme.fg("dim", "│");
					const wrapped = wrapTextWithAnsi(opt.description, descAvail);
					for (const wl of wrapped) {
						const descText = isDimmed ? theme.fg("dim", wl) : theme.fg("muted", wl);
						lines.push(`${" ".repeat(descIndent)}${bar} ${descText}`);
					}
				}
			}
		}

		if (otherOpt) {
			const sepW = innerW - PAD * 2;
			lines.push(" ".repeat(PAD) + theme.fg("dim", "┄".repeat(Math.max(1, sepW))));

			const otherIdx = opts.length - 1;
			const isSelected = optionIndex === otherIdx && !isDimmed;

			if (isSelected || inputMode) focusIdx = lines.length;

			let badge: string;
			let label: string;

			if (inputMode) {
				badge = theme.fg("accent", theme.bold("[0]"));
				label = theme.fg("accent", theme.bold("✎ Type something…"));
			} else if (isSelected) {
				badge = theme.fg("accent", theme.bold("[0]"));
				label = theme.fg("accent", theme.bold("✎ Type something…"));
			} else {
				badge = theme.fg("dim", "[0]");
				label = theme.fg("dim", "✎ Type something…");
			}

			lines.push(`${" ".repeat(PAD)}${badge}  ${label}`);
		}

		return { lines, focusIdx };
	}

	function renderEditorSection(innerW: number): string[] {
		if (!inputMode) return [];

		const lines: string[] = [];
		lines.push("");
		lines.push(" ".repeat(PAD) + theme.fg("muted", "Your answer:"));

		const editorW = Math.max(10, innerW - PAD * 2);
		for (const line of editor.render(editorW)) {
			lines.push(" ".repeat(PAD) + line);
		}

		lines.push(" ".repeat(PAD) + theme.fg("dim", "Enter to submit · Esc to cancel"));

		return lines;
	}

	function renderSubmitView(_innerW: number): string[] {
		const lines: string[] = [];

		const maxLabelW = Math.max(...questions.map((q) => visibleWidth(q.label)));

		for (const question of questions) {
			const answer = answers.get(question.id);
			const labelPadded = padRight(question.label, maxLabelW);

			if (answer) {
				const prefix = answer.wasCustom ? "(wrote) " : "";
				lines.push(
					`${" ".repeat(PAD)}${theme.fg("success", "✓ ")}` +
						`${theme.fg("muted", labelPadded)} ` +
						`${theme.fg("dim", "│")} ` +
						`${theme.fg("text", prefix + answer.label)}`,
				);
			} else {
				lines.push(
					`${" ".repeat(PAD)}${theme.fg("dim", "○ ")}` +
						`${theme.fg("dim", labelPadded)} ` +
						`${theme.fg("dim", "│ —")}`,
				);
			}
		}

		lines.push("");

		if (allAnswered()) {
			lines.push(" ".repeat(PAD) + theme.fg("success", theme.bold("Ready to submit")));
		} else {
			const missing = questions
				.filter((q) => !answers.has(q.id))
				.map((q) => q.label)
				.join(", ");
			lines.push(" ".repeat(PAD) + theme.fg("warning", `Unanswered: ${missing}`));
		}

		return lines;
	}

	function renderHelp(_innerW: number): string[] {
		const cap = (k: string) => theme.fg("muted", `[${k}]`);
		const lbl = (t: string) => theme.fg("dim", t);

		let help: string;

		if (viewMode === "context") {
			help = [`${cap("j/k")} ${lbl("scroll")}`, `${cap("h/q")} ${lbl("back")}`].join("  ");
		} else if (inputMode) {
			help = `${cap("⏎/C-y")} ${lbl("submit")}  ${cap("Esc")} ${lbl("cancel")}`;
		} else if (currentTab === questions.length) {
			const parts = [
				`${cap("⏎/C-y")} ${lbl("submit")}`,
				`${cap("j/k")} ${lbl("scroll")}`,
				`${cap("⇥/⇧⇥")} ${lbl("switch")}`,
				`${cap("q")} ${lbl("cancel")}`,
			];
			if (hasContext) parts.splice(3, 0, `${cap("l")} ${lbl("context")}`);
			help = parts.join("  ");
		} else if (isMulti) {
			const parts = [
				`${cap("C-n/p")} ${lbl("nav")}`,
				`${cap("j/k")} ${lbl("scroll")}`,
				`${cap("0-9")} ${lbl("pick")}`,
				`${cap("⏎/C-y")} ${lbl("select")}`,
				`${cap("⇥/⇧⇥")} ${lbl("switch")}`,
			];
			if (hasContext) parts.push(`${cap("l")} ${lbl("context")}`);
			help = parts.join("  ");
		} else {
			const parts = [
				`${cap("C-n/p")} ${lbl("nav")}`,
				`${cap("j/k")} ${lbl("scroll")}`,
				`${cap("0-9")} ${lbl("pick")}`,
				`${cap("⏎/C-y")} ${lbl("select")}`,
				`${cap("q")} ${lbl("cancel")}`,
			];
			if (hasContext) parts.splice(4, 0, `${cap("l")} ${lbl("context")}`);
			help = parts.join("  ");
		}

		return [" ".repeat(PAD) + help];
	}

	function renderContextView(innerW: number): { lines: string[]; focusLine: number } {
		if (!contextMessages || contextMessages.length === 0) {
			return { lines: [" ".repeat(PAD) + theme.fg("dim", "(No context available)")], focusLine: 0 };
		}

		const usable = innerW - PAD * 2;

		if (contextBodyCache && contextBodyCache.width === usable) {
			return { lines: contextBodyCache.lines, focusLine: 0 };
		}

		if (usable <= 10) {
			const lines: string[] = [];
			for (const msg of contextMessages) {
				lines.push(" ".repeat(PAD) + theme.fg("text", msg));
			}
			contextBodyCache = { lines, width: usable };
			return { lines, focusLine: 0 };
		}

		const lines: string[] = [];
		const mdTheme = getMarkdownTheme();

		for (let i = 0; i < contextMessages.length; i++) {
			const msg = contextMessages[i];
			const markdown = new Markdown(msg, 0, 0, mdTheme);
			const rendered = markdown.render(usable);

			for (const line of rendered) {
				lines.push(" ".repeat(PAD) + line);
			}

			if (i < contextMessages.length - 1) {
				lines.push("");
				lines.push(" ".repeat(PAD) + theme.fg("dim", "─".repeat(usable)));
				lines.push("");
			}
		}

		contextBodyCache = { lines, width: usable };
		return { lines, focusLine: 0 };
	}

	// ── Main render ──────────────────────────────────────────────────────

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const rows = tui.terminal.rows;
		const innerW = width - 2;
		const q = currentQuestion();
		const opts = currentOptions();

		// ── Build body content ───────────────────────────────────────────
		const body: string[] = [];
		let focusLine = 0;

		if (viewMode === "context") {
			body.push("");
			const { lines: contextLines, focusLine: ctxFocus } = renderContextView(innerW);
			body.push(...contextLines);
			focusLine = ctxFocus;
			body.push("");
		} else {
			if (isMulti) {
				body.push("");
				body.push(...renderTabBar(innerW));
			}

			body.push("");

			if (inputMode && q) {
				body.push(...renderPrompt(q, innerW));
				body.push("");
				const { lines: optLines } = renderOptionsList(opts, innerW);
				body.push(...optLines);
				body.push(...renderEditorSection(innerW));
				focusLine = body.length - 2;
			} else if (currentTab === questions.length) {
				body.push(...renderSubmitView(innerW));
				focusLine = body.length - 1;
			} else if (q) {
				body.push(...renderPrompt(q, innerW));
				body.push("");
				const optStart = body.length;
				const { lines: optLines, focusIdx } = renderOptionsList(opts, innerW);
				body.push(...optLines);
				focusLine = optStart + focusIdx;
			}

			body.push("");
		}

		// ── Compute viewport height ───────────────────────────────────────
		if (fixedBodyHeight === null) {
			const chromeRows = 6 + (isMulti ? 2 : 0);
			const heightMultiplier = viewMode === "context" ? 0.88 : 0.72;
			const maxBody = Math.max(10, Math.floor(rows * heightMultiplier) - chromeRows);
			fixedBodyHeight = viewMode === "context" || isMulti ? maxBody : Math.min(body.length, maxBody);
		}

		// ── Scroll viewport ──────────────────────────────────────────────
		const vh = fixedBodyHeight;
		let canScrollUp = false;
		let canScrollDown = false;

		if (body.length > vh) {
			if (!manualScroll) {
				if (focusLine < scrollOffset + 2) {
					scrollOffset = Math.max(0, focusLine - 2);
				} else if (focusLine >= scrollOffset + vh - 2) {
					scrollOffset = focusLine - vh + 3;
				}
			}
			scrollOffset = Math.max(0, Math.min(scrollOffset, body.length - vh));
			canScrollUp = scrollOffset > 0;
			canScrollDown = scrollOffset + vh < body.length;
		} else {
			scrollOffset = 0;
		}

		const visibleBody = body.slice(scrollOffset, scrollOffset + vh);
		while (visibleBody.length < vh) {
			visibleBody.push("");
		}

		// ── Footer help ──────────────────────────────────────────────────
		const helpLines = renderHelp(innerW);

		// ── Assemble card ────────────────────────────────────────────────
		const lines: string[] = [];

		// Top border
		lines.push(theme.fg("accent", `╭${"─".repeat(Math.max(0, width - 2))}╮`));

		// Banner
		let bannerLabel: string;
		let bannerIcon: string;
		if (viewMode === "context") {
			bannerLabel = "Context";
			bannerIcon = "📜";
		} else if (q != null) {
			bannerLabel = q.label;
			bannerIcon = ICON;
		} else if (currentTab === questions.length) {
			bannerLabel = "Submit";
			bannerIcon = "✓";
		} else {
			bannerLabel = "Question";
			bannerIcon = ICON;
		}
		const bannerText = ` ${bannerIcon} ${theme.bold(bannerLabel)}`;
		const bannerPad = Math.max(0, innerW - visibleWidth(bannerText));
		lines.push(
			theme.fg("accent", "│") + theme.fg("accent", bannerText) + " ".repeat(bannerPad) + theme.fg("accent", "│"),
		);

		// Separator with scroll hint
		const topHint = canScrollUp ? theme.fg("dim", "▲ more") : "";
		const sepInner = innerW - visibleWidth(topHint);
		lines.push(
			theme.fg("accent", "├") +
				theme.fg("dim", "┄".repeat(Math.max(0, sepInner))) +
				topHint +
				theme.fg("accent", "┤"),
		);

		// Body
		for (const content of visibleBody) {
			const contentPad = Math.max(0, innerW - visibleWidth(content));
			lines.push(theme.fg("accent", "│") + content + " ".repeat(contentPad) + theme.fg("accent", "│"));
		}

		// Separator with scroll hint
		const bottomHint = canScrollDown ? theme.fg("dim", "▼ more") : "";
		const sepInner2 = innerW - visibleWidth(bottomHint);
		lines.push(
			theme.fg("accent", "├") +
				theme.fg("dim", "┄".repeat(Math.max(0, sepInner2))) +
				bottomHint +
				theme.fg("accent", "┤"),
		);

		// Help footer
		for (const helpStr of helpLines) {
			const helpPad = Math.max(0, innerW - visibleWidth(helpStr));
			lines.push(theme.fg("accent", "│") + helpStr + " ".repeat(helpPad) + theme.fg("accent", "│"));
		}

		// Bottom border
		lines.push(theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));

		cachedLines = lines;
		return lines;
	}

	// ── Public interface ─────────────────────────────────────────────────
	return {
		render,
		invalidate: () => {
			cachedLines = undefined;
		},
		handleInput,
	};
}
