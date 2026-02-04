/**
 * Delta — Unified memory database layer.
 *
 * Storage: ~/.local/share/phi/<repo-id>/delta.db
 * Tables:  memories (single table), memories_fts (FTS5 virtual table), schema_version
 */

import type { Database } from "bun:sqlite";
import { ensureSchemaVersion, escapeLike, getBuiltinDbPath, openDatabase, stampSchemaVersion } from "../storage.js";

// ============ Constants ============

/**
 * Schema version. Increment when the schema changes.
 * - v4: unified memories table + FTS5 (current)
 */
export const DB_VERSION = 4;

// ============ Types ============

export type Importance = "low" | "normal" | "high" | "critical";

export interface Memory {
	id: number;
	content: string;
	tags: string[];
	importance: Importance;
	context: string | null;
	session_id: string | null;
	created_at: number;
	updated_at: number;
	last_accessed: number;
}

export interface SearchOptions {
	/** FTS5 full-text search query */
	query?: string;
	/** Filter by tags (OR semantics — matches if any tag present) */
	tags?: string[];
	/** Filter by exact importance level */
	importance?: Importance;
	/** Max results (default: 50) */
	limit?: number;
	/** Only memories created after this timestamp */
	since?: number;
	/** Only current session */
	sessionOnly?: boolean;
}

export interface UpdateInput {
	content?: string;
	tags?: string[];
	importance?: Importance;
	context?: string;
}

// ============ State ============

let db: Database | null = null;
let currentSessionId: string | null = null;
let currentDbPath: string | null = null;

function generateSessionId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getSessionId(): string {
	if (!currentSessionId) {
		currentSessionId = generateSessionId();
	}
	return currentSessionId;
}

export function resetSession(): void {
	currentSessionId = null;
}

// ============ Database Lifecycle ============

export function getDb(): Database {
	const dbPath = getBuiltinDbPath("delta");

	// Reopen if path changed (e.g., cwd changed)
	if (db && currentDbPath !== dbPath) {
		db.close();
		db = null;
	}

	if (!db) {
		currentDbPath = dbPath;
		db = openDatabase(dbPath);
		initSchema();
	}
	return db;
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
		currentDbPath = null;
	}
}

export function getDbLocation(): string {
	return getBuiltinDbPath("delta");
}

/** @internal Test-only: reset module state */
export function _testReset(): void {
	if (db) {
		db.close();
		db = null;
	}
	currentDbPath = null;
	currentSessionId = null;
}

// ============ Schema ============

function initSchema(): void {
	if (!db) throw new Error("Database not initialized");

	const { current, isFresh } = ensureSchemaVersion(db, DB_VERSION);

	if (!isFresh && current < DB_VERSION) {
		migrateSchema(current);
	}

	// Create v4 tables (idempotent)
	createMemoriesTable(db);
	createFts5(db);

	// Clean up any lingering v3 artifacts
	cleanupV3Artifacts(db);
}

function createMemoriesTable(database: Database): void {
	database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      tags TEXT,
      importance TEXT NOT NULL DEFAULT 'normal',
      context TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
  `);
}

function createFts5(database: Database): void {
	const ftsExists = database
		.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='memories_fts'")
		.get() as { c: number };

	if (ftsExists.c === 0) {
		database.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        context,
        content=memories,
        content_rowid=id
      );
    `);
	}

	database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END;
  `);
}

function rebuildFtsIndex(database: Database): void {
	database.exec(`
    INSERT INTO memories_fts(rowid, content, tags, context)
    SELECT id, content, tags, context FROM memories;
  `);
}

function cleanupV3Artifacts(database: Database): void {
	database.exec(`
    DROP TRIGGER IF EXISTS mi_note_insert;
    DROP TRIGGER IF EXISTS mi_note_update;
    DROP TRIGGER IF EXISTS mi_note_delete;
    DROP TRIGGER IF EXISTS mi_episode_insert;
    DROP TRIGGER IF EXISTS mi_episode_update;
    DROP TRIGGER IF EXISTS mi_episode_delete;
    DROP TRIGGER IF EXISTS mi_kv_insert;
    DROP TRIGGER IF EXISTS mi_kv_update;
    DROP TRIGGER IF EXISTS mi_kv_delete;
  `);
	database.exec(`
    DROP TABLE IF EXISTS memory_index;
    DROP TABLE IF EXISTS project_notes;
    DROP TABLE IF EXISTS episodes;
    DROP TABLE IF EXISTS kv;
  `);
}

// ============ Migration ============

function migrateSchema(currentVersion: number): void {
	if (!db) throw new Error("Database not initialized");
	if (currentVersion >= DB_VERSION) return;

	const database = db;
	const txn = database.transaction(() => {
		if (currentVersion < 4) {
			migrateV3toV4(database);
		}
		stampSchemaVersion(database, DB_VERSION);
	});
	txn();
}

function tableExists(database: Database, name: string): boolean {
	const row = database.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?").get(name) as {
		c: number;
	};
	return row.c > 0;
}

function migrateV3toV4(database: Database): void {
	createMemoriesTable(database);

	if (tableExists(database, "episodes")) {
		database.exec(`
      INSERT INTO memories (content, tags, importance, context, session_id, created_at, updated_at, last_accessed)
      SELECT
        content,
        tags,
        'normal',
        context,
        session_id,
        timestamp,
        timestamp,
        last_accessed
      FROM episodes;
    `);
	}

	if (tableExists(database, "project_notes")) {
		database.exec(`
      INSERT INTO memories (content, tags, importance, context, session_id, created_at, updated_at, last_accessed)
      SELECT
        title || char(10) || char(10) || content,
        CASE
          WHEN active = 0 THEN json_array(category, 'archived')
          ELSE json_array(category)
        END,
        importance,
        NULL,
        NULL,
        created_at,
        updated_at,
        last_accessed
      FROM project_notes;
    `);
	}

	if (tableExists(database, "kv")) {
		database.exec(`
      INSERT INTO memories (content, tags, importance, context, session_id, created_at, updated_at, last_accessed)
      SELECT
        key || ': ' || value,
        json_array('kv', key),
        'normal',
        NULL,
        NULL,
        created_at,
        updated_at,
        last_accessed
      FROM kv;
    `);
	}

	cleanupV3Artifacts(database);

	const ftsExists = database
		.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='memories_fts'")
		.get() as { c: number };
	if (ftsExists.c === 0) {
		database.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        context,
        content=memories,
        content_rowid=id
      );
    `);
	}
	rebuildFtsIndex(database);

	database.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END;
  `);
}

// ============ CRUD Operations ============

export function remember(
	content: string,
	opts?: {
		tags?: string[];
		importance?: Importance;
		context?: string;
		sessionId?: string;
	},
): number {
	const now = Date.now();
	const row = getDb()
		.prepare(
			`INSERT INTO memories (content, tags, importance, context, session_id, created_at, updated_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
		)
		.get(
			content,
			opts?.tags ? JSON.stringify(opts.tags) : null,
			opts?.importance ?? "normal",
			opts?.context ?? null,
			opts?.sessionId ?? getSessionId(),
			now,
			now,
			now,
		) as { id: number };
	return row.id;
}

export function search(opts?: SearchOptions): Memory[] {
	const database = getDb();
	const limit = opts?.limit ?? 50;

	if (opts?.query && opts.query.trim().length > 0) {
		return ftsSearch(database, opts, limit);
	}

	return filteredSearch(database, opts, limit);
}

/** Raw row from SQLite before parsing tags JSON */
interface RawMemoryRow {
	id: number;
	content: string;
	tags: string | null;
	importance: string;
	context: string | null;
	session_id: string | null;
	created_at: number;
	updated_at: number;
	last_accessed: number;
}

function parseMemoryRow(row: RawMemoryRow): Memory {
	return {
		id: row.id,
		content: row.content,
		tags: row.tags ? JSON.parse(row.tags) : [],
		importance: row.importance as Importance,
		context: row.context,
		session_id: row.session_id,
		created_at: row.created_at,
		updated_at: row.updated_at,
		last_accessed: row.last_accessed,
	};
}

function touchAccessedMemories(database: Database, rows: RawMemoryRow[]): void {
	if (rows.length === 0) return;
	const now = Date.now();
	const ids = rows.map((r) => r.id);
	database
		.prepare(`UPDATE memories SET last_accessed = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
		.run(now, ...ids);
}

function sanitizeFtsQuery(query: string): string {
	const terms = query
		.replace(/[":*(){}[\]^~|&!]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
	if (terms.length === 0) return "";
	return terms.map((t) => `"${t}"`).join(" ");
}

function ftsSearch(database: Database, opts: SearchOptions, limit: number): Memory[] {
	const ftsQuery = sanitizeFtsQuery(opts.query ?? "");
	if (!ftsQuery) return filteredSearch(database, opts, limit);

	let sql = `
    SELECT m.id, m.content, m.tags, m.importance, m.context, m.session_id,
           m.created_at, m.updated_at, m.last_accessed
    FROM memories m
    JOIN memories_fts ON memories_fts.rowid = m.id
    WHERE memories_fts MATCH ?
  `;
	const params: (string | number)[] = [ftsQuery];

	sql += buildFilterClauses(opts, params, "m.");

	sql += " ORDER BY rank LIMIT ?";
	params.push(limit);

	let rows: RawMemoryRow[];
	try {
		rows = database.prepare(sql).all(...params) as RawMemoryRow[];
	} catch {
		return likeSearch(database, opts, limit);
	}

	touchAccessedMemories(database, rows);
	return rows.map(parseMemoryRow);
}

function filteredSearch(database: Database, opts: SearchOptions | undefined, limit: number): Memory[] {
	let sql = `
    SELECT id, content, tags, importance, context, session_id,
           created_at, updated_at, last_accessed
    FROM memories WHERE 1=1
  `;
	const params: (string | number)[] = [];

	if (opts) {
		sql += buildFilterClauses(opts, params);
	}

	sql += ` ORDER BY
    CASE importance WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
    updated_at DESC
    LIMIT ?`;
	params.push(limit);

	const rows = database.prepare(sql).all(...params) as RawMemoryRow[];
	touchAccessedMemories(database, rows);
	return rows.map(parseMemoryRow);
}

function likeSearch(database: Database, opts: SearchOptions, limit: number): Memory[] {
	const query = opts.query ?? "";
	let sql = `
    SELECT id, content, tags, importance, context, session_id,
           created_at, updated_at, last_accessed
    FROM memories WHERE content LIKE ?
  `;
	const params: (string | number)[] = [`%${escapeLike(query)}%`];

	sql += buildFilterClauses(opts, params);

	sql += " ORDER BY updated_at DESC LIMIT ?";
	params.push(limit);

	const rows = database.prepare(sql).all(...params) as RawMemoryRow[];
	touchAccessedMemories(database, rows);
	return rows.map(parseMemoryRow);
}

function buildFilterClauses(opts: SearchOptions, params: (string | number)[], prefix = ""): string {
	let sql = "";
	const p = prefix;

	if (opts.tags && opts.tags.length > 0) {
		const tagConditions = opts.tags.map(() => `${p}tags LIKE ? ESCAPE '\\'`).join(" OR ");
		sql += ` AND (${tagConditions})`;
		for (const tag of opts.tags) {
			params.push(`%"${escapeLike(tag)}"%`);
		}
	}

	if (opts.importance) {
		sql += ` AND ${p}importance = ?`;
		params.push(opts.importance);
	}

	if (opts.since) {
		sql += ` AND ${p}created_at >= ?`;
		params.push(opts.since);
	}

	if (opts.sessionOnly) {
		sql += ` AND ${p}session_id = ?`;
		params.push(getSessionId());
	}

	return sql;
}

export function forget(id: number): boolean {
	const row = getDb().prepare("DELETE FROM memories WHERE id = ? RETURNING id").get(id) as { id: number } | undefined;
	return row !== undefined;
}

export function update(id: number, input: UpdateInput): boolean {
	const updates: string[] = [];
	const params: (string | number)[] = [];

	if (input.content !== undefined) {
		updates.push("content = ?");
		params.push(input.content);
	}
	if (input.tags !== undefined) {
		updates.push("tags = ?");
		params.push(JSON.stringify(input.tags));
	}
	if (input.importance !== undefined) {
		updates.push("importance = ?");
		params.push(input.importance);
	}
	if (input.context !== undefined) {
		updates.push("context = ?");
		params.push(input.context);
	}

	if (updates.length === 0) return false;

	updates.push("updated_at = ?");
	params.push(Date.now());
	params.push(id);

	const row = getDb()
		.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE id = ? RETURNING id`)
		.get(...params) as { id: number } | undefined;
	return row !== undefined;
}

export function getById(id: number): Memory | null {
	const row = getDb()
		.prepare(
			`SELECT id, content, tags, importance, context, session_id,
              created_at, updated_at, last_accessed
       FROM memories WHERE id = ?`,
		)
		.get(id) as RawMemoryRow | undefined;

	if (!row) return null;
	return parseMemoryRow(row);
}

// ============ Bulk Operations ============

export function getAllMemories(): Memory[] {
	const rows = getDb()
		.prepare(
			`SELECT id, content, tags, importance, context, session_id,
              created_at, updated_at, last_accessed
       FROM memories ORDER BY updated_at DESC`,
		)
		.all() as RawMemoryRow[];
	return rows.map(parseMemoryRow);
}

export function batchDeleteMemories(ids: number[]): number {
	if (ids.length === 0) return 0;
	const database = getDb();
	const placeholders = ids.map(() => "?").join(",");
	const result = database.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
	return result.changes;
}

// ============ Memory Context & Prompt ============

export interface MemoryContext {
	memories: Memory[];
	important: Memory[];
	total: number;
}

export function getMemoryContext(): MemoryContext {
	const database = getDb();

	const total = (database.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;

	const memories = database
		.prepare(
			`SELECT id, content, tags, importance, context, session_id,
              created_at, updated_at, last_accessed
       FROM memories
       ORDER BY
         CASE importance WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
         updated_at DESC
       LIMIT 100`,
		)
		.all() as RawMemoryRow[];

	const important = database
		.prepare(
			`SELECT id, content, tags, importance, context, session_id,
              created_at, updated_at, last_accessed
       FROM memories
       WHERE importance IN ('high', 'critical')
       ORDER BY
         CASE importance WHEN 'critical' THEN 2 WHEN 'high' THEN 1 ELSE 0 END DESC,
         updated_at DESC
       LIMIT 50`,
		)
		.all() as RawMemoryRow[];

	return {
		memories: memories.map(parseMemoryRow),
		important: important.map(parseMemoryRow),
		total,
	};
}

// ============ Awareness Classification (for memory map) ============

type AwarenessCategory =
	| "decisions"
	| "preferences"
	| "environment"
	| "workflows"
	| "conventions"
	| "architecture"
	| "issues"
	| "explorations"
	| "commits"
	| "other";

const AWARENESS_DISPLAY: [AwarenessCategory, string][] = [
	["decisions", "Decisions"],
	["preferences", "Preferences"],
	["environment", "Environment"],
	["workflows", "Workflows"],
	["conventions", "Conventions"],
	["architecture", "Architecture"],
	["issues", "Issues"],
	["explorations", "Explorations"],
	["commits", "Commits"],
	["other", "Other"],
];

function classifyMemory(memory: Memory): AwarenessCategory {
	const tags = memory.tags;
	if (tags.includes("commit") || tags.includes("auto-captured")) return "commits";
	if (tags.includes("decision")) return "decisions";
	if (tags.includes("preference") || tags.includes("pref")) return "preferences";
	if (tags.includes("environment") || tags.includes("env")) return "environment";
	if (tags.includes("workflow")) return "workflows";
	if (tags.includes("convention") || tags.includes("approach")) return "conventions";
	if (tags.includes("architecture")) return "architecture";
	if (tags.includes("issue") || tags.includes("bug") || tags.includes("gotcha") || tags.includes("reminder"))
		return "issues";
	if (tags.includes("exploration")) return "explorations";
	return "other";
}

function truncateStr(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface AwarenessCategoryGroup {
	count: number;
	keywords: string[];
}

function buildAwarenessMap(memories: Memory[]): Map<AwarenessCategory, AwarenessCategoryGroup> {
	const groups = new Map<AwarenessCategory, { count: number; kwSet: Set<string> }>();

	for (const memory of memories) {
		const category = classifyMemory(memory);
		if (!groups.has(category)) {
			groups.set(category, { count: 0, kwSet: new Set() });
		}
		const g = groups.get(category);
		if (!g) continue;
		g.count++;
		const firstLine = memory.content.split("\n")[0].trim();
		if (firstLine && g.kwSet.size < 3) {
			g.kwSet.add(truncateStr(firstLine, 25));
		}
	}

	return new Map([...groups.entries()].map(([cat, g]) => [cat, { count: g.count, keywords: [...g.kwSet] }]));
}

function formatMemoryMap(memories: Memory[]): string[] {
	if (memories.length === 0) return [];

	const map = buildAwarenessMap(memories);
	const lines: string[] = [];

	lines.push("## Memory Map");

	for (const [cat, label] of AWARENESS_DISPLAY) {
		const group = map.get(cat);
		if (!group || group.count === 0) continue;
		const kwStr = group.keywords.length > 0 ? ` (${group.keywords.join(", ")})` : "";
		lines.push(`  ${label}: ${group.count}${kwStr}`);
	}

	lines.push("");
	lines.push("Retrieve: delta_search(query/tags) · delta_remember(content) · delta_forget(id)");

	return lines;
}

// ============ Prompt Building ============

export interface PromptOptions {
	ctx?: MemoryContext;
	sessionWrites?: number;
	turnsIdle?: number;
}

export function buildMemoryPrompt(options: PromptOptions = {}): string {
	const ctx = options.ctx ?? getMemoryContext();
	const writes = options.sessionWrites ?? 0;
	const idle = options.turnsIdle ?? 0;
	const lines: string[] = [];

	lines.push("<delta_memory>");
	lines.push("");

	lines.push("## Memory (mandatory)");
	lines.push("- **BEFORE** work: delta_search(query) to check past context");
	lines.push("- **AFTER** decisions, bugs, patterns: delta_remember(content, tags) to persist knowledge");
	const idleStr = idle > 0 ? `${idle} turns idle` : "active";
	lines.push(`- Status: ${writes} writes this session · ${idleStr}`);
	lines.push("");

	if (ctx.important.length > 0) {
		lines.push("## Critical Knowledge (auto-loaded)");
		lines.push("");
		for (const mem of ctx.important) {
			const imp = ` [${mem.importance.toUpperCase()}]`;
			const tagStr = mem.tags.length > 0 ? ` {${mem.tags.join(", ")}}` : "";
			lines.push(`### Memory #${mem.id}${imp}${tagStr}`);
			lines.push(mem.content);
			lines.push("");
		}
	}

	const mapLines = formatMemoryMap(ctx.memories);
	if (mapLines.length > 0) {
		lines.push(...mapLines);
		lines.push("");
	}

	lines.push("</delta_memory>");

	return lines.join("\n");
}

// ============ Compatibility Shim ============

/** @deprecated Use remember(). Compatibility shim for git commit auto-capture. */
export function logEpisode(content: string, context?: string, tags?: string[]): number {
	return remember(content, { tags, context });
}

// ============ Version & Schema Info ============

export interface VersionInfo {
	current: number | null;
	shipped: number;
	match: boolean;
}

export function getVersionInfo(): VersionInfo {
	const database = getDb();
	const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
	const current = row?.version ?? null;
	return { current, shipped: DB_VERSION, match: current === DB_VERSION };
}

export function getDatabaseSchema(): string {
	const database = getDb();
	const rows = database
		.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
		.all() as Array<{ type: string; name: string; sql: string }>;

	if (rows.length === 0) return "No schema objects found.";
	return rows.map((r) => `-- ${r.type}: ${r.name}\n${r.sql};`).join("\n\n");
}
