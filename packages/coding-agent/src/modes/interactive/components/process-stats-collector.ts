/**
 * Asynchronous process stats collector.
 * Runs on a background timer, fully decoupled from UI rendering.
 */
export interface ProcessStats {
	rss: number;
	cpuPercent: number;
}

const UPDATE_INTERVAL_MS = 1000;

class ProcessStatsCollector {
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastCpuUsage = process.cpuUsage();
	private lastCpuTime = Date.now();
	private stats: ProcessStats = {
		rss: process.memoryUsage().rss,
		cpuPercent: 0,
	};
	private refCount = 0;

	/**
	 * Start the collector. Uses reference counting - multiple calls
	 * increment the count, only stops when count reaches 0.
	 */
	start(): void {
		this.refCount++;
		if (this.timer) return;

		// Collect immediately on start
		this.collect();

		// Schedule background collection
		this.timer = setInterval(() => {
			this.collect();
		}, UPDATE_INTERVAL_MS);

		// Ensure timer doesn't keep process alive
		this.timer.unref();
	}

	/**
	 * Stop the collector. Decrements ref count, only stops when 0.
	 */
	stop(): void {
		this.refCount = Math.max(0, this.refCount - 1);
		if (this.refCount > 0 || !this.timer) return;

		clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Force stop regardless of ref count.
	 */
	forceStop(): void {
		this.refCount = 0;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Get current cached stats. Non-blocking.
	 */
	getStats(): Readonly<ProcessStats> {
		return this.stats;
	}

	private collect(): void {
		const now = Date.now();
		const elapsed = now - this.lastCpuTime;

		// Update memory
		this.stats.rss = process.memoryUsage().rss;

		// Update CPU if enough time elapsed
		if (elapsed >= 100) {
			const currentUsage = process.cpuUsage(this.lastCpuUsage);
			const totalCpuMs = (currentUsage.user + currentUsage.system) / 1000;
			this.stats.cpuPercent = (totalCpuMs / elapsed) * 100;

			this.lastCpuUsage = process.cpuUsage();
			this.lastCpuTime = now;
		}
	}
}

// Singleton instance
export const processStatsCollector = new ProcessStatsCollector();
