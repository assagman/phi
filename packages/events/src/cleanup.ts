/**
 * Event Cleanup Utility — TTL-based expiration and maintenance.
 *
 * Features:
 * - Automatic cleanup of old events based on TTL
 * - Session-specific cleanup
 * - Periodic cleanup scheduler
 * - Storage space reclamation
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAllSessions, EventStorage } from "./storage.js";
import type { CleanupOptions, CleanupResult, StorageConfig } from "./types.js";

// ============ Constants ============

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ============ Types ============

export interface CleanupSchedulerOptions extends StorageConfig {
	/** TTL for events in milliseconds (default: 24 hours) */
	ttlMs?: number;
	/** Cleanup interval in milliseconds (default: 1 hour) */
	intervalMs?: number;
	/** Callback invoked after each cleanup */
	onCleanup?: (result: CleanupResult) => void;
}

// ============ EventCleaner Class ============

/**
 * Utility for cleaning up old events from a specific session.
 */
export class EventCleaner {
	private storage: EventStorage;
	private ttlMs: number;

	constructor(sessionId: string, config: StorageConfig & { ttlMs?: number } = {}) {
		this.storage = new EventStorage(sessionId, config);
		this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
	}

	/**
	 * Clean up events older than TTL.
	 */
	cleanupOld(): CleanupResult {
		return this.storage.delete({
			maxAgeMs: this.ttlMs,
			removeFiles: true,
		});
	}

	/**
	 * Clean up all events for this session.
	 */
	cleanupAll(): CleanupResult {
		return this.storage.delete({
			maxAgeMs: 0, // Everything is older than 0ms ago
			removeFiles: true,
		});
	}

	/**
	 * Clean up events matching specific criteria.
	 */
	cleanup(options: CleanupOptions): CleanupResult {
		return this.storage.delete(options);
	}

	/**
	 * Get cleanup statistics.
	 */
	getStats(): { eventCount: number; oldEventCount: number; sessions: string[] } {
		const cutoff = Date.now() - this.ttlMs;
		const eventCount = this.storage.count({});
		const oldEventCount = this.storage.count({ until: cutoff });
		const sessions = this.storage.getSessions();

		return {
			eventCount,
			oldEventCount,
			sessions,
		};
	}

	/**
	 * Close resources.
	 */
	close(): void {
		this.storage.close();
	}
}

// ============ CleanupScheduler Class ============

/**
 * Scheduler for periodic cleanup of all event sessions.
 */
export class CleanupScheduler {
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private readonly config: StorageConfig;
	private readonly ttlMs: number;
	private readonly intervalMs: number;
	private readonly onCleanup?: (result: CleanupResult) => void;

	constructor(options: CleanupSchedulerOptions = {}) {
		this.config = options;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.intervalMs = options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
		this.onCleanup = options.onCleanup;
	}

	/**
	 * Start the periodic cleanup scheduler.
	 */
	start(): void {
		if (this.intervalId) return;

		// Run cleanup immediately on start
		this.runCleanup();

		// Schedule periodic cleanup
		this.intervalId = setInterval(() => {
			this.runCleanup();
		}, this.intervalMs);

		// Don't prevent process exit
		if (this.intervalId.unref) {
			this.intervalId.unref();
		}
	}

	/**
	 * Stop the periodic cleanup scheduler.
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/**
	 * Run cleanup manually.
	 */
	runCleanup(): CleanupResult {
		const result = cleanupAllSessions({
			...this.config,
			maxAgeMs: this.ttlMs,
		});

		if (this.onCleanup) {
			this.onCleanup(result);
		}

		return result;
	}

	/**
	 * Check if scheduler is running.
	 */
	isRunning(): boolean {
		return this.intervalId !== null;
	}
}

// ============ Utility Functions ============

/**
 * Clean up old events across all sessions.
 * Convenience function wrapping cleanupAllSessions.
 */
export function cleanup(options: StorageConfig & { maxAgeMs?: number } = {}): CleanupResult {
	return cleanupAllSessions({
		...options,
		maxAgeMs: options.maxAgeMs ?? DEFAULT_TTL_MS,
	});
}

/**
 * Clean up orphaned file storage directories.
 * Removes directories that no longer have corresponding database entries.
 */
export function cleanupOrphanedFiles(config: StorageConfig = {}): { dirsRemoved: number; filesRemoved: number } {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const baseDir = config.baseDir ?? join(home, ".local", "share", "phi", "events");
	const fileStorageDir = config.fileStorageDir ?? join(tmpdir(), "phi-events");

	let dirsRemoved = 0;
	let filesRemoved = 0;

	// Get valid session hashes from database directories
	const validSessionHashes = new Set<string>();
	if (existsSync(baseDir)) {
		const dbDirs = readdirSync(baseDir);
		for (const dir of dbDirs) {
			const dbPath = join(baseDir, dir, "events.db");
			if (existsSync(dbPath)) {
				validSessionHashes.add(dir);
			}
		}
	}

	// Clean up orphaned file storage directories
	if (existsSync(fileStorageDir)) {
		const fileDirs = readdirSync(fileStorageDir);
		for (const dir of fileDirs) {
			if (!validSessionHashes.has(dir)) {
				const dirPath = join(fileStorageDir, dir);
				try {
					const stat = statSync(dirPath);
					if (stat.isDirectory()) {
						// Count files before removal
						const files = readdirSync(dirPath);
						filesRemoved += files.length;

						rmSync(dirPath, { recursive: true, force: true });
						dirsRemoved++;
					}
				} catch {
					// Ignore errors
				}
			}
		}
	}

	return { dirsRemoved, filesRemoved };
}

/**
 * Get storage usage statistics.
 */
export function getStorageStats(config: StorageConfig = {}): {
	dbCount: number;
	dbTotalBytes: number;
	fileCount: number;
	fileTotalBytes: number;
} {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const baseDir = config.baseDir ?? join(home, ".local", "share", "phi", "events");
	const fileStorageDir = config.fileStorageDir ?? join(tmpdir(), "phi-events");

	let dbCount = 0;
	let dbTotalBytes = 0;
	let fileCount = 0;
	let fileTotalBytes = 0;

	// Count databases
	if (existsSync(baseDir)) {
		const dbDirs = readdirSync(baseDir);
		for (const dir of dbDirs) {
			const dbPath = join(baseDir, dir, "events.db");
			if (existsSync(dbPath)) {
				dbCount++;
				try {
					const stat = statSync(dbPath);
					dbTotalBytes += stat.size;

					// Also count WAL file if present
					const walPath = `${dbPath}-wal`;
					if (existsSync(walPath)) {
						dbTotalBytes += statSync(walPath).size;
					}
				} catch {
					// Ignore stat errors
				}
			}
		}
	}

	// Count files
	if (existsSync(fileStorageDir)) {
		const fileDirs = readdirSync(fileStorageDir);
		for (const dir of fileDirs) {
			const dirPath = join(fileStorageDir, dir);
			try {
				const stat = statSync(dirPath);
				if (stat.isDirectory()) {
					const files = readdirSync(dirPath);
					for (const file of files) {
						const filePath = join(dirPath, file);
						const fileStat = statSync(filePath);
						if (fileStat.isFile()) {
							fileCount++;
							fileTotalBytes += fileStat.size;
						}
					}
				}
			} catch {
				// Ignore errors
			}
		}
	}

	return {
		dbCount,
		dbTotalBytes,
		fileCount,
		fileTotalBytes,
	};
}

/**
 * Format bytes as human-readable string.
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exp;
	return `${value.toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`;
}
