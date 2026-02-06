import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AnimationScheduler } from "../src/animation-scheduler.js";

type TimerHandle = { id: number; unref: () => void };
type TimerEntry = { at: number; callback: () => void };

describe("AnimationScheduler", () => {
	let now = 0;
	let nextTimerId = 1;
	let timers = new Map<number, TimerEntry>();
	let originalSetTimeout: typeof setTimeout;
	let originalClearTimeout: typeof clearTimeout;
	let originalDateNow: () => number;

	const timerCount = () => timers.size;

	const advance = (ms: number) => {
		const target = now + ms;

		while (true) {
			let nextId: number | undefined;
			let nextAt = Number.POSITIVE_INFINITY;

			for (const [id, timer] of timers.entries()) {
				if (timer.at < nextAt) {
					nextAt = timer.at;
					nextId = id;
				}
			}

			if (nextId === undefined || nextAt > target) {
				now = target;
				return;
			}

			now = nextAt;
			const timer = timers.get(nextId);
			timers.delete(nextId);
			timer?.callback();
		}
	};

	beforeEach(() => {
		now = 0;
		nextTimerId = 1;
		timers = new Map<number, TimerEntry>();
		originalSetTimeout = globalThis.setTimeout;
		originalClearTimeout = globalThis.clearTimeout;
		originalDateNow = Date.now;

		(globalThis.setTimeout as typeof setTimeout) = ((callback: () => void, delay?: number) => {
			const id = nextTimerId++;
			timers.set(id, {
				at: now + Math.max(0, Number(delay ?? 0)),
				callback,
			});
			const handle: TimerHandle = {
				id,
				unref: () => {},
			};
			return handle as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		(globalThis.clearTimeout as typeof clearTimeout) = ((handle: ReturnType<typeof setTimeout>) => {
			const id = (handle as unknown as TimerHandle).id;
			if (typeof id === "number") {
				timers.delete(id);
			}
		}) as typeof clearTimeout;

		(Date as { now: () => number }).now = () => now;
	});

	afterEach(() => {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		(Date as { now: () => number }).now = originalDateNow;
	});

	it("runs multiple intervals from one timer loop", () => {
		let renderBatches = 0;
		const fastTicks: number[] = [];
		const slowTicks: number[] = [];

		const scheduler = new AnimationScheduler(() => {
			renderBatches++;
		});

		scheduler.subscribe((ts) => fastTicks.push(ts), 100);
		scheduler.subscribe((ts) => slowTicks.push(ts), 250);

		advance(1000);

		assert.strictEqual(fastTicks.length, 10);
		assert.strictEqual(slowTicks.length, 4);
		assert.ok(renderBatches >= 10);
		assert.ok(renderBatches <= 14);
	});

	it("fires render hook once per due batch", () => {
		let renderBatches = 0;
		let fast = 0;
		let slow = 0;
		const scheduler = new AnimationScheduler(() => {
			renderBatches++;
		});

		scheduler.subscribe(() => {
			fast++;
		}, 100);
		scheduler.subscribe(() => {
			slow++;
		}, 200);

		advance(200);

		assert.strictEqual(fast, 2);
		assert.strictEqual(slow, 1);
		assert.strictEqual(renderBatches, 2);
	});

	it("unsubscribes and clears timer when no subscribers remain", () => {
		const scheduler = new AnimationScheduler(() => {});
		const unsubscribe = scheduler.subscribe(() => {}, 100);

		assert.strictEqual(timerCount(), 1);
		unsubscribe();
		assert.strictEqual(timerCount(), 0);
	});

	it("pauses and resumes without losing subscribers", () => {
		let ticks = 0;
		const scheduler = new AnimationScheduler(() => {});
		scheduler.subscribe(() => {
			ticks++;
		}, 100);

		advance(100);
		assert.strictEqual(ticks, 1);

		scheduler.pause();
		assert.strictEqual(timerCount(), 0);
		advance(500);
		assert.strictEqual(ticks, 1);

		scheduler.resume();
		advance(0);
		assert.strictEqual(ticks, 2);
	});
});
