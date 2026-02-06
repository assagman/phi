export type AnimationTickCallback = (now: number) => void;

type Subscriber = {
	callback: AnimationTickCallback;
	intervalMs: number;
	nextAt: number;
};

/**
 * Shared animation scheduler for TUI components.
 *
 * Uses a single timer and per-subscriber intervals to avoid setInterval fan-out.
 */
export class AnimationScheduler {
	private subscribers = new Map<number, Subscriber>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nextSubscriberId = 1;
	private timerTargetAt: number | null = null;
	private paused = false;

	constructor(private readonly onBatchTick: () => void) {}

	subscribe(callback: AnimationTickCallback, intervalMs: number): () => void {
		const normalizedInterval = Math.max(1, Math.floor(intervalMs));
		const now = Date.now();
		const id = this.nextSubscriberId++;

		this.subscribers.set(id, {
			callback,
			intervalMs: normalizedInterval,
			nextAt: now + normalizedInterval,
		});

		this.scheduleNext();

		return () => {
			if (!this.subscribers.delete(id)) {
				return;
			}
			if (this.subscribers.size === 0) {
				this.clearTimer();
				return;
			}
			this.scheduleNext();
		};
	}

	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.clearTimer();
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.scheduleNext();
	}

	stop(): void {
		this.clearTimer();
		this.subscribers.clear();
		this.paused = true;
	}

	private runDueCallbacks(): void {
		this.timer = null;
		this.timerTargetAt = null;

		if (this.paused || this.subscribers.size === 0) {
			return;
		}

		const now = Date.now();
		let ranAnyCallback = false;

		for (const subscriber of this.subscribers.values()) {
			if (subscriber.nextAt > now) {
				continue;
			}

			ranAnyCallback = true;
			try {
				subscriber.callback(now);
			} catch {
				// Keep scheduler alive even if one callback throws.
			}

			const elapsedMs = now - subscriber.nextAt;
			const missedTicks = Math.floor(elapsedMs / subscriber.intervalMs) + 1;
			subscriber.nextAt += missedTicks * subscriber.intervalMs;
		}

		if (ranAnyCallback) {
			this.onBatchTick();
		}

		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (this.paused || this.subscribers.size === 0) {
			this.clearTimer();
			return;
		}

		const now = Date.now();
		let nextAt = Number.POSITIVE_INFINITY;

		for (const subscriber of this.subscribers.values()) {
			nextAt = Math.min(nextAt, subscriber.nextAt);
		}

		if (!Number.isFinite(nextAt)) {
			this.clearTimer();
			return;
		}

		if (this.timer && this.timerTargetAt === nextAt) {
			return;
		}

		this.clearTimer();
		const delayMs = Math.max(0, nextAt - now);
		this.timerTargetAt = nextAt;
		this.timer = setTimeout(() => {
			this.runDueCallbacks();
		}, delayMs);
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (!this.timer) {
			this.timerTargetAt = null;
			return;
		}
		clearTimeout(this.timer);
		this.timer = null;
		this.timerTargetAt = null;
	}
}
