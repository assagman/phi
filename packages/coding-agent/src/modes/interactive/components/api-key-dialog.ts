import type { EnvLoginProviderInfo } from "ai";
import { Container, type Focusable, getEditorKeybindings, Input, Spacer, TruncatedText } from "tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

/**
 * Dialog component for entering and storing API keys.
 * Shown when selecting an env-var provider from the /login selector.
 */
export class ApiKeyDialogComponent extends Container implements Focusable {
	private input: Input;
	private hasExistingKey: boolean;

	// Focusable — propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		provider: EnvLoginProviderInfo,
		hasExistingKey: boolean,
		private onSubmit: (key: string) => void,
		private onRemove: () => void,
		private onCancel: () => void,
	) {
		super();
		this.hasExistingKey = hasExistingKey;

		// Top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Title
		this.addChild(new TruncatedText(theme.fg("warning", `Configure ${provider.name}`)));
		this.addChild(new Spacer(1));

		// Status
		if (hasExistingKey) {
			this.addChild(new TruncatedText(theme.fg("success", "  API key stored in credentials file")));
		}
		if (provider.isSet) {
			this.addChild(new TruncatedText(theme.fg("success", `  ${provider.envVar} is set in environment`)));
		}
		if (hasExistingKey || provider.isSet) {
			this.addChild(new Spacer(1));
		}

		// Prompt
		this.addChild(new TruncatedText(theme.fg("text", "  Enter API key:")));

		// Input
		this.input = new Input();
		this.input.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				this.onSubmit(trimmed);
			}
		};
		this.input.onEscape = () => {
			this.onCancel();
		};
		this.addChild(this.input);
		this.addChild(new Spacer(1));

		// Env var hint
		this.addChild(new TruncatedText(theme.fg("dim", `  Or set ${provider.envVar} in your shell profile`)));

		// Remove hint (if stored key exists)
		if (hasExistingKey) {
			this.addChild(new Spacer(1));
			this.addChild(new TruncatedText(`  ${keyHint("deleteCharForward", "to remove stored key")}`));
		}

		this.addChild(new Spacer(1));

		// Action hints
		this.addChild(
			new TruncatedText(`  ${keyHint("selectCancel", "to cancel,")} ${keyHint("selectConfirm", "to save")}`),
		);

		// Bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(data, "selectCancel")) {
			this.onCancel();
			return;
		}

		// Delete key to remove stored key (only when input is empty)
		if (this.hasExistingKey && kb.matches(data, "deleteCharForward") && this.input.getValue() === "") {
			this.onRemove();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
