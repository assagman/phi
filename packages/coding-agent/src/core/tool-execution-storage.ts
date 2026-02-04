/**
 * Tool Execution Storage — SQLite-backed storage for tool execution history.
 *
 * Storage: ~/.local/share/phi/tool-history/<session-id>/tools.db
 * Tables: tool_executions, schema_version
 *
 * Uses bun:sqlite for zero external dependencies.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// ============ Constants ============

export const DB_VERSION = 1;
const LOCAL_SHARE = join(homedir(), ".local", "share", "phi", "tool-history");

// ============ Types ============

export interface ToolExecution {
	id: number;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	resultContent: Array<{ type: string; text?: string }>;
	isError: boolean;
	durationMs: number;
	createdAt: number;
}

export interface CreateToolExecutionInput {
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	resultContent: Array<{ type: string; text?: string }>;
	isError: boolean;
	durationMs: number;
}

export interface ListToolExecutionsOptions {
	sessionId?: string;
	toolName?: string;
	isError?: boolean;
	limit?: number;
	offset?: number;
}

// ============ Database Path Helpers ============

function validatePath(basePath: string, targetPath: string): void {
	const resolvedTarget = resolve(targetPath);
	const resolvedBase = resolve(basePath);
	const rel = relative(resolvedBase, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Invalid database path: path traversal detected");
	}
}

function getDbPath(sessionId: string): string {
	// Use hash-based directory name to avoid collisions from different session IDs
	// that would sanitize to the same string (e.g., "a/b" and "a_b" both -> "a_b")
	// Hash ensures unique, collision-resistant directory names
	const hash = createHash("sha256").update(sessionId).digest("hex").substring(0, 16);
	// Include sanitized prefix for human readability in the filesystem
	const sanitizedPrefix = sessionId
		.replace(/[^a-zA-Z0-9_.-]/g, "_")
		.substring(0, 20)
		.replace(/_+$/, "");
	const dirName = sanitizedPrefix ? `${sanitizedPrefix}_${hash}` : hash;

	const dirPath = join(LOCAL_SHARE, dirName);
	validatePath(LOCAL_SHARE, dirPath);

	if (!existsSync(LOCAL_SHARE)) {
		mkdirSync(LOCAL_SHARE, { recursive: true });
	}
	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, { recursive: true });
	}

	return join(dirPath, "tools.db");
}

function openDatabase(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA synchronous = NORMAL");
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

// ============ Schema ============

function initSchema(db: Database): void {
	ensureSchemaVersion(db, DB_VERSION);

	db.exec(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      args TEXT NOT NULL,
      result_content TEXT NOT NULL,
      is_error INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_name ON tool_executions(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_created ON tool_executions(created_at DESC);
  `);
}

// ============ Storage Class ============

/**
 * Storage for tool execution history.
 * Each session has its own database file.
 */
export class ToolExecutionStorage {
	private db: Database | null = null;
	private sessionId: string;
	private dbPath: string;
	private startTimes = new Map<string, number>();

	constructor(sessionId: string) {
		this.sessionId = sessionId;
		this.dbPath = getDbPath(sessionId);
	}

	private getDb(): Database {
		if (!this.db) {
			this.db = openDatabase(this.dbPath);
			initSchema(this.db);
		}
		return this.db;
	}

	/**
	 * Mark the start of a tool execution (for duration tracking).
	 */
	startExecution(toolCallId: string): void {
		this.startTimes.set(toolCallId, Date.now());
	}

	/**
	 * Record a completed tool execution.
	 */
	recordExecution(
		input: Omit<CreateToolExecutionInput, "sessionId" | "durationMs"> & { durationMs?: number },
	): number {
		const startTime = this.startTimes.get(input.toolCallId);
		const durationMs = input.durationMs ?? (startTime ? Date.now() - startTime : 0);
		this.startTimes.delete(input.toolCallId);

		const db = this.getDb();
		const now = Date.now();

		// Use INSERT OR REPLACE to handle potential duplicates
		const row = db
			.prepare(
				`INSERT OR REPLACE INTO tool_executions 
         (session_id, tool_call_id, tool_name, args, result_content, is_error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
			)
			.get(
				this.sessionId,
				input.toolCallId,
				input.toolName,
				JSON.stringify(input.args),
				JSON.stringify(input.resultContent),
				input.isError ? 1 : 0,
				durationMs,
				now,
			) as { id: number };

		return row.id;
	}

	/**
	 * Get a single tool execution by ID.
	 */
	getExecution(id: number): ToolExecution | null {
		const db = this.getDb();
		const row = db
			.prepare(
				`SELECT id, session_id, tool_call_id, tool_name, args, result_content, is_error, duration_ms, created_at
         FROM tool_executions WHERE id = ?`,
			)
			.get(id) as
			| {
					id: number;
					session_id: string;
					tool_call_id: string;
					tool_name: string;
					args: string;
					result_content: string;
					is_error: number;
					duration_ms: number;
					created_at: number;
			  }
			| undefined;

		if (!row) return null;
		return this.rowToExecution(row);
	}

	/**
	 * Get a tool execution by tool call ID.
	 */
	getExecutionByToolCallId(toolCallId: string): ToolExecution | null {
		const db = this.getDb();
		const row = db
			.prepare(
				`SELECT id, session_id, tool_call_id, tool_name, args, result_content, is_error, duration_ms, created_at
         FROM tool_executions WHERE tool_call_id = ?`,
			)
			.get(toolCallId) as
			| {
					id: number;
					session_id: string;
					tool_call_id: string;
					tool_name: string;
					args: string;
					result_content: string;
					is_error: number;
					duration_ms: number;
					created_at: number;
			  }
			| undefined;

		if (!row) return null;
		return this.rowToExecution(row);
	}

	/**
	 * List tool executions with optional filters.
	 */
	listExecutions(options: ListToolExecutionsOptions = {}): ToolExecution[] {
		const { sessionId, toolName, isError, limit = 100, offset = 0 } = options;

		let sql = `SELECT id, session_id, tool_call_id, tool_name, args, result_content, is_error, duration_ms, created_at
               FROM tool_executions WHERE 1=1`;
		const params: (string | number)[] = [];

		if (sessionId !== undefined) {
			sql += " AND session_id = ?";
			params.push(sessionId);
		}

		if (toolName !== undefined) {
			sql += " AND tool_name = ?";
			params.push(toolName);
		}

		if (isError !== undefined) {
			sql += " AND is_error = ?";
			params.push(isError ? 1 : 0);
		}

		sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
		params.push(limit, offset);

		const db = this.getDb();
		const rows = db.prepare(sql).all(...params) as Array<{
			id: number;
			session_id: string;
			tool_call_id: string;
			tool_name: string;
			args: string;
			result_content: string;
			is_error: number;
			duration_ms: number;
			created_at: number;
		}>;

		return rows.map((row) => this.rowToExecution(row));
	}

	/**
	 * Get count of tool executions.
	 */
	getCount(options: Omit<ListToolExecutionsOptions, "limit" | "offset"> = {}): number {
		const { sessionId, toolName, isError } = options;

		let sql = "SELECT COUNT(*) as count FROM tool_executions WHERE 1=1";
		const params: (string | number)[] = [];

		if (sessionId !== undefined) {
			sql += " AND session_id = ?";
			params.push(sessionId);
		}

		if (toolName !== undefined) {
			sql += " AND tool_name = ?";
			params.push(toolName);
		}

		if (isError !== undefined) {
			sql += " AND is_error = ?";
			params.push(isError ? 1 : 0);
		}

		const db = this.getDb();
		const row = db.prepare(sql).get(...params) as { count: number };
		return row.count;
	}

	/**
	 * Delete old executions, keeping the most recent N.
	 */
	pruneOldExecutions(keepCount: number): number {
		const db = this.getDb();
		const result = db
			.prepare(
				`DELETE FROM tool_executions 
         WHERE id NOT IN (
           SELECT id FROM tool_executions 
           ORDER BY created_at DESC 
           LIMIT ?
         )`,
			)
			.run(keepCount);
		return result.changes;
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.startTimes.clear();
	}

	/**
	 * Get the database file location.
	 */
	getLocation(): string {
		return this.dbPath;
	}

	private rowToExecution(row: {
		id: number;
		session_id: string;
		tool_call_id: string;
		tool_name: string;
		args: string;
		result_content: string;
		is_error: number;
		duration_ms: number;
		created_at: number;
	}): ToolExecution {
		return {
			id: row.id,
			sessionId: row.session_id,
			toolCallId: row.tool_call_id,
			toolName: row.tool_name,
			args: JSON.parse(row.args),
			resultContent: JSON.parse(row.result_content),
			isError: row.is_error === 1,
			durationMs: row.duration_ms,
			createdAt: row.created_at,
		};
	}
}
