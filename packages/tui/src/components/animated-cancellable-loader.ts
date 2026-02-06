import { getEditorKeybindings } from "../keybindings.js";
import { AnimatedLoader } from "./animated-loader.js";

/**
 * Shared-ticker loader that can be cancelled with Escape.
 */
export class AnimatedCancellableLoader extends AnimatedLoader {
	private abortController = new AbortController();

	onAbort?: () => void;

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();
		if (!kb.matches(data, "selectCancel") || this.abortController.signal.aborted) {
			return;
		}
		this.abortController.abort();
		this.onAbort?.();
	}

	override dispose(): void {
		super.dispose();
	}
}
