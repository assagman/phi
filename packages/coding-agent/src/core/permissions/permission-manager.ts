/**
 * PermissionManager — checks, grants, and persists permissions.
 *
 * Four layers of grants (checked in order):
 *   1. CWD — paths within CWD always granted
 *   2. Pre-allowed (from settings.json allowedDirs) — always granted
 *   3. Persistent (SQLite) — survives across sessions
 *   4. Session (in-memory) — cleared on exit
 *   5. Once (in-memory, cleared after each agent turn)
 *
 * When none match, the prompt callback is invoked to ask the user.
 * All operations are audit-logged to SQLite.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import type { PermissionDb } from "./permission-db.js";
import type {
	PermissionAction,
	PermissionCheckResult,
	PermissionGrant,
	PermissionPromptFn,
	PermissionPromptResult,
	PermissionRequest,
	PermissionScope,
	PermissionType,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Expand ~ to home directory */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	return p;
}

/**
 * Resolve to realpath if the path exists, otherwise resolve the nearest
 * existing ancestor to realpath and append remaining segments.
 * This prevents symlink escapes while handling non-existent paths (e.g., write).
 */
function safeRealpath(absolutePath: string): string {
	try {
		return realpathSync(absolutePath);
	} catch {
		// Path doesn't exist yet — resolve parent
		const parent = dirname(absolutePath);
		const base = absolutePath.slice(parent.length);
		if (parent === absolutePath) return absolutePath; // root
		return safeRealpath(parent) + base;
	}
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface PermissionManagerConfig {
	/** Immutable CWD — paths within this directory never need permission */
	cwd: string;
	/** PermissionDb instance for SQLite persistence + audit */
	db: PermissionDb;
	/** Pre-allowed directories from settings.json */
	preAllowedDirs: string[];
	/** UI prompt callback — called when user decision is needed */
	promptFn?: PermissionPromptFn;
	/**
	 * Legacy JSON path for migration. If provided and file exists,
	 * grants are migrated to SQLite on construction.
	 */
	legacyJsonPath?: string;
}

// ── PermissionManager ───────────────────────────────────────────────────────

export class PermissionManager {
	private readonly _cwd: string;
	private readonly _db: PermissionDb;
	private readonly _preAllowedDirs: Set<string>;
	private _promptFn: PermissionPromptFn | undefined;

	// In-memory grant stores (not persisted to DB)
	private readonly _sessionGrants = new Map<string, PermissionGrant>();
	private readonly _onceGrants = new Set<string>();

	constructor(config: PermissionManagerConfig) {
		// Resolve CWD to realpath to prevent symlink escapes
		const resolvedCwd = resolvePath(config.cwd);
		this._cwd = safeRealpath(resolvedCwd);
		this._db = config.db;
		this._promptFn = config.promptFn;

		// Normalize pre-allowed dirs to absolute paths (with ~ expansion and realpath)
		this._preAllowedDirs = new Set<string>();
		for (const dir of config.preAllowedDirs) {
			const expanded = expandTilde(dir);
			const resolved = safeRealpath(resolvePath(expanded));
			this._preAllowedDirs.add(resolved);
			// Sync to DB for queryability
			this._db.setPreAllowedDir(resolved);
		}

		// Migrate legacy JSON if provided
		if (config.legacyJsonPath) {
			this._db.migrateFromJson(config.legacyJsonPath);
		}
	}

	/** Set the prompt function (for deferred UI setup) */
	setPromptFn(fn: PermissionPromptFn): void {
		this._promptFn = fn;
	}

	/** Get the immutable CWD */
	get cwd(): string {
		return this._cwd;
	}

	/** Get the underlying database (for lifecycle management) */
	get db(): PermissionDb {
		return this._db;
	}

	// =========================================================================
	// Core API
	// =========================================================================

	/**
	 * Check if a path is within the CWD boundary.
	 * Uses realpath to prevent symlink escapes.
	 * Paths inside CWD never need permission.
	 */
	isWithinCwd(absolutePath: string): boolean {
		const resolved = safeRealpath(resolvePath(absolutePath));
		return resolved === this._cwd || resolved.startsWith(`${this._cwd}/`);
	}

	/**
	 * Check if a directory permission is already granted (without prompting).
	 * Checks against a specific action (defaults to fs_read for backward compat).
	 */
	checkDirectory(absolutePath: string, action: PermissionAction = "fs_read"): PermissionCheckResult {
		const resolved = safeRealpath(resolvePath(absolutePath));

		// Within CWD — always allowed
		if (this.isWithinCwd(resolved)) {
			return { status: "granted", scope: "session" };
		}

		// Pre-allowed dirs — always granted (both read and write)
		if (this._isPreAllowed(resolved)) {
			this._logCheck("directory", action, resolved, "granted", "pre_allowed");
			return { status: "granted", scope: "persistent" };
		}

		// Check in-memory once grants
		const onceKey = this._grantKey("directory", action, resolved);
		if (this._onceGrants.has(onceKey)) {
			this._logCheck("directory", action, resolved, "granted", "once");
			return { status: "granted", scope: "once" };
		}

		// Check in-memory session grants
		if (this._sessionGrants.has(onceKey)) {
			this._logCheck("directory", action, resolved, "granted", "session");
			return { status: "granted", scope: "session" };
		}

		// Check SQLite persistent grants
		const dbGrants = this._db.findActiveGrants("directory", action, resolved);
		if (dbGrants.length > 0) {
			this._logCheck("directory", action, resolved, "granted", "persistent");
			return { status: "granted", scope: "persistent" };
		}

		this._logCheck("directory", action, resolved, "denied");
		return { status: "denied" };
	}

	/**
	 * Request permission for a directory. Prompts user if not already granted.
	 * Returns the check result (granted or denied with optional user message).
	 */
	async requestDirectory(
		absolutePath: string,
		toolName: string,
		action: PermissionAction = "fs_read",
	): Promise<PermissionCheckResult> {
		const resolved = safeRealpath(resolvePath(absolutePath));

		// Check existing grants first
		const existing = this.checkDirectory(resolved, action);
		if (existing.status === "granted") {
			return existing;
		}

		// No prompt function — deny by default
		if (!this._promptFn) {
			this._db.logAudit({
				event: "request",
				type: "directory",
				action,
				resource: resolved,
				toolName,
				result: "denied",
				reason: "no_prompt",
			});
			return { status: "denied" };
		}

		// Build request and prompt user
		const actionLabel = action === "fs_write" ? "Write" : "Read";
		const request: PermissionRequest<"directory"> = {
			type: "directory",
			detail: { path: resolved, action },
			toolName,
			description: `${actionLabel} access to directory outside workspace: ${resolved}`,
		};

		this._db.logAudit({
			event: "prompt",
			type: "directory",
			action,
			resource: resolved,
			toolName,
		});

		const result = await this._promptFn(request);
		return this._applyPromptResult("directory", action, resolved, toolName, result);
	}

	/**
	 * Grant a permission directly (used by pre-allowed dirs and programmatic grants).
	 */
	grant(
		type: PermissionType,
		resource: string,
		scope: PermissionScope,
		action: PermissionAction = "fs_read",
		toolName?: string,
	): void {
		const resolved = type === "directory" ? safeRealpath(resolvePath(resource)) : resource;
		const key = this._grantKey(type, action, resolved);
		const grant: PermissionGrant = {
			type,
			action,
			resource: resolved,
			scope,
			toolName,
			grantedAt: new Date().toISOString(),
		};

		switch (scope) {
			case "once":
				this._onceGrants.add(key);
				break;
			case "session":
				this._sessionGrants.set(key, grant);
				break;
			case "persistent":
				this._db.insertGrant({
					type,
					action,
					resource: resolved,
					scope,
					toolName,
				});
				break;
		}

		this._db.logAudit({
			event: "grant",
			type,
			action,
			resource: resolved,
			toolName,
			result: "granted",
			scope,
		});
	}

	/**
	 * Clear "once" grants. Called after each agent turn.
	 */
	clearOnceGrants(): void {
		this._onceGrants.clear();
	}

	/**
	 * Clear all session and once grants. Called on session end.
	 */
	clearSessionGrants(): void {
		this._sessionGrants.clear();
		this._onceGrants.clear();
	}

	/**
	 * Get all persistent grants (from SQLite).
	 */
	getPersistentGrants(): PermissionGrant[] {
		return this._db.findAllActiveGrants().map((row) => ({
			type: row.type as PermissionType,
			action: row.action as PermissionAction,
			resource: row.resource,
			scope: row.scope as PermissionScope,
			toolName: row.toolName ?? undefined,
			grantedAt: row.grantedAt,
			expiresAt: row.expiresAt ?? undefined,
			revokedAt: row.revokedAt ?? undefined,
		}));
	}

	/**
	 * Revoke a persistent grant.
	 */
	revokePersistent(type: PermissionType, resource: string, action: PermissionAction = "fs_read"): boolean {
		const resolved = type === "directory" ? safeRealpath(resolvePath(resource)) : resource;

		// Check if grant exists before revoking
		const existing = this._db.findActiveGrants(type, action, resolved);
		if (existing.length === 0) return false;

		this._db.revokeGrant(type, action, resolved);

		this._db.logAudit({
			event: "revoke",
			type,
			action,
			resource: resolved,
			result: "denied",
		});

		return true;
	}

	/**
	 * Close the underlying database. Call on shutdown.
	 */
	close(): void {
		this._db.close();
	}

	// =========================================================================
	// Internal
	// =========================================================================

	/**
	 * Apply a prompt result — grant or deny.
	 */
	private _applyPromptResult(
		type: PermissionType,
		action: PermissionAction,
		resource: string,
		toolName: string,
		result: PermissionPromptResult,
	): PermissionCheckResult {
		if (result.action === "allow") {
			this.grant(type, resource, result.scope, action, toolName);
			return { status: "granted", scope: result.scope };
		}

		this._db.logAudit({
			event: "deny",
			type,
			action,
			resource,
			toolName,
			result: "denied",
			reason: "user_denied",
			userMessage: result.userMessage,
		});

		return { status: "denied", userMessage: result.userMessage };
	}

	/**
	 * Check if a path is under any pre-allowed directory.
	 */
	private _isPreAllowed(absolutePath: string): boolean {
		for (const dir of this._preAllowedDirs) {
			if (absolutePath === dir || absolutePath.startsWith(`${dir}/`)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Create a composite lookup key for grant stores.
	 */
	private _grantKey(type: PermissionType, action: PermissionAction, resource: string): string {
		return `${type}:${action}:${resource}`;
	}

	/**
	 * Log a permission check to audit trail.
	 */
	private _logCheck(
		type: PermissionType,
		action: PermissionAction,
		resource: string,
		result: "granted" | "denied",
		reason?: string,
	): void {
		this._db.logAudit({
			event: "check",
			type,
			action,
			resource,
			result,
			reason,
		});
	}
}
