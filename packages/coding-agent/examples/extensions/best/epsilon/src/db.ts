/**
 * Epsilon — Task management database layer.
 *
 * Storage: ~/.local/share/phi-ext-epsilon/<repo-id>/epsilon.db
 * Tables:  tasks, schema_version
 *
 * Uses bun:sqlite (zero external deps) instead of better-sqlite3.
 */

import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// ============ Constants ============

export const DB_VERSION = 2;
const LOCAL_SHARE = join(homedir(), ".local", "share");

// ============ Repo ID Helpers (inlined from shared) ============

function sanitizePath(path: string): string {
	return path
		.replace(/^\//, "")
		.replace(/\//g, "_")
		.replace(/[^a-zA-Z0-9_.-]/g, "_")
		.substring(0, 200);
}

function gitOpts(cwd: string) {
	return {
		cwd,
		encoding: "utf-8" as const,
		stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
		timeout: 5000,
	};
}

function isBareOrWorktree(cwd: string): boolean {
	try {
		const isBare = execSync("git rev-parse --is-bare-repository", gitOpts(cwd)).trim();
		if (isBare === "true") return true;

		const gitDir = execSync("git rev-parse --git-dir", gitOpts(cwd)).trim();
		const commonDir = execSync("git rev-parse --git-common-dir", gitOpts(cwd)).trim();

		return gitDir !== commonDir;
	} catch {
		return false;
	}
}

function getRepoIdentifier(cwd: string): string {
	try {
		if (isBareOrWorktree(cwd)) {
			const commonDir = execSync("git rev-parse --git-common-dir", gitOpts(cwd)).trim();
			return sanitizePath(commonDir);
		}

		const toplevel = execSync("git rev-parse --show-toplevel", gitOpts(cwd)).trim();
		return sanitizePath(toplevel);
	} catch {
		return sanitizePath(cwd);
	}
}

// ============ Database Path Helpers ============

function getExtensionDbPath(extensionDir: string, dbName: string, cwd?: string): string {
	const resolvedCwd = cwd ?? process.cwd();
	const repoId = getRepoIdentifier(resolvedCwd);

	const baseDir = join(LOCAL_SHARE, extensionDir);
	const dirPath = join(baseDir, repoId);

	const resolvedPath = resolve(dirPath);
	const resolvedBase = resolve(baseDir);
	const rel = relative(resolvedBase, resolvedPath);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Invalid database path: path traversal detected");
	}

	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, { recursive: true });
	}

	return join(dirPath, `${dbName}.db`);
}

function getDbPath(): string {
	return getExtensionDbPath("phi-ext-epsilon", "epsilon");
}

function openDatabase(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
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

export function escapeLike(s: string): string {
	return s.replace(/[%_\\]/g, "\\$&");
}

// ============ State ============

let db: Database | null = null;
let currentDbPath: string | null = null;

// ============ Database Lifecycle ============

export function getDb(): Database {
	const dbPath = getDbPath();

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

// ============ Schema ============

function migrateV1ToV2(database: Database, dbPath: string): void {
	// Backup before migration
	copyFileSync(dbPath, `${dbPath}.bak`);

	database.exec("PRAGMA foreign_keys = OFF");
	database.exec("BEGIN IMMEDIATE");

	try {
		// Preflight: fix invalid status values
		database.exec(`
      UPDATE tasks SET status = CASE
        WHEN lower(trim(status)) IN ('wip','inprogress') THEN 'in_progress'
        WHEN lower(trim(status)) IN ('complete','completed') THEN 'done'
        WHEN lower(trim(status)) IN ('drop','cancel','canceled') THEN 'cancelled'
        ELSE 'todo'
      END
      WHERE status NOT IN ('todo','in_progress','blocked','done','cancelled');
    `);

		// Preflight: fix invalid priority values
		database.exec(`
      UPDATE tasks SET priority = CASE
        WHEN lower(trim(priority)) IN ('med') THEN 'medium'
        WHEN lower(trim(priority)) IN ('urgent') THEN 'critical'
        ELSE 'medium'
      END
      WHERE priority NOT IN ('low','medium','high','critical');
    `);

		// Rebuild table with CHECK constraints
		database.exec(`
      DROP TABLE IF EXISTS tasks_new;

      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo'
          CHECK(status IN ('todo','in_progress','blocked','done','cancelled')),
        priority TEXT DEFAULT 'medium'
          CHECK(priority IN ('low','medium','high','critical')),
        tags TEXT,
        parent_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (parent_id) REFERENCES tasks_new(id) ON DELETE CASCADE
      );

      INSERT INTO tasks_new (id, title, description, status, priority, tags, parent_id, created_at, updated_at, completed_at)
      SELECT id, title, description, status, priority, tags, parent_id, created_at, updated_at, completed_at
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

      INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 2);
    `);

		database.exec("COMMIT");
	} catch (e) {
		database.exec("ROLLBACK");
		throw e;
	} finally {
		database.exec("PRAGMA foreign_keys = ON");
	}
}

function initSchema(): void {
	if (!db) throw new Error("Database not initialized");

	const { current, isFresh } = ensureSchemaVersion(db, DB_VERSION);

	if (!isFresh && current < 2) {
		migrateV1ToV2(db, currentDbPath!);
	}

	// For fresh DBs, create v2 schema directly
	db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo'
        CHECK(status IN ('todo','in_progress','blocked','done','cancelled')),
      priority TEXT DEFAULT 'medium'
        CHECK(priority IN ('low','medium','high','critical')),
      tags TEXT,
      parent_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
  `);
}

// ============ Types ============

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export const TASK_STATUS_ICONS: Record<TaskStatus, string> = {
	todo: "○",
	in_progress: "◐",
	blocked: "⊘",
	done: "●",
	cancelled: "✕",
};

export interface Task {
	id: number;
	title: string;
	description: string | null;
	status: TaskStatus;
	priority: TaskPriority;
	tags: string[];
	parent_id: number | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

export interface CreateTaskInput {
	title: string;
	description?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	tags?: string[];
	parent_id?: number;
}

export interface UpdateTaskInput {
	title?: string;
	description?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	tags?: string[];
	parent_id?: number | null;
}

export interface ListTasksOptions {
	status?: TaskStatus | TaskStatus[];
	priority?: TaskPriority;
	tags?: string[];
	parent_id?: number | null;
	limit?: number;
}

// ============ Parent Validation ============

const MAX_PARENT_DEPTH = 100;

function validateParentId(parentId: number | null | undefined, taskId?: number): void {
	if (parentId === undefined || parentId === null) return;

	const parent = getDb().prepare("SELECT id FROM tasks WHERE id = ?").get(parentId) as { id: number } | undefined;
	if (!parent) throw new Error(`Parent task #${parentId} not found`);

	if (taskId !== undefined && parentId === taskId) {
		throw new Error("Task cannot be its own parent");
	}

	if (taskId !== undefined) {
		let currentParentId: number | null = parentId;
		const visited = new Set<number>();
		let depth = 0;
		while (currentParentId !== null) {
			if (++depth > MAX_PARENT_DEPTH) throw new Error("Task hierarchy too deep or cycle detected");
			if (visited.has(currentParentId)) break;
			visited.add(currentParentId);
			const ancestor = getDb().prepare("SELECT parent_id FROM tasks WHERE id = ?").get(currentParentId) as
				| { parent_id: number | null }
				| undefined;
			if (!ancestor) break;
			if (ancestor.parent_id === taskId) throw new Error("Circular parent reference detected");
			currentParentId = ancestor.parent_id;
		}
	}
}

// ============ CRUD Operations ============

export function createTask(input: CreateTaskInput): number {
	validateParentId(input.parent_id);
	const now = Date.now();

	const row = getDb()
		.prepare(
			`INSERT INTO tasks (title, description, status, priority, tags, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
		)
		.get(
			input.title,
			input.description ?? null,
			input.status ?? "todo",
			input.priority ?? "medium",
			input.tags ? JSON.stringify(input.tags) : null,
			input.parent_id ?? null,
			now,
			now,
		) as { id: number };
	return row.id;
}

export function getTask(id: number): Task | null {
	const row = getDb()
		.prepare(
			"SELECT id, title, description, status, priority, tags, parent_id, created_at, updated_at, completed_at FROM tasks WHERE id = ?",
		)
		.get(id) as
		| {
				id: number;
				title: string;
				description: string | null;
				status: TaskStatus;
				priority: TaskPriority;
				tags: string | null;
				parent_id: number | null;
				created_at: number;
				updated_at: number;
				completed_at: number | null;
		  }
		| undefined;

	if (!row) return null;
	return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
}

export function listTasks(options: ListTasksOptions = {}): Task[] {
	const { status, priority, tags, parent_id, limit = 50 } = options;

	let sql =
		"SELECT id, title, description, status, priority, tags, parent_id, created_at, updated_at, completed_at FROM tasks WHERE 1=1";
	const params: (string | number)[] = [];

	if (status) {
		if (Array.isArray(status)) {
			sql += ` AND status IN (${status.map(() => "?").join(", ")})`;
			params.push(...status);
		} else {
			sql += " AND status = ?";
			params.push(status);
		}
	}

	if (priority) {
		sql += " AND priority = ?";
		params.push(priority);
	}

	if (parent_id !== undefined) {
		if (parent_id === null) {
			sql += " AND parent_id IS NULL";
		} else {
			sql += " AND parent_id = ?";
			params.push(parent_id);
		}
	}

	if (tags && tags.length > 0) {
		const tagConditions = tags.map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ");
		sql += ` AND (${tagConditions})`;
		for (const tag of tags) params.push(`%"${escapeLike(tag)}"%`);
	}

	sql += " ORDER BY priority DESC, created_at DESC LIMIT ?";
	params.push(limit);

	const rows = getDb()
		.prepare(sql)
		.all(...params) as Array<{
		id: number;
		title: string;
		description: string | null;
		status: TaskStatus;
		priority: TaskPriority;
		tags: string | null;
		parent_id: number | null;
		created_at: number;
		updated_at: number;
		completed_at: number | null;
	}>;

	return rows.map((row) => ({ ...row, tags: row.tags ? JSON.parse(row.tags) : [] }));
}

export function updateTask(id: number, input: UpdateTaskInput): boolean {
	if (input.parent_id !== undefined) validateParentId(input.parent_id, id);

	const updates: string[] = [];
	const params: (string | number | null)[] = [];

	if (input.title !== undefined) {
		updates.push("title = ?");
		params.push(input.title);
	}
	if (input.description !== undefined) {
		updates.push("description = ?");
		params.push(input.description);
	}
	if (input.status !== undefined) {
		updates.push("status = ?");
		params.push(input.status);
		if (input.status === "done" || input.status === "cancelled") {
			updates.push("completed_at = ?");
			params.push(Date.now());
		}
	}
	if (input.priority !== undefined) {
		updates.push("priority = ?");
		params.push(input.priority);
	}
	if (input.tags !== undefined) {
		updates.push("tags = ?");
		params.push(JSON.stringify(input.tags));
	}
	if (input.parent_id !== undefined) {
		updates.push("parent_id = ?");
		params.push(input.parent_id);
	}

	if (updates.length === 0) return false;

	updates.push("updated_at = ?");
	params.push(Date.now());
	params.push(id);

	const sql = `UPDATE tasks SET ${updates.join(", ")} WHERE id = ? RETURNING id`;
	const row = getDb()
		.prepare(sql)
		.get(...params) as { id: number } | undefined;
	return row !== undefined;
}

export function deleteTask(id: number): boolean {
	const row = getDb().prepare("DELETE FROM tasks WHERE id = ? RETURNING id").get(id) as { id: number } | undefined;
	return row !== undefined;
}

// ============ Task Summary ============

export interface TaskSummary {
	todo: number;
	in_progress: number;
	blocked: number;
	done: number;
	cancelled: number;
	activeTasks: Task[];
}

export function getTaskSummary(): TaskSummary {
	const database = getDb();

	const counts = database.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all() as Array<{
		status: TaskStatus;
		count: number;
	}>;

	const summary: TaskSummary = {
		todo: 0,
		in_progress: 0,
		blocked: 0,
		done: 0,
		cancelled: 0,
		activeTasks: [],
	};

	for (const row of counts) {
		summary[row.status] = row.count;
	}

	summary.activeTasks = listTasks({
		status: ["todo", "in_progress", "blocked"],
		limit: 20,
	});

	return summary;
}

// ============ Prompt Builder ============

export interface PromptOptions {
	summary?: TaskSummary;
}

export function buildTasksPrompt(options: PromptOptions = {}): string {
	const summary = options.summary ?? getTaskSummary();
	const lines: string[] = [];

	lines.push("<epsilon_tasks>");
	lines.push("");
	lines.push("## Task Tracking");
	lines.push(
		"Non-trivial changes (2+ files, features, refactors, bug fixes, schema/API) → create task first, set in_progress, mark done when finished.",
	);
	lines.push(
		"Trivial changes (single-file typo, formatting, comment) → no task needed. If it grows to 2+ files, create a task then continue.",
	);
	lines.push("");

	const activeCount = summary.todo + summary.in_progress + summary.blocked;
	if (activeCount > 0) {
		lines.push("## Active Tasks");
		for (const task of summary.activeTasks) {
			const icon = TASK_STATUS_ICONS[task.status];
			const priority = task.priority !== "medium" ? ` [${task.priority}]` : "";
			const tags = task.tags.length > 0 ? ` [${task.tags.join(", ")}]` : "";
			lines.push(`  ${icon} #${task.id}${priority} ${task.title}${tags}`);
			if (task.description) {
				lines.push(`    ${task.description.substring(0, 100)}`);
			}
		}
		lines.push("");
	}

	lines.push("## Overview");
	lines.push(
		`Status: ${summary.todo} todo, ${summary.in_progress} in progress, ${summary.blocked} blocked, ${summary.done} done`,
	);
	lines.push("");

	lines.push("Create tasks with epsilon_task_create (single) or epsilon_task_create_bulk (multiple).");
	lines.push("Update tasks with epsilon_task_update (single) or epsilon_task_update_bulk (multiple).");
	lines.push("For batch operations, always use the bulk tools - they are more reliable.");
	lines.push("");
	lines.push("</epsilon_tasks>");

	return lines.join("\n");
}

// ============ Version & Info ============

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

// ============ Utility ============

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
		currentDbPath = null;
	}
}

export function getDbLocation(): string {
	return getDbPath();
}
