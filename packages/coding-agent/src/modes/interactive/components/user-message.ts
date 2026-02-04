import { Container, Markdown, type MarkdownTheme, Spacer } from "tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * Component that renders a user message with markdown
 */
export class UserMessageComponent extends Container {
	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(text, 1, 0, markdownTheme, {
				color: (text: string) => theme.fg("userMessageText", text),
			}),
		);
	}
}
