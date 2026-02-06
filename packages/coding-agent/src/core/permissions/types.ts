/**
 * Generic permission system types.
 *
 * Designed to be extensible: new permission types (network, secrets, tool-usage)
 * can be added by extending PermissionRequestMap via declaration merging.
 *
 * @example
 * ```typescript
 * // Future extension:
 * declare module "./types.js" {
 *   interface PermissionRequestMap {
 *     secret: { name: string };
 *   }
 * }
 * ```
 */

// ── Permission Actions ──────────────────────────────────────────────────────

/** Granular permission actions for per-tool, per-operation grants */
export type PermissionAction = "fs_read" | "fs_write" | "net_connect";

// ── Permission Request Map ──────────────────────────────────────────────────
// Extensible via declaration merging. Each key is a permission type,
// value is the type-specific payload.

export interface PermissionRequestMap {
	directory: { path: string; action: PermissionAction };
	network: { host: string; port?: number };
}

export type PermissionType = keyof PermissionRequestMap;

// ── Request & Response ──────────────────────────────────────────────────────

export interface PermissionRequest<T extends PermissionType = PermissionType> {
	/** The permission type being requested */
	type: T;
	/** Type-specific details */
	detail: PermissionRequestMap[T];
	/** Which tool is requesting the permission */
	toolName: string;
	/** Human-readable description of what is being requested */
	description: string;
}

/** How long a grant lasts */
export type PermissionScope = "once" | "session" | "persistent";

export interface PermissionGrant {
	type: PermissionType;
	/** Granular action (fs_read, fs_write, net_connect) */
	action: PermissionAction;
	/** The granted resource identifier (e.g., normalized directory path or domain) */
	resource: string;
	scope: PermissionScope;
	/** Which tool triggered the grant (nullable for manual grants) */
	toolName?: string;
	/** ISO timestamp of when the grant was created */
	grantedAt: string;
	/** ISO timestamp for TTL-based expiry (nullable) */
	expiresAt?: string;
	/** ISO timestamp of revocation (nullable, set on revoke) */
	revokedAt?: string;
}

export interface PermissionDenial {
	/** Optional user-provided alternative suggestion */
	userMessage?: string;
}

export type PermissionCheckResult =
	| { status: "granted"; scope: PermissionScope }
	| { status: "denied"; userMessage?: string };

export type PermissionPromptResult =
	| { action: "allow"; scope: PermissionScope }
	| { action: "deny"; userMessage?: string };

// ── Prompt Callback ─────────────────────────────────────────────────────────
// The UI layer provides this to the permission manager.

export type PermissionPromptFn = (request: PermissionRequest) => Promise<PermissionPromptResult>;

// ── Legacy Persistent Storage Format (for migration only) ───────────────────

export interface PersistedPermissions {
	grants: PermissionGrant[];
}
