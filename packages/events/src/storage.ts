/**
 * Event Storage — SQLite + file storage for the event bus.
 *
 * Storage locations:
 * - SQLite: ~/.local/share/phi/events/<session-hash>/events.db
 * - Large files: /tmp/phi-events/<session-hash>/<event-id>.dat
 *
 * Payloads > 64KB are stored as files with path reference in SQLite.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
	CleanupOptions,
	CleanupResult,
	Event,
	EventInput,
	EventQueryOptions,
	EventRecord,
	PayloadType,
	StorageConfig,
} from "./types.js";

// ============ Constants ============

const DB_VERSION = 1;
const DEFAULT_FILE_SIZE_THRESHOLD = 64 * 1024; // 64KB
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============ Path Helpers ============

function getDefaultBaseDir(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return join(home, ".local", "share", "phi", "events");
}

function getDefaultFileStorageDir(): string {
	return join(tmpdir(), "phi-events");
}

function hashSessionId(sessionId: string): string {
	const hash = createHash("sha256").update(sessionId).digest("hex").substring(0, 16);
	const sanitizedPrefix = sessionId
		.replace(/[^a-zA-Z0-9_.-]/g, "_")
		.substring(0, 20)
		.replace(/_+$/, "");
	return sanitizedPrefix ? `${sanitizedPrefix}_${hash}` : hash;
}

function validatePath(basePath: string, targetPath: string): void {
	const resolvedTarget = resolve(targetPath);
	const resolvedBase = resolve(basePath);
	const rel = relative(resolvedBase, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Invalid path: path traversal detected");
	}
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ============ Database Helpers ============

function openDatabase(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	return db;
}

function ensureSchemaVersion(db: Database, targetVersion: number): { current: number; isFresh: boolean } {
	const tableCount = (
		db
			.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.get() as { count: number }
	).count;
	const isFresh = tableCount === 0;

	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
			version INTEGER NOT NULL
		);
	`);

	if (isFresh) {
		db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)").run(targetVersion);
		return { current: targetVersion, isFresh: true };
	}

	const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
	return { current: row?.version ?? 0, isFresh: false };
}

function initSchema(db: Database): void {
	ensureSchemaVersion(db, DB_VERSION);

	db.exec(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL,
			producer TEXT NOT NULL,
			session_id TEXT NOT NULL,
			parent_id INTEGER,
			timestamp INTEGER NOT NULL,
			payload_type TEXT NOT NULL CHECK (payload_type IN ('inline', 'file')),
			payload TEXT NOT NULL,
			meta TEXT NOT NULL DEFAULT '{}',
			FOREIGN KEY (parent_id) REFERENCES events(id) ON DELETE SET NULL
		);

		CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
		CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
		CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_id);
		CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
		CREATE INDEX IF NOT EXISTS idx_events_producer ON events(producer);
	`);
}

// ============ EventStorage Class ============

/**
 * SQLite + file storage for events.
 * Handles payload storage strategy (inline vs file) transparently.
 */
export class EventStorage {
	private db: Database | null = null;
	private readonly sessionId: string;
	private readonly sessionHash: string;
	private readonly dbPath: string;
	private readonly fileDir: string;
	private readonly fileSizeThreshold: number;
	private readonly baseDir: string;
	private readonly fileStorageBaseDir: string;

	constructor(sessionId: string, config: StorageConfig = {}) {
		this.sessionId = sessionId;
		this.sessionHash = hashSessionId(sessionId);
		this.baseDir = config.baseDir ?? getDefaultBaseDir();
		this.fileStorageBaseDir = config.fileStorageDir ?? getDefaultFileStorageDir();
		this.fileSizeThreshold = config.fileSizeThreshold ?? DEFAULT_FILE_SIZE_THRESHOLD;

		// Database path
		const dbDir = join(this.baseDir, this.sessionHash);
		validatePath(this.baseDir, dbDir);
		ensureDir(dbDir);
		this.dbPath = join(dbDir, "events.db");

		// File storage path
		this.fileDir = join(this.fileStorageBaseDir, this.sessionHash);
		validatePath(this.fileStorageBaseDir, this.fileDir);
	}

	private getDb(): Database {
		if (!this.db) {
			this.db = openDatabase(this.dbPath);
			initSchema(this.db);
		}
		return this.db;
	}

	/**
	 * Store an event, returning the assigned ID.
	 */
	insert<T>(input: EventInput<T>): number {
		const db = this.getDb();
		const timestamp = Date.now();
		const payloadJson = JSON.stringify(input.payload);
		const metaJson = JSON.stringify(input.meta ?? {});

		// Determine storage strategy based on payload size
		let payloadType: PayloadType = "inline";
		let storedPayload = payloadJson;

		if (payloadJson.length > this.fileSizeThreshold) {
			payloadType = "file";
			storedPayload = this.writePayloadFile(timestamp, payloadJson);
		}

		const row = db
			.prepare(
				`INSERT INTO events (type, producer, session_id, parent_id, timestamp, payload_type, payload, meta)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 RETURNING id`,
			)
			.get(
				input.type,
				input.producer,
				input.sessionId,
				input.parentId ?? null,
				timestamp,
				payloadType,
				storedPayload,
				metaJson,
			) as { id: number };

		// If we stored as file, update filename with actual event ID
		if (payloadType === "file") {
			const oldPath = storedPayload;
			const newPath = this.getPayloadFilePath(row.id);
			if (existsSync(oldPath)) {
				const content = readFileSync(oldPath, "utf-8");
				writeFileSync(newPath, content, "utf-8");
				unlinkSync(oldPath);
				db.prepare("UPDATE events SET payload = ? WHERE id = ?").run(newPath, row.id);
			}
		}

		return row.id;
	}

	/**
	 * Get a single event by ID.
	 */
	get<T = unknown>(id: number): Event<T> | null {
		const db = this.getDb();
		const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRecord | undefined;

		if (!row) return null;
		return this.hydrateEvent<T>(row);
	}

	/**
	 * Query events with filters.
	 */
	query<T = unknown>(options: EventQueryOptions = {}): Event<T>[] {
		const db = this.getDb();
		const params: (string | number | null)[] = [];
		const conditions: string[] = [];

		if (options.types && options.types.length > 0) {
			const placeholders = options.types.map(() => "?").join(", ");
			conditions.push(`type IN (${placeholders})`);
			params.push(...options.types);
		}

		if (options.producer !== undefined) {
			conditions.push("producer = ?");
			params.push(options.producer);
		}

		if (options.sessionId !== undefined) {
			conditions.push("session_id = ?");
			params.push(options.sessionId);
		}

		if (options.parentId !== undefined) {
			if (options.parentId === null) {
				conditions.push("parent_id IS NULL");
			} else {
				conditions.push("parent_id = ?");
				params.push(options.parentId);
			}
		}

		if (options.since !== undefined) {
			conditions.push("timestamp >= ?");
			params.push(options.since);
		}

		if (options.until !== undefined) {
			conditions.push("timestamp <= ?");
			params.push(options.until);
		}

		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const orderClause = `ORDER BY timestamp ${options.order === "asc" ? "ASC" : "DESC"}`;
		const limitClause = options.limit !== undefined ? `LIMIT ${options.limit}` : "";
		const offsetClause = options.offset !== undefined ? `OFFSET ${options.offset}` : "";

		const sql = `SELECT * FROM events ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`;
		const rows = db.prepare(sql).all(...params) as EventRecord[];

		return rows.map((row) => this.hydrateEvent<T>(row));
	}

	/**
	 * Count events matching query.
	 */
	count(options: Omit<EventQueryOptions, "limit" | "offset" | "order">): number {
		const db = this.getDb();
		const params: (string | number | null)[] = [];
		const conditions: string[] = [];

		if (options.types && options.types.length > 0) {
			const placeholders = options.types.map(() => "?").join(", ");
			conditions.push(`type IN (${placeholders})`);
			params.push(...options.types);
		}

		if (options.producer !== undefined) {
			conditions.push("producer = ?");
			params.push(options.producer);
		}

		if (options.sessionId !== undefined) {
			conditions.push("session_id = ?");
			params.push(options.sessionId);
		}

		if (options.parentId !== undefined) {
			if (options.parentId === null) {
				conditions.push("parent_id IS NULL");
			} else {
				conditions.push("parent_id = ?");
				params.push(options.parentId);
			}
		}

		if (options.since !== undefined) {
			conditions.push("timestamp >= ?");
			params.push(options.since);
		}

		if (options.until !== undefined) {
			conditions.push("timestamp <= ?");
			params.push(options.until);
		}

		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const sql = `SELECT COUNT(*) as count FROM events ${whereClause}`;
		const row = db.prepare(sql).get(...params) as { count: number };

		return row.count;
	}

	/**
	 * Delete events matching query.
	 * Returns cleanup result with counts.
	 */
	delete(options: CleanupOptions): CleanupResult {
		const db = this.getDb();
		const params: (string | number)[] = [];
		const conditions: string[] = [];

		if (options.maxAgeMs !== undefined) {
			const cutoff = Date.now() - options.maxAgeMs;
			conditions.push("timestamp < ?");
			params.push(cutoff);
		}

		if (options.sessionIds && options.sessionIds.length > 0) {
			const placeholders = options.sessionIds.map(() => "?").join(", ");
			conditions.push(`session_id IN (${placeholders})`);
			params.push(...options.sessionIds);
		}

		if (conditions.length === 0) {
			return { eventsDeleted: 0, filesDeleted: 0, sessionsAffected: [] };
		}

		const whereClause = `WHERE ${conditions.join(" AND ")}`;

		// Get events to delete (for file cleanup)
		const toDelete = db
			.prepare(`SELECT id, session_id, payload_type, payload FROM events ${whereClause}`)
			.all(...params) as Array<{
			id: number;
			session_id: string;
			payload_type: string;
			payload: string;
		}>;

		// Collect file paths and sessions
		const filesToDelete: string[] = [];
		const sessionsAffected = new Set<string>();

		for (const row of toDelete) {
			sessionsAffected.add(row.session_id);
			if (row.payload_type === "file" && options.removeFiles !== false) {
				filesToDelete.push(row.payload);
			}
		}

		// Delete events from database
		const result = db.prepare(`DELETE FROM events ${whereClause}`).run(...params);

		// Delete associated files
		let filesDeleted = 0;
		for (const filePath of filesToDelete) {
			try {
				if (existsSync(filePath)) {
					unlinkSync(filePath);
					filesDeleted++;
				}
			} catch {
				// Ignore file deletion errors
			}
		}

		return {
			eventsDeleted: result.changes,
			filesDeleted,
			sessionsAffected: Array.from(sessionsAffected),
		};
	}

	/**
	 * Get all unique session IDs.
	 */
	getSessions(): string[] {
		const db = this.getDb();
		const rows = db.prepare("SELECT DISTINCT session_id FROM events").all() as Array<{ session_id: string }>;
		return rows.map((row) => row.session_id);
	}

	/**
	 * Get children of a parent event.
	 */
	getChildren<T = unknown>(parentId: number): Event<T>[] {
		return this.query<T>({ parentId, order: "asc" });
	}

	/**
	 * Get database file location.
	 */
	getLocation(): string {
		return this.dbPath;
	}

	/**
	 * Get file storage directory.
	 */
	getFileDir(): string {
		return this.fileDir;
	}

	/**
	 * Close database connection.
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	// ============ Private Methods ============

	private writePayloadFile(timestamp: number, content: string): string {
		ensureDir(this.fileDir);
		// Use timestamp as temp filename, will be renamed after insert
		const filePath = join(this.fileDir, `${timestamp}.dat`);
		validatePath(this.fileDir, filePath);
		writeFileSync(filePath, content, "utf-8");
		return filePath;
	}

	private getPayloadFilePath(eventId: number): string {
		ensureDir(this.fileDir);
		const filePath = join(this.fileDir, `${eventId}.dat`);
		validatePath(this.fileDir, filePath);
		return filePath;
	}

	private readPayloadFile(filePath: string): string {
		validatePath(this.fileDir, filePath);
		if (!existsSync(filePath)) {
			throw new Error(`Payload file not found: ${filePath}`);
		}
		return readFileSync(filePath, "utf-8");
	}

	private hydrateEvent<T>(row: EventRecord): Event<T> {
		// SQLite returns snake_case column names, need to map to camelCase.
		// bun:sqlite returns plain objects with snake_case keys.
		const rawRow = row as unknown as {
			session_id?: string;
			parent_id?: number | null;
			payload_type?: PayloadType;
		};
		const sessionId = rawRow.session_id ?? "";
		const parentId = rawRow.parent_id ?? null;
		const payloadType = rawRow.payload_type ?? "inline";

		let payload: T;

		if (payloadType === "file") {
			const content = this.readPayloadFile(row.payload);
			payload = JSON.parse(content) as T;
		} else {
			payload = JSON.parse(row.payload) as T;
		}

		return {
			id: row.id,
			type: row.type,
			producer: row.producer,
			sessionId,
			parentId,
			timestamp: row.timestamp,
			payload,
			meta: JSON.parse(row.meta),
		};
	}
}

// ============ Global Cleanup ============

/**
 * Clean up old event data across all sessions.
 * Useful for periodic maintenance.
 */
export function cleanupAllSessions(config: StorageConfig & CleanupOptions = {}): CleanupResult {
	const baseDir = config.baseDir ?? getDefaultBaseDir();
	const fileStorageDir = config.fileStorageDir ?? getDefaultFileStorageDir();
	const maxAgeMs = config.maxAgeMs ?? DEFAULT_TTL_MS;

	let totalEventsDeleted = 0;
	let totalFilesDeleted = 0;
	const allSessionsAffected = new Set<string>();

	// Clean SQLite databases
	if (existsSync(baseDir)) {
		const sessionDirs = readdirSync(baseDir);
		for (const sessionHash of sessionDirs) {
			const dbPath = join(baseDir, sessionHash, "events.db");
			if (existsSync(dbPath)) {
				try {
					const db = openDatabase(dbPath);
					const cutoff = Date.now() - maxAgeMs;

					// Get sessions before delete
					const sessions = db
						.prepare("SELECT DISTINCT session_id FROM events WHERE timestamp < ?")
						.all(cutoff) as Array<{ session_id: string }>;
					for (const s of sessions) {
						allSessionsAffected.add(s.session_id);
					}

					// Delete old events
					const result = db.prepare("DELETE FROM events WHERE timestamp < ?").run(cutoff);
					totalEventsDeleted += result.changes;

					// Check if database is empty
					const remaining = (db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number }).count;
					db.close();

					// Remove empty session directory
					if (remaining === 0) {
						const sessionDir = join(baseDir, sessionHash);
						rmSync(sessionDir, { recursive: true, force: true });
					}
				} catch {
					// Ignore individual database errors
				}
			}
		}
	}

	// Clean file storage
	if (existsSync(fileStorageDir)) {
		const sessionDirs = readdirSync(fileStorageDir);
		for (const sessionHash of sessionDirs) {
			const sessionDir = join(fileStorageDir, sessionHash);
			try {
				const stat = statSync(sessionDir);
				if (stat.isDirectory()) {
					const files = readdirSync(sessionDir);
					let deletedAll = true;

					for (const file of files) {
						const filePath = join(sessionDir, file);
						const fileStat = statSync(filePath);
						const fileAge = Date.now() - fileStat.mtimeMs;

						if (fileAge > maxAgeMs) {
							unlinkSync(filePath);
							totalFilesDeleted++;
						} else {
							deletedAll = false;
						}
					}

					// Remove empty directory
					if (deletedAll && readdirSync(sessionDir).length === 0) {
						rmSync(sessionDir, { recursive: true, force: true });
					}
				}
			} catch {
				// Ignore individual directory errors
			}
		}
	}

	return {
		eventsDeleted: totalEventsDeleted,
		filesDeleted: totalFilesDeleted,
		sessionsAffected: Array.from(allSessionsAffected),
	};
}
