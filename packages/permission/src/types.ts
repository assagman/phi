/**
 * Permission system types.
 *
 * Extensible via declaration merging on PermissionRequestMap.
 */

// ── Permission Actions ──────────────────────────────────────────────────────

/** Granular permission actions for per-tool, per-operation grants */
export type PermissionAction = "fs_read" | "fs_write" | "net_connect";

// ── Permission Request Map ──────────────────────────────────────────────────

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
	action: PermissionAction;
	/** The granted resource identifier (normalized dir path or domain) */
	resource: string;
	scope: PermissionScope;
	toolName?: string;
	grantedAt: string;
	expiresAt?: string;
	revokedAt?: string;
}

export interface PermissionDenial {
	userMessage?: string;
}

export type PermissionCheckResult =
	| { status: "granted"; scope: PermissionScope }
	| { status: "denied"; userMessage?: string };

export type PermissionPromptResult =
	| { action: "allow"; scope: PermissionScope }
	| { action: "deny"; userMessage?: string };

/** The UI layer provides this to the permission manager. */
export type PermissionPromptFn = (request: PermissionRequest) => Promise<PermissionPromptResult>;

/** Legacy persistent storage format (for migration only) */
export interface PersistedPermissions {
	grants: PermissionGrant[];
}
