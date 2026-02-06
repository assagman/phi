export { PermissionManager, type PermissionManagerConfig } from "./permission-manager.js";
export type {
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
