/**
 * SQLite database layer for the permissions system.
 *
 * Replaces JSON-based persistence with SQLite for atomicity, audit trail,
 * and granular permission storage. Reuses infrastructure from storage.ts.
 *
 * DB location: ~/.local/share/phi/projects/<repo-id>/permissions.db
 */

import type { Database, Statement } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensureSchemaVersion, getDataDir, openDatabase } from "../builtin-tools/storage.js";

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS permission_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  tool_name TEXT,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  UNIQUE(type, action, resource, scope) ON CONFLICT REPLACE
);

CREATE INDEX IF NOT EXISTS idx_grants_active
  ON permission_grants(type, action, resource)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_grants_scope
  ON permission_grants(scope)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS permission_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  tool_name TEXT,
  result TEXT,
  scope TEXT,
  reason TEXT,
  user_message TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON permission_audit(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON permission_audit(resource);

CREATE TABLE IF NOT EXISTS pre_allowed_dirs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  added_at TEXT NOT NULL
);
`;

// ── Row Types ───────────────────────────────────────────────────────────────

export interface GrantRow {
	id: number;
	type: string;
	action: string;
	resource: string;
	scope: string;
	toolName: string | null;
	grantedAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
}

export interface AuditRow {
	id: number;
	event: string;
	type: string;
	action: string;
	resource: string;
	toolName: string | null;
	result: string | null;
	scope: string | null;
	reason: string | null;
	userMessage: string | null;
	timestamp: string;
}

// ── Raw DB row shapes (snake_case from SQLite) ──────────────────────────────

interface RawGrantRow {
	id: number;
	type: string;
	action: string;
	resource: string;
	scope: string;
	tool_name: string | null;
	granted_at: string;
	expires_at: string | null;
	revoked_at: string | null;
}

interface RawAuditRow {
	id: number;
	event: string;
	type: string;
	action: string;
	resource: string;
	tool_name: string | null;
	result: string | null;
	scope: string | null;
	reason: string | null;
	user_message: string | null;
	timestamp: string;
}

// ── Legacy JSON format ──────────────────────────────────────────────────────

interface LegacyGrant {
	type: string;
	resource: string;
	scope: string;
	grantedAt: string;
}

interface LegacyPermissions {
	grants: LegacyGrant[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapGrantRow(row: RawGrantRow): GrantRow {
	return {
		id: row.id,
		type: row.type,
		action: row.action,
		resource: row.resource,
		scope: row.scope,
		toolName: row.tool_name,
		grantedAt: row.granted_at,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
	};
}

function mapAuditRow(row: RawAuditRow): AuditRow {
	return {
		id: row.id,
		event: row.event,
		type: row.type,
		action: row.action,
		resource: row.resource,
		toolName: row.tool_name,
		result: row.result,
		scope: row.scope,
		reason: row.reason,
		userMessage: row.user_message,
		timestamp: row.timestamp,
	};
}

// ── PermissionDb ────────────────────────────────────────────────────────────

export class PermissionDb {
	private readonly _db: Database;

	// Prepared statements
	private readonly _stmtInsertGrant: Statement;
	private readonly _stmtRevokeGrant: Statement;
	private readonly _stmtFindActiveGrants: Statement;
	private readonly _stmtFindActiveByResource: Statement;
	private readonly _stmtFindAllActive: Statement;
	private readonly _stmtInsertAudit: Statement;
	private readonly _stmtGetAuditLog: Statement;
	private readonly _stmtUpsertPreAllowed: Statement;
	private readonly _stmtGetPreAllowed: Statement;

	/**
	 * Create a PermissionDb.
	 * @param cwd Working directory — DB will be at getDataDir(cwd)/permissions.db
	 * @param directDbPath Optional: bypass getDataDir and use this exact path
	 */
	constructor(cwd: string, directDbPath?: string) {
		const dbPath = directDbPath ?? join(getDataDir(cwd), "permissions.db");
		this._db = openDatabase(dbPath);

		const { isFresh } = ensureSchemaVersion(this._db, SCHEMA_VERSION);
		if (isFresh) {
			this._db.exec(SCHEMA_V1);
		}

		// Prepare statements
		this._stmtInsertGrant = this._db.prepare(`
			INSERT INTO permission_grants (type, action, resource, scope, tool_name, granted_at, expires_at)
			VALUES ($type, $action, $resource, $scope, $toolName, $grantedAt, $expiresAt)
		`);

		this._stmtRevokeGrant = this._db.prepare(`
			UPDATE permission_grants
			SET revoked_at = $revokedAt
			WHERE type = $type AND action = $action AND resource = $resource AND revoked_at IS NULL
		`);

		this._stmtFindActiveGrants = this._db.prepare(`
			SELECT * FROM permission_grants
			WHERE type = $type AND action = $action AND resource = $resource AND revoked_at IS NULL
		`);

		this._stmtFindActiveByResource = this._db.prepare(`
			SELECT * FROM permission_grants
			WHERE resource = $resource AND revoked_at IS NULL
		`);

		this._stmtFindAllActive = this._db.prepare(`
			SELECT * FROM permission_grants WHERE revoked_at IS NULL
		`);

		this._stmtInsertAudit = this._db.prepare(`
			INSERT INTO permission_audit (event, type, action, resource, tool_name, result, scope, reason, user_message, timestamp)
			VALUES ($event, $type, $action, $resource, $toolName, $result, $scope, $reason, $userMessage, $timestamp)
		`);

		this._stmtGetAuditLog = this._db.prepare(`
			SELECT * FROM permission_audit ORDER BY id DESC LIMIT $limit
		`);

		this._stmtUpsertPreAllowed = this._db.prepare(`
			INSERT INTO pre_allowed_dirs (path, added_at) VALUES ($path, $addedAt)
			ON CONFLICT(path) DO UPDATE SET added_at = excluded.added_at
		`);

		this._stmtGetPreAllowed = this._db.prepare(`
			SELECT path FROM pre_allowed_dirs
		`);
	}

	// ── Grants ────────────────────────────────────────────────────────────

	insertGrant(grant: {
		type: string;
		action: string;
		resource: string;
		scope: string;
		toolName?: string;
		expiresAt?: string;
	}): void {
		this._stmtInsertGrant.run({
			$type: grant.type,
			$action: grant.action,
			$resource: grant.resource,
			$scope: grant.scope,
			$toolName: grant.toolName ?? null,
			$grantedAt: new Date().toISOString(),
			$expiresAt: grant.expiresAt ?? null,
		});
	}

	revokeGrant(type: string, action: string, resource: string): void {
		this._stmtRevokeGrant.run({
			$type: type,
			$action: action,
			$resource: resource,
			$revokedAt: new Date().toISOString(),
		});
	}

	findActiveGrants(type: string, action: string, resource: string): GrantRow[] {
		const rows = this._stmtFindActiveGrants.all({
			$type: type,
			$action: action,
			$resource: resource,
		}) as RawGrantRow[];
		return rows.map(mapGrantRow);
	}

	findActiveGrantsByResource(resource: string): GrantRow[] {
		const rows = this._stmtFindActiveByResource.all({
			$resource: resource,
		}) as RawGrantRow[];
		return rows.map(mapGrantRow);
	}

	findAllActiveGrants(): GrantRow[] {
		const rows = this._stmtFindAllActive.all() as RawGrantRow[];
		return rows.map(mapGrantRow);
	}

	// ── Audit ─────────────────────────────────────────────────────────────

	logAudit(entry: {
		event: string;
		type: string;
		action: string;
		resource: string;
		toolName?: string;
		result?: string;
		scope?: string;
		reason?: string;
		userMessage?: string;
	}): void {
		this._stmtInsertAudit.run({
			$event: entry.event,
			$type: entry.type,
			$action: entry.action,
			$resource: entry.resource,
			$toolName: entry.toolName ?? null,
			$result: entry.result ?? null,
			$scope: entry.scope ?? null,
			$reason: entry.reason ?? null,
			$userMessage: entry.userMessage ?? null,
			$timestamp: new Date().toISOString(),
		});
	}

	getAuditLog(limit = 100): AuditRow[] {
		const rows = this._stmtGetAuditLog.all({ $limit: limit }) as RawAuditRow[];
		return rows.map(mapAuditRow);
	}

	// ── Pre-allowed dirs ──────────────────────────────────────────────────

	setPreAllowedDir(path: string): void {
		this._stmtUpsertPreAllowed.run({
			$path: path,
			$addedAt: new Date().toISOString(),
		});
	}

	getPreAllowedDirs(): string[] {
		const rows = this._stmtGetPreAllowed.all() as { path: string }[];
		return rows.map((r) => r.path);
	}

	// ── Migration ─────────────────────────────────────────────────────────

	/**
	 * Migrate legacy permissions.json to SQLite.
	 * Inserts each grant with action='fs_read' (legacy grants were directory-level read).
	 * Renames the JSON file to .bak after migration.
	 */
	migrateFromJson(jsonPath: string): void {
		if (!existsSync(jsonPath)) return;

		let data: LegacyPermissions;
		try {
			const content = readFileSync(jsonPath, "utf-8");
			data = JSON.parse(content) as LegacyPermissions;
		} catch {
			// Corrupted JSON — skip migration
			return;
		}

		if (!Array.isArray(data.grants) || data.grants.length === 0) return;

		const tx = this._db.transaction(() => {
			let count = 0;
			for (const grant of data.grants) {
				if (grant.type && grant.resource && grant.scope === "persistent") {
					this.insertGrant({
						type: grant.type,
						action: "fs_read",
						resource: grant.resource,
						scope: grant.scope,
					});
					count++;
				}
			}

			this.logAudit({
				event: "migration",
				type: "directory",
				action: "fs_read",
				resource: jsonPath,
				result: "granted",
				reason: `Migrated ${count} grants from permissions.json`,
			});
		});

		tx();

		// Rename original to .bak
		try {
			renameSync(jsonPath, `${jsonPath}.bak`);
		} catch {
			// Best-effort rename
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	close(): void {
		this._db.close();
	}
}
