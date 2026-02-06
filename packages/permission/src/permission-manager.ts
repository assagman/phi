/**
 * PermissionManager — checks, grants, and persists permissions.
 *
 * Six layers of grants (checked in order):
 *   1. CWD — paths within CWD always granted
 *   2. Workspace roots — paths within git root / infra dirs always granted
 *   3. Pre-allowed (from settings allowedDirs) — always granted
 *   4. Persistent (SQLite) — survives across sessions
 *   5. Session (in-memory) — cleared on exit
 *   6. Once (in-memory, cleared after each agent turn)
 *
 * When none match, the prompt callback is invoked to ask the user.
 * All operations are audit-logged to SQLite.
 */

import { existsSync, realpathSync } from "node:fs";
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

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	return p;
}

/**
 * Resolve to realpath if the path exists, otherwise resolve the nearest
 * existing ancestor to realpath and append remaining segments.
 * Prevents symlink escapes while handling non-existent paths.
 */
function safeRealpath(absolutePath: string): string {
	try {
		return realpathSync(absolutePath);
	} catch {
		const parent = dirname(absolutePath);
		const base = absolutePath.slice(parent.length);
		if (parent === absolutePath) return absolutePath;
		return safeRealpath(parent) + base;
	}
}

// ── Config ──────────────────────────────────────────────────────────────────

/** Callback invoked when a grant changes (for sandbox config sync) */
export type GrantChangeCallback = (allWritePaths: string[]) => void | Promise<void>;

export interface PermissionManagerConfig {
	/** Immutable CWD — paths within this directory never need permission */
	cwd: string;
	/** PermissionDb instance for SQLite persistence + audit */
	db: PermissionDb;
	/**
	 * Workspace root directories that are auto-allowed without prompting.
	 * Typically includes: git common dir (bare repo root).
	 * Paths within any workspace root are granted automatically (like CWD).
	 */
	workspaceRoots?: string[];
	/**
	 * Individual files that are auto-allowed without prompting.
	 * Checked before directory permissions — allows fine-grained access
	 * to specific files in otherwise restricted directories.
	 * Typically: discovered context files (AGENTS.md), skill files.
	 */
	safeFiles?: string[];
	/** Pre-allowed directories from settings */
	preAllowedDirs: string[];
	/** UI prompt callback — called when user decision is needed */
	promptFn?: PermissionPromptFn;
	/** Legacy JSON path for migration */
	legacyJsonPath?: string;
	/** Called when grants change — passes all currently allowed write paths */
	onGrantChange?: GrantChangeCallback;
}

// ── PermissionManager ───────────────────────────────────────────────────────

export class PermissionManager {
	private readonly _cwd: string;
	private readonly _db: PermissionDb;
	private readonly _workspaceRoots: Set<string>;
	private readonly _safeFiles: Set<string>;
	private readonly _preAllowedDirs: Set<string>;
	private _promptFn: PermissionPromptFn | undefined;
	private _onGrantChange: GrantChangeCallback | undefined;

	private readonly _sessionGrants = new Map<string, PermissionGrant>();
	private readonly _onceGrants = new Set<string>();

	constructor(config: PermissionManagerConfig) {
		const resolvedCwd = resolvePath(config.cwd);
		this._cwd = safeRealpath(resolvedCwd);
		this._db = config.db;
		this._promptFn = config.promptFn;
		this._onGrantChange = config.onGrantChange;

		// Workspace roots: auto-allowed directories (git common dir, phi infra dirs)
		this._workspaceRoots = new Set<string>();
		if (config.workspaceRoots) {
			for (const dir of config.workspaceRoots) {
				const expanded = expandTilde(dir);
				const resolved = safeRealpath(resolvePath(expanded));
				this._workspaceRoots.add(resolved);
			}
		}

		// Safe files: individual files auto-allowed without prompting
		this._safeFiles = new Set<string>();
		if (config.safeFiles) {
			for (const file of config.safeFiles) {
				const expanded = expandTilde(file);
				const resolved = safeRealpath(resolvePath(expanded));
				this._safeFiles.add(resolved);
			}
		}

		this._preAllowedDirs = new Set<string>();
		for (const dir of config.preAllowedDirs) {
			const expanded = expandTilde(dir);
			const resolved = safeRealpath(resolvePath(expanded));
			this._preAllowedDirs.add(resolved);
			this._db.setPreAllowedDir(resolved);
		}

		if (config.legacyJsonPath) {
			this._db.migrateFromJson(config.legacyJsonPath);
		}
	}

	setPromptFn(fn: PermissionPromptFn): void {
		this._promptFn = fn;
	}

	/**
	 * Add individual files to the safe-files set at runtime.
	 * Called after discovery of context files and skills.
	 */
	addSafeFiles(files: string[]): void {
		for (const file of files) {
			const expanded = expandTilde(file);
			const resolved = safeRealpath(resolvePath(expanded));
			this._safeFiles.add(resolved);
		}
	}

	get cwd(): string {
		return this._cwd;
	}

	get db(): PermissionDb {
		return this._db;
	}

	// =========================================================================
	// Core API
	// =========================================================================

	isWithinCwd(absolutePath: string): boolean {
		const resolved = safeRealpath(resolvePath(absolutePath));
		return resolved === this._cwd || resolved.startsWith(`${this._cwd}/`);
	}

	/**
	 * Check if a path is within any workspace root (git common dir, phi infra dirs).
	 * These directories are auto-allowed without prompting.
	 */
	isWithinWorkspaceRoots(absolutePath: string): boolean {
		const resolved = safeRealpath(resolvePath(absolutePath));
		for (const root of this._workspaceRoots) {
			if (resolved === root || resolved.startsWith(`${root}/`)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check if a specific file is allowed. Checks (in order):
	 *   1. Within CWD → granted
	 *   2. Within workspace roots → granted
	 *   3. In safeFiles set → granted
	 *   4. Falls through to directory check
	 *
	 * Use this for file-targeted tools (read, write, edit) where
	 * a specific file in a restricted directory may be safe.
	 */
	checkFile(absolutePath: string, action: PermissionAction = "fs_read"): PermissionCheckResult {
		const resolved = safeRealpath(resolvePath(absolutePath));

		// CWD and workspace roots cover the file
		if (this.isWithinCwd(resolved)) {
			return { status: "granted", scope: "session" };
		}
		if (this.isWithinWorkspaceRoots(resolved)) {
			return { status: "granted", scope: "session" };
		}

		// Exact file match in safeFiles
		if (this._safeFiles.has(resolved)) {
			this._logCheck("directory", action, resolved, "granted", "safe_file");
			return { status: "granted", scope: "session" };
		}

		// Fall through to directory-level check on the file's parent
		return this.checkDirectory(dirname(resolved), action);
	}

	/**
	 * Request permission for a specific file. Checks file-level grants first,
	 * then falls through to directory request.
	 */
	async requestFile(
		absolutePath: string,
		toolName: string,
		action: PermissionAction = "fs_read",
	): Promise<PermissionCheckResult> {
		const resolved = safeRealpath(resolvePath(absolutePath));

		const existing = this.checkFile(resolved, action);
		if (existing.status === "granted") {
			return existing;
		}

		// File not auto-allowed — request at directory level
		return this.requestDirectory(dirname(resolved), toolName, action);
	}

	checkDirectory(absolutePath: string, action: PermissionAction = "fs_read"): PermissionCheckResult {
		const resolved = safeRealpath(resolvePath(absolutePath));

		if (this.isWithinCwd(resolved)) {
			return { status: "granted", scope: "session" };
		}

		if (this.isWithinWorkspaceRoots(resolved)) {
			return { status: "granted", scope: "session" };
		}

		if (this._isPreAllowed(resolved)) {
			this._logCheck("directory", action, resolved, "granted", "pre_allowed");
			return { status: "granted", scope: "persistent" };
		}

		const onceKey = this._grantKey("directory", action, resolved);
		if (this._onceGrants.has(onceKey)) {
			this._logCheck("directory", action, resolved, "granted", "once");
			return { status: "granted", scope: "once" };
		}

		// Check once grants with ancestor matching (grant on /a covers /a/b)
		if (this._matchesOnceGrantWithAncestors("directory", action, resolved)) {
			this._logCheck("directory", action, resolved, "granted", "once");
			return { status: "granted", scope: "once" };
		}

		if (this._sessionGrants.has(onceKey)) {
			this._logCheck("directory", action, resolved, "granted", "session");
			return { status: "granted", scope: "session" };
		}

		// Check session grants with ancestor matching (grant on /a covers /a/b)
		if (this._matchesSessionGrantWithAncestors("directory", action, resolved)) {
			this._logCheck("directory", action, resolved, "granted", "session");
			return { status: "granted", scope: "session" };
		}

		// Check persistent grants with ancestor/prefix matching
		const dbGrants = this._db.findActiveGrantsWithAncestors("directory", action, resolved);
		if (dbGrants.length > 0) {
			this._logCheck("directory", action, resolved, "granted", "persistent");
			return { status: "granted", scope: "persistent" };
		}

		this._logCheck("directory", action, resolved, "denied");
		return { status: "denied" };
	}

	async requestDirectory(
		absolutePath: string,
		toolName: string,
		action: PermissionAction = "fs_read",
	): Promise<PermissionCheckResult> {
		const resolved = safeRealpath(resolvePath(absolutePath));

		const existing = this.checkDirectory(resolved, action);
		if (existing.status === "granted") {
			return existing;
		}

		// Auto-reject requests for non-existing directories — no point
		// prompting the user for a path that doesn't exist on disk.
		if (!existsSync(resolved)) {
			this._db.logAudit({
				event: "request",
				type: "directory",
				action,
				resource: resolved,
				toolName,
				result: "denied",
				reason: "path_not_found",
			});
			return { status: "denied", userMessage: `Path does not exist: ${resolved}` };
		}

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

	async grant(
		type: PermissionType,
		resource: string,
		scope: PermissionScope,
		action: PermissionAction = "fs_read",
		toolName?: string,
	): Promise<void> {
		const resolved =
			type === "directory"
				? safeRealpath(resolvePath(resource))
				: type === "network"
					? resource.toLowerCase()
					: resource;
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

		if ((action === "fs_write" && type === "directory") || (action === "net_connect" && type === "network")) {
			await this._notifyGrantChange();
		}
	}

	clearOnceGrants(): void {
		this._onceGrants.clear();
	}

	clearSessionGrants(): void {
		this._sessionGrants.clear();
		this._onceGrants.clear();
	}

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

	revokePersistent(type: PermissionType, resource: string, action: PermissionAction = "fs_read"): boolean {
		const resolved = type === "directory" ? safeRealpath(resolvePath(resource)) : resource;

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

	close(): void {
		this._db.close();
	}

	// =========================================================================
	// Network API
	// =========================================================================

	checkNetwork(host: string, action: PermissionAction = "net_connect"): PermissionCheckResult {
		const normalized = host.toLowerCase();

		const onceKey = this._grantKey("network", action, normalized);
		if (this._onceGrants.has(onceKey)) {
			this._logCheck("network", action, normalized, "granted", "once");
			return { status: "granted", scope: "once" };
		}

		if (this._sessionGrants.has(onceKey)) {
			this._logCheck("network", action, normalized, "granted", "session");
			return { status: "granted", scope: "session" };
		}

		const dbGrants = this._db.findActiveGrants("network", action, normalized);
		if (dbGrants.length > 0) {
			this._logCheck("network", action, normalized, "granted", "persistent");
			return { status: "granted", scope: "persistent" };
		}

		this._logCheck("network", action, normalized, "denied");
		return { status: "denied" };
	}

	async requestNetwork(host: string, toolName: string, port?: number): Promise<PermissionCheckResult> {
		const normalized = host.toLowerCase();

		const existing = this.checkNetwork(normalized);
		if (existing.status === "granted") {
			return existing;
		}

		if (!this._promptFn) {
			this._db.logAudit({
				event: "request",
				type: "network",
				action: "net_connect",
				resource: normalized,
				toolName,
				result: "denied",
				reason: "no_prompt",
			});
			return { status: "denied" };
		}

		const portSuffix = port ? `:${port}` : "";
		const request: PermissionRequest<"network"> = {
			type: "network",
			detail: { host: normalized, port },
			toolName,
			description: `Network access to ${normalized}${portSuffix}`,
		};

		this._db.logAudit({
			event: "prompt",
			type: "network",
			action: "net_connect",
			resource: normalized,
			toolName,
		});

		const result = await this._promptFn(request);
		return this._applyPromptResult("network", "net_connect", normalized, toolName, result);
	}

	getAllowedDomains(): string[] {
		const domains = new Set<string>();

		for (const key of this._onceGrants) {
			const parts = key.split(":");
			if (parts[0] === "network" && parts[1] === "net_connect" && parts[2]) {
				domains.add(parts[2]);
			}
		}

		for (const grant of this._sessionGrants.values()) {
			if (grant.action === "net_connect" && grant.type === "network") {
				domains.add(grant.resource);
			}
		}

		for (const row of this._db.findAllActiveGrants()) {
			if (row.action === "net_connect" && row.type === "network") {
				domains.add(row.resource);
			}
		}

		return [...domains];
	}

	getAllowedWritePaths(): string[] {
		const paths = new Set<string>();
		paths.add(this._cwd);
		paths.add("/tmp");

		for (const root of this._workspaceRoots) {
			paths.add(root);
		}

		for (const dir of this._preAllowedDirs) {
			paths.add(dir);
		}

		for (const grant of this._sessionGrants.values()) {
			if (grant.action === "fs_write" && grant.type === "directory") {
				paths.add(grant.resource);
			}
		}

		for (const row of this._db.findAllActiveGrants()) {
			if (row.action === "fs_write" && row.type === "directory") {
				paths.add(row.resource);
			}
		}

		return Array.from(paths);
	}

	// =========================================================================
	// Internal
	// =========================================================================

	/**
	 * Check if a resolved path is covered by any once-grant with ancestor matching.
	 * E.g., a grant on "directory:fs_read:/a" covers "/a/b/c".
	 */
	private _matchesOnceGrantWithAncestors(type: PermissionType, action: PermissionAction, resolved: string): boolean {
		const prefix = `${type}:${action}:`;
		for (const key of this._onceGrants) {
			if (!key.startsWith(prefix)) continue;
			const grantedResource = key.slice(prefix.length);
			if (resolved.startsWith(`${grantedResource}/`)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check if a resolved path is covered by any session-grant with ancestor matching.
	 * E.g., a grant on "directory:fs_write:/a" covers "/a/b/c".
	 */
	private _matchesSessionGrantWithAncestors(
		type: PermissionType,
		action: PermissionAction,
		resolved: string,
	): boolean {
		for (const [_key, grant] of this._sessionGrants) {
			if (grant.type !== type || grant.action !== action) continue;
			if (resolved.startsWith(`${grant.resource}/`)) {
				return true;
			}
		}
		return false;
	}

	private async _applyPromptResult(
		type: PermissionType,
		action: PermissionAction,
		resource: string,
		toolName: string,
		result: PermissionPromptResult,
	): Promise<PermissionCheckResult> {
		if (result.action === "allow") {
			await this.grant(type, resource, result.scope, action, toolName);
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

	private _isPreAllowed(absolutePath: string): boolean {
		for (const dir of this._preAllowedDirs) {
			if (absolutePath === dir || absolutePath.startsWith(`${dir}/`)) {
				return true;
			}
		}
		return false;
	}

	private _grantKey(type: PermissionType, action: PermissionAction, resource: string): string {
		return `${type}:${action}:${resource}`;
	}

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

	private async _notifyGrantChange(): Promise<void> {
		if (this._onGrantChange) {
			await this._onGrantChange(this.getAllowedWritePaths());
		}
	}
}
