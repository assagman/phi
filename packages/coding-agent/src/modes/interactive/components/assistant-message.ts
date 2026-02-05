import type { AssistantMessage } from "ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * Cached component for a content block (text or thinking).
 * Keyed by content index and type.
 */
interface CachedComponent {
	type: "text" | "thinking" | "thinking-hidden";
	component: Markdown | Text;
	lastContent: string;
}

/**
 * Component that renders a complete assistant message.
 * Reuses Markdown instances during streaming to avoid O(n²) lexer work.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;

	// Cache of components by content index - survives across updateContent calls
	private componentCache = new Map<number, CachedComponent>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		const changed = this.hideThinkingBlock !== hide;
		this.hideThinkingBlock = hide;
		// Clear cache when thinking visibility changes - component types differ
		if (changed) {
			this.componentCache.clear();
		}
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear container (cheap - just removes refs, components stay in cache)
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Track which cache entries we used this round
		const usedIndices = new Set<number>();

		// Render content in order, reusing cached components
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];

			if (content.type === "text" && content.text.trim()) {
				const trimmedText = content.text.trim();
				const cached = this.componentCache.get(i);

				if (cached?.type === "text" && cached.component instanceof Markdown) {
					// Reuse existing Markdown, update if content changed
					if (cached.lastContent !== trimmedText) {
						cached.component.setText(trimmedText);
						cached.lastContent = trimmedText;
					}
					this.contentContainer.addChild(cached.component);
				} else {
					// Create new Markdown and cache it
					const markdown = new Markdown(trimmedText, 1, 0, this.markdownTheme);
					this.componentCache.set(i, { type: "text", component: markdown, lastContent: trimmedText });
					this.contentContainer.addChild(markdown);
				}
				usedIndices.add(i);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				const trimmedThinking = content.thinking.trim();
				// Check if there's text content after this thinking block
				const hasTextAfter = message.content.slice(i + 1).some((c) => c.type === "text" && c.text.trim());

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					const cached = this.componentCache.get(i);
					if (cached?.type === "thinking-hidden" && cached.component instanceof Text) {
						// Reuse existing Text (content is always the same)
						this.contentContainer.addChild(cached.component);
					} else {
						const text = new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0);
						this.componentCache.set(i, { type: "thinking-hidden", component: text, lastContent: "" });
						this.contentContainer.addChild(text);
					}
					if (hasTextAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					const cached = this.componentCache.get(i);

					if (cached?.type === "thinking" && cached.component instanceof Markdown) {
						// Reuse existing Markdown, update if content changed
						if (cached.lastContent !== trimmedThinking) {
							cached.component.setText(trimmedThinking);
							cached.lastContent = trimmedThinking;
						}
						this.contentContainer.addChild(cached.component);
					} else {
						const markdown = new Markdown(trimmedThinking, 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						});
						this.componentCache.set(i, { type: "thinking", component: markdown, lastContent: trimmedThinking });
						this.contentContainer.addChild(markdown);
					}
					this.contentContainer.addChild(new Spacer(1));
				}
				usedIndices.add(i);
			}
		}

		// Prune cache entries for indices no longer in use
		for (const index of this.componentCache.keys()) {
			if (!usedIndices.has(index)) {
				this.componentCache.delete(index);
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
