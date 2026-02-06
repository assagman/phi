export { extractHostsFromCommand } from "./bash-domain-extractor.js";
export { extractPathsFromCommand, isOutsideCwd } from "./bash-path-extractor.js";
export { type AuditRow, type GrantRow, PermissionDb } from "./permission-db.js";
export { type GrantChangeCallback, PermissionManager, type PermissionManagerConfig } from "./permission-manager.js";
export type {
	PermissionAction,
	PermissionCheckResult,
	PermissionDenial,
	PermissionGrant,
	PermissionPromptFn,
	PermissionPromptResult,
	PermissionRequest,
	PermissionRequestMap,
	PermissionScope,
	PermissionType,
	PersistedPermissions,
} from "./types.js";
export { wrapToolRegistryWithPermissions, wrapToolsWithPermissions } from "./wrap-tools.js";
