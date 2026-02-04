/**
 * Shared storage utilities for builtin tools.
 *
 * Storage: ~/.local/share/phi/projects/<repo-id>/<dbName>.db
 * Migrates from old paths:
 *   - ~/.local/share/phi-ext-delta/<repo-id>/delta.db (extension era)
 *   - ~/.local/share/phi-ext-epsilon/<repo-id>/epsilon.db (extension era)
 *   - ~/.local/share/phi/<repo-id>/<dbName>.db (pre-projects era)
 */

import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// ============ Constants ============

const LOCAL_SHARE = join(homedir(), ".local", "share");
const PHI_BASE_DIR = join(LOCAL_SHARE, "phi");
const PHI_PROJECTS_DIR = join(PHI_BASE_DIR, "projects");

// Old storage directories (for migration)
const OLD_DELTA_DIR = join(LOCAL_SHARE, "phi-ext-delta");
const OLD_EPSILON_DIR = join(LOCAL_SHARE, "phi-ext-epsilon");
const OLD_PHI_DIR = PHI_BASE_DIR; // Pre-projects era: ~/.local/share/phi/<repo-id>/

// ============ Repo Identifier ============

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

/**
 * Get a stable identifier for the current repository.
 * Works with regular repos, bare repos, and worktrees.
 */
export function getRepoIdentifier(cwd?: string): string {
	const resolvedCwd = cwd ?? process.cwd();
	try {
		if (isBareOrWorktree(resolvedCwd)) {
			const commonDir = execSync("git rev-parse --git-common-dir", gitOpts(resolvedCwd)).trim();
			return sanitizePath(commonDir);
		}

		const toplevel = execSync("git rev-parse --show-toplevel", gitOpts(resolvedCwd)).trim();
		return sanitizePath(toplevel);
	} catch {
		return sanitizePath(resolvedCwd);
	}
}

// ============ Path Resolution with Security ============

/**
 * Resolve database path with path traversal protection.
 * Returns the full path to the database file.
 */
function resolveDbPath(baseDir: string, repoId: string, dbName: string): string {
	const dirPath = join(baseDir, repoId);
	const resolvedPath = resolve(dirPath);
	const resolvedBase = resolve(baseDir);

	// Security: prevent path traversal
	const rel = relative(resolvedBase, resolvedPath);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Invalid database path: path traversal detected");
	}

	return join(dirPath, `${dbName}.db`);
}

// ============ Migration ============

interface MigrationResult {
	migrated: boolean;
	fromPath?: string;
	toPath: string;
}

/**
 * Migrate database from old extension path to new unified path.
 * Preserves existing data by moving the database file.
 *
 * @returns Migration result indicating if migration occurred
 */
function migrateFromOldPath(oldBaseDir: string, newBaseDir: string, repoId: string, dbName: string): MigrationResult {
	const newDbPath = resolveDbPath(newBaseDir, repoId, dbName);
	const oldDbPath = resolveDbPath(oldBaseDir, repoId, dbName);

	// Check if old path exists and has data
	if (!existsSync(oldDbPath)) {
		return { migrated: false, toPath: newDbPath };
	}

	// If new path exists but is smaller than old (likely empty/fresh), prefer old data
	if (existsSync(newDbPath)) {
		const oldSize = statSync(oldDbPath).size;
		const newSize = statSync(newDbPath).size;

		// Only skip migration if new db is larger or equal (has real data)
		if (newSize >= oldSize) {
			return { migrated: false, toPath: newDbPath };
		}

		// New db is smaller (likely empty) - remove it and migrate from old
		const extensions = ["", "-wal", "-shm"];
		for (const ext of extensions) {
			const newFile = newDbPath + ext;
			if (existsSync(newFile)) {
				unlinkSync(newFile);
			}
		}
	}

	// Create new directory
	const newDir = join(newBaseDir, repoId);
	if (!existsSync(newDir)) {
		mkdirSync(newDir, { recursive: true });
	}

	// Move database file (atomic on same filesystem)
	// Also handle WAL and SHM files if they exist
	const extensions = ["", "-wal", "-shm"];
	for (const ext of extensions) {
		const oldFile = oldDbPath + ext;
		const newFile = newDbPath + ext;
		if (existsSync(oldFile)) {
			try {
				renameSync(oldFile, newFile);
			} catch {
				// If rename fails (cross-filesystem), fall back to copy
				copyFileSync(oldFile, newFile);
				// Note: we don't delete old files to be safe
			}
		}
	}

	return { migrated: true, fromPath: oldDbPath, toPath: newDbPath };
}

// ============ Database Path Resolution ============

export type BuiltinDbName = "delta" | "epsilon";

const OLD_EXT_DIRS: Record<BuiltinDbName, string> = {
	delta: OLD_DELTA_DIR,
	epsilon: OLD_EPSILON_DIR,
};

/**
 * Get the database path for a builtin tool.
 * Automatically migrates from old paths if needed.
 *
 * Migration order:
 * 1. Old extension paths: ~/.local/share/phi-ext-{delta,epsilon}/<repo-id>/
 * 2. Pre-projects path: ~/.local/share/phi/<repo-id>/
 * 3. New projects path: ~/.local/share/phi/projects/<repo-id>/
 *
 * @param dbName - Database name (delta or epsilon)
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Full path to the database file
 */
export function getBuiltinDbPath(dbName: BuiltinDbName, cwd?: string): string {
	const repoId = getRepoIdentifier(cwd);

	// 1. Attempt migration from old extension paths (phi-ext-*)
	const oldExtDir = OLD_EXT_DIRS[dbName];
	let result = migrateFromOldPath(oldExtDir, PHI_PROJECTS_DIR, repoId, dbName);

	// 2. Attempt migration from pre-projects path (phi/<repo-id>/)
	if (!result.migrated) {
		result = migrateFromOldPath(OLD_PHI_DIR, PHI_PROJECTS_DIR, repoId, dbName);
	}

	// Ensure directory exists
	const dir = join(PHI_PROJECTS_DIR, repoId);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	return result.toPath;
}

/**
 * Get the base data directory for the current repo.
 */
export function getDataDir(cwd?: string): string {
	const repoId = getRepoIdentifier(cwd);
	return join(PHI_PROJECTS_DIR, repoId);
}

// ============ Database Utilities ============

/**
 * Open a SQLite database with standard pragmas.
 */
export function openDatabase(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	return db;
}

/**
 * Ensure schema version table exists and return current version.
 */
export function ensureSchemaVersion(db: Database, targetVersion: number): { current: number; isFresh: boolean } {
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

/**
 * Stamp the schema version.
 */
export function stampSchemaVersion(db: Database, version: number): void {
	db.exec("DELETE FROM schema_version");
	db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(version);
}

/**
 * Escape special characters for LIKE queries.
 */
export function escapeLike(s: string): string {
	return s.replace(/[%_\\]/g, "\\$&");
}
