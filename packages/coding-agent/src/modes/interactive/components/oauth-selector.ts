import { getLoginProviders, type LoginProviderInfo } from "ai";
import { Container, getEditorKeybindings, Spacer, TruncatedText } from "tui";
import type { AuthStorage } from "../../../core/auth-storage.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

/**
 * Provider selector component for /login and /logout.
 * Shows OAuth providers (interactive login) and env-var providers (stored or environment variable).
 */
export class OAuthSelectorComponent extends Container {
	private listContainer: Container;
	private allProviders: LoginProviderInfo[] = [];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private onSelectCallback: (provider: LoginProviderInfo) => void;
	private onCancelCallback: () => void;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (provider: LoginProviderInfo) => void,
		onCancel: () => void,
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.loadProviders();

		// Top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Title
		const title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));

		// List
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Bottom border
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private loadProviders(): void {
		const all = getLoginProviders();
		if (this.mode === "logout") {
			// Logout shows OAuth providers that are logged in AND env providers with stored API keys
			this.allProviders = all.filter((p) => {
				if (p.kind === "oauth") {
					return this.authStorage.get(p.id)?.type === "oauth";
				}
				return this.authStorage.get(p.id)?.type === "api_key";
			});
		} else {
			this.allProviders = all;
		}
	}

	private updateList(): void {
		this.listContainer.clear();

		// Section headers tracking
		let lastKind: "oauth" | "env" | null = null;

		for (let i = 0; i < this.allProviders.length; i++) {
			const provider = this.allProviders[i];
			if (!provider) continue;

			// Section header when switching from OAuth to Env
			if (provider.kind !== lastKind) {
				if (lastKind !== null) {
					this.listContainer.addChild(new Spacer(1));
				}
				const header =
					provider.kind === "oauth"
						? theme.fg("dim", "  OAuth (interactive login)")
						: theme.fg("dim", "  API Key (stored or environment variable)");
				this.listContainer.addChild(new TruncatedText(header, 0, 0));
				lastKind = provider.kind;
			}

			const isSelected = i === this.selectedIndex;
			const line =
				provider.kind === "oauth"
					? this.renderOAuthRow(provider, isSelected)
					: this.renderEnvRow(provider, isSelected);

			this.listContainer.addChild(new TruncatedText(line, 0, 0));
		}

		if (this.allProviders.length === 0) {
			const message =
				this.mode === "login" ? "No providers available" : "No providers configured. Use /login first.";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
		}
	}

	private renderOAuthRow(provider: LoginProviderInfo & { kind: "oauth" }, isSelected: boolean): string {
		const credentials = this.authStorage.get(provider.id);
		const isLoggedIn = credentials?.type === "oauth";
		const status = isLoggedIn ? theme.fg("success", " ✓ logged in") : "";

		if (isSelected) {
			const prefix = theme.fg("accent", "→ ");
			const text = provider.available ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
			return prefix + text + status;
		}
		const text = provider.available ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
		return text + status;
	}

	private renderEnvRow(provider: LoginProviderInfo & { kind: "env" }, isSelected: boolean): string {
		const hasStoredKey = this.authStorage.get(provider.id)?.type === "api_key";
		const status = hasStoredKey
			? theme.fg("success", " ✓ stored")
			: provider.isSet
				? theme.fg("success", " ✓ env")
				: theme.fg("dim", " ✗ not set");
		const envHint = theme.fg("dim", ` (${provider.envVar})`);

		if (isSelected) {
			const prefix = theme.fg("accent", "→ ");
			const text = theme.fg("accent", provider.name);
			return prefix + text + envHint + status;
		}
		return `  ${provider.name}${envHint}${status}`;
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "selectDown")) {
			this.selectedIndex = Math.min(this.allProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "selectConfirm")) {
			const selected = this.allProviders[this.selectedIndex];
			if (!selected) return;

			if (selected.kind === "oauth" && !selected.available) return;

			this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		}
	}
}
