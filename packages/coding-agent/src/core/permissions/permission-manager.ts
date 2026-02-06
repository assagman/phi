/**
 * PermissionManager — checks, grants, and persists permissions.
 *
 * Three layers of grants (checked in order):
 *   1. Pre-allowed (from settings.json allowedDirs) — always granted
 *   2. Persistent (from permissions.json) — survives across sessions
 *   3. Session (in-memory) — cleared on exit
 *   4. Once (in-memory, cleared after each agent turn)
 *
 * When none match, the prompt callback is invoked to ask the user.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import type {
	PermissionCheckResult,
	PermissionGrant,
	PermissionPromptFn,
	PermissionPromptResult,
	PermissionRequest,
	PermissionScope,
	PermissionType,
	PersistedPermissions,
} from "./types.js";

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

export interface PermissionManagerConfig {
	/** Immutable CWD — paths within this directory never need permission */
	cwd: string;
	/** Path to persistent permissions file (e.g., ~/.phi/agent/permissions.json) */
	persistPath: string;
	/** Pre-allowed directories from settings.json */
	preAllowedDirs: string[];
	/** UI prompt callback — called when user decision is needed */
	promptFn?: PermissionPromptFn;
}

export class PermissionManager {
	private readonly _cwd: string;
	private readonly _persistPath: string;
	private readonly _preAllowedDirs: Set<string>;
	private _promptFn: PermissionPromptFn | undefined;

	// In-memory grant stores
	private readonly _sessionGrants = new Map<string, PermissionGrant>();
	private readonly _onceGrants = new Set<string>();

	// Persistent grants (loaded from disk)
	private readonly _persistentGrants = new Map<string, PermissionGrant>();

	constructor(config: PermissionManagerConfig) {
		// Resolve CWD to realpath to prevent symlink escapes
		const resolvedCwd = resolvePath(config.cwd);
		this._cwd = safeRealpath(resolvedCwd);
		this._persistPath = config.persistPath;
		this._promptFn = config.promptFn;

		// Normalize pre-allowed dirs to absolute paths (with ~ expansion and realpath)
		this._preAllowedDirs = new Set<string>();
		for (const dir of config.preAllowedDirs) {
			const expanded = expandTilde(dir);
			this._preAllowedDirs.add(safeRealpath(resolvePath(expanded)));
		}

		// Load persistent grants from disk
		this._loadPersistentGrants();
	}

	/** Set the prompt function (for deferred UI setup) */
	setPromptFn(fn: PermissionPromptFn): void {
		this._promptFn = fn;
	}

	/** Get the immutable CWD */
	get cwd(): string {
		return this._cwd;
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
	 */
	checkDirectory(absolutePath: string): PermissionCheckResult {
		const resolved = resolvePath(absolutePath);

		// Within CWD — always allowed
		if (this.isWithinCwd(resolved)) {
			return { status: "granted", scope: "session" };
		}

		// Check grant layers
		const key = this._directoryKey(resolved);

		if (this._isPreAllowed(resolved)) {
			return { status: "granted", scope: "persistent" };
		}
		if (this._persistentGrants.has(key)) {
			return { status: "granted", scope: "persistent" };
		}
		if (this._sessionGrants.has(key)) {
			return { status: "granted", scope: "session" };
		}
		if (this._onceGrants.has(key)) {
			return { status: "granted", scope: "once" };
		}

		return { status: "denied" };
	}

	/**
	 * Request permission for a directory. Prompts user if not already granted.
	 * Returns the check result (granted or denied with optional user message).
	 */
	async requestDirectory(absolutePath: string, toolName: string): Promise<PermissionCheckResult> {
		const resolved = resolvePath(absolutePath);

		// Check existing grants first
		const existing = this.checkDirectory(resolved);
		if (existing.status === "granted") {
			return existing;
		}

		// No prompt function — deny by default
		if (!this._promptFn) {
			return { status: "denied" };
		}

		// Build request and prompt user
		const request: PermissionRequest<"directory"> = {
			type: "directory",
			detail: { path: resolved },
			toolName,
			description: `Access directory outside workspace: ${resolved}`,
		};

		const result = await this._promptFn(request);
		return this._applyPromptResult("directory", resolved, result);
	}

	/**
	 * Grant a permission directly (used by pre-allowed dirs and programmatic grants).
	 */
	grant(type: PermissionType, resource: string, scope: PermissionScope): void {
		const key = this._resourceKey(type, resource);
		const grant: PermissionGrant = {
			type,
			resource,
			scope,
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
				this._persistentGrants.set(key, grant);
				this._savePersistentGrants();
				break;
		}
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
	 * Get all persistent grants (for display/management).
	 */
	getPersistentGrants(): PermissionGrant[] {
		return Array.from(this._persistentGrants.values());
	}

	/**
	 * Revoke a persistent grant.
	 */
	revokePersistent(type: PermissionType, resource: string): boolean {
		const key = this._resourceKey(type, resource);
		const deleted = this._persistentGrants.delete(key);
		if (deleted) {
			this._savePersistentGrants();
		}
		return deleted;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	/**
	 * Apply a prompt result — grant or deny.
	 */
	private _applyPromptResult(
		type: PermissionType,
		resource: string,
		result: PermissionPromptResult,
	): PermissionCheckResult {
		if (result.action === "allow") {
			this.grant(type, resource, result.scope);
			return { status: "granted", scope: result.scope };
		}
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
	 * Create a lookup key for a directory grant.
	 * For directories, we normalize and check parent containment.
	 */
	private _directoryKey(absolutePath: string): string {
		return this._resourceKey("directory", absolutePath);
	}

	/**
	 * Create a lookup key for any resource.
	 */
	private _resourceKey(type: PermissionType, resource: string): string {
		return `${type}:${resource}`;
	}

	/**
	 * Load persistent grants from disk.
	 */
	private _loadPersistentGrants(): void {
		if (!existsSync(this._persistPath)) return;

		try {
			const content = readFileSync(this._persistPath, "utf-8");
			const data = JSON.parse(content) as PersistedPermissions;

			if (Array.isArray(data.grants)) {
				for (const grant of data.grants) {
					if (grant.type && grant.resource && grant.scope === "persistent") {
						const key = this._resourceKey(grant.type, grant.resource);
						this._persistentGrants.set(key, grant);
					}
				}
			}
		} catch {
			// Corrupted file — start fresh
		}
	}

	/**
	 * Save persistent grants to disk.
	 */
	private _savePersistentGrants(): void {
		const data: PersistedPermissions = {
			grants: Array.from(this._persistentGrants.values()),
		};

		try {
			const dir = dirname(this._persistPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			// Atomic write: write to temp file, then rename (prevents corruption on crash)
			const tmpPath = joinPath(dir, `.permissions.${process.pid}.tmp`);
			writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
			renameSync(tmpPath, this._persistPath);
		} catch {
			// Best-effort persistence
		}
	}
}
