/**
 * Sandbox system types.
 */

// ── Platform ────────────────────────────────────────────────────────────────

export type Platform = "macos" | "linux" | "windows" | "unknown";

// ── Sandbox Config ──────────────────────────────────────────────────────────

export interface SandboxConfig {
	/** Directories allowed for write access */
	allowedWritePaths: string[];
	/** Directories denied for read access (sensitive dirs) */
	deniedReadPaths: string[];
	/** Domains allowed for network access */
	allowedDomains: string[];
}

/** Internal runtime config used by the sandbox engine */
export interface SandboxRuntimeConfig {
	network: {
		allowedDomains: string[];
		deniedDomains: string[];
	};
	filesystem: {
		denyRead: string[];
		allowWrite: string[];
		denyWrite: string[];
	};
}

// ── Sandbox Provider Interface ──────────────────────────────────────────────

export interface SandboxProvider {
	/** Wrap a command string with sandbox enforcement. Returns the sandboxed command string. */
	wrapCommand(command: string, cwd: string): Promise<string>;
	/** Update sandbox configuration when permission grants change */
	updateConfig(config: SandboxConfig): Promise<void>;
	/** Clean up sandbox resources */
	dispose(): Promise<void>;
}

// ── FS Restriction Configs ──────────────────────────────────────────────────

export interface FsReadRestrictionConfig {
	denyOnly: string[];
}

export interface FsWriteRestrictionConfig {
	allowOnly: string[];
	denyWithinAllow: string[];
}

// ── Violation ───────────────────────────────────────────────────────────────

export interface SandboxViolationEvent {
	line: string;
	command?: string;
	encodedCommand?: string;
	timestamp: Date;
}

export type SandboxViolationCallback = (violation: SandboxViolationEvent) => void;

// ── Dependency Check ────────────────────────────────────────────────────────

export interface SandboxDependencyCheck {
	warnings: string[];
	errors: string[];
}
