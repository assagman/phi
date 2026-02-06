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
 *     network: { host: string; port?: number };
 *     secret: { name: string };
 *   }
 * }
 * ```
 */

// ── Permission Request Map ──────────────────────────────────────────────────
// Extensible via declaration merging. Each key is a permission type,
// value is the type-specific payload.

export interface PermissionRequestMap {
	directory: { path: string };
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
	/** The granted resource identifier (e.g., normalized directory path) */
	resource: string;
	scope: PermissionScope;
	/** ISO timestamp of when the grant was created */
	grantedAt: string;
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

// ── Persistent Storage Format ───────────────────────────────────────────────

export interface PersistedPermissions {
	grants: PermissionGrant[];
}
