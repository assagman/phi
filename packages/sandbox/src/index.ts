// Provider interface and implementations

// Platform detection
export { getPlatform, getWslVersion } from "./platform.js";
// Sandbox manager (for direct access)
export {
	annotateStderrWithSandboxFailures,
	checkDependencies,
	getConfig,
	getSandboxViolationStore,
	initialize,
	isSandboxingEnabled,
	isSupportedPlatform,
	reset,
	updateConfig,
	wrapWithSandbox,
} from "./sandbox-manager.js";
export {
	ContainerSandboxProvider,
	createSandboxProvider,
	DEFAULT_DENIED_READ_PATHS,
	SandboxRuntimeProvider,
} from "./sandbox-provider.js";
// Utilities
export { getDefaultWritePaths } from "./sandbox-utils.js";
// Types
export type {
	FsReadRestrictionConfig,
	FsWriteRestrictionConfig,
	Platform,
	SandboxConfig,
	SandboxDependencyCheck,
	SandboxProvider,
	SandboxRuntimeConfig,
	SandboxViolationCallback,
	SandboxViolationEvent,
} from "./types.js";
// Violation store
export { SandboxViolationStore } from "./violation-store.js";
