import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component driven by TUI shared animation ticks.
 */
export class AnimatedLoader extends Text {
	private static readonly INTERVAL_MS = 80;
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private currentFrame = 0;
	private unsubscribeTick?: () => void;
	private coloredFrames: string[];
	private coloredMessage: string;

	constructor(
		private ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
	) {
		super("", 1, 0);
		this.coloredFrames = this.frames.map((frame) => this.spinnerColorFn(frame));
		this.coloredMessage = this.messageColorFn(this.message);
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.stop();
		this.updateDisplay();
		this.unsubscribeTick = this.ui.subscribeToAnimationTicks(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, AnimatedLoader.INTERVAL_MS);
		this.ui.requestRender();
	}

	stop(): void {
		if (!this.unsubscribeTick) return;
		this.unsubscribeTick();
		this.unsubscribeTick = undefined;
	}

	setMessage(message: string): void {
		if (this.message === message) {
			return;
		}
		this.message = message;
		this.coloredMessage = this.messageColorFn(message);
		this.updateDisplay();
		this.ui.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.coloredFrames = this.frames.map((frame) => this.spinnerColorFn(frame));
		this.coloredMessage = this.messageColorFn(this.message);
		this.updateDisplay();
	}

	dispose(): void {
		this.stop();
	}

	private updateDisplay(): void {
		const frame = this.coloredFrames[this.currentFrame];
		this.setText(`${frame} ${this.coloredMessage}`);
	}
}
