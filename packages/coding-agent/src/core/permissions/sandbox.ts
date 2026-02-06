/**
 * Pluggable sandbox provider for OS-level command sandboxing.
 *
 * Two implementations:
 *   - SandboxRuntimeProvider: wraps @anthropic-ai/sandbox-runtime (host mode)
 *   - ContainerSandboxProvider: validates against container mounts (container mode)
 *
 * Sandbox is ALWAYS enforced. No noop provider. No disable flag.
 */

import { existsSync } from "node:fs";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SandboxConfig {
	/** Directories allowed for write access */
	allowedWritePaths: string[];
	/** Directories denied for read access (sensitive dirs) */
	deniedReadPaths: string[];
	/** Domains allowed for network access */
	allowedDomains: string[];
}

export interface SandboxProvider {
	/** Wrap a command string with sandbox enforcement. Returns the sandboxed command string. */
	wrapCommand(command: string, cwd: string): Promise<string>;
	/** Update sandbox configuration when permission grants change */
	updateConfig(config: SandboxConfig): Promise<void>;
	/** Clean up sandbox resources */
	dispose(): Promise<void>;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Sensitive directories denied for read access by default */
export const DEFAULT_DENIED_READ_PATHS: string[] = [
	"~/.ssh",
	"~/.aws",
	"~/.gnupg",
	"~/.config/gcloud",
	"~/.azure",
	"~/.kube/config",
	"~/.npmrc",
	"~/.pypirc",
	"~/.netrc",
	"~/.docker/config.json",
	"~/.git-credentials",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Convert SandboxConfig to @anthropic-ai/sandbox-runtime config format */
function toRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
	return {
		network: {
			allowedDomains: config.allowedDomains,
			deniedDomains: [],
		},
		filesystem: {
			denyRead: config.deniedReadPaths,
			allowWrite: config.allowedWritePaths,
			denyWrite: [],
		},
	};
}

/** Detect if running inside a container */
function isContainerEnvironment(): boolean {
	if (process.env.PHI_CONTAINER === "1") return true;
	try {
		return existsSync("/.dockerenv");
	} catch {
		return false;
	}
}

// ── SandboxRuntimeProvider ──────────────────────────────────────────────────

/**
 * Host-mode sandbox using @anthropic-ai/sandbox-runtime.
 * Uses Seatbelt (macOS) or bubblewrap (Linux) for kernel-level enforcement.
 */
export class SandboxRuntimeProvider implements SandboxProvider {
	private _config: SandboxConfig;

	private constructor(config: SandboxConfig) {
		this._config = config;
	}

	/**
	 * Create and initialize a SandboxRuntimeProvider.
	 * Throws if sandbox initialization fails (missing bwrap/sandbox-exec).
	 */
	static async create(config: SandboxConfig): Promise<SandboxRuntimeProvider> {
		const provider = new SandboxRuntimeProvider(config);
		await provider._init();
		return provider;
	}

	private async _init(): Promise<void> {
		await SandboxManager.initialize(toRuntimeConfig(this._config));
	}

	async wrapCommand(command: string, _cwd: string): Promise<string> {
		return SandboxManager.wrapWithSandbox(command);
	}

	async updateConfig(config: SandboxConfig): Promise<void> {
		this._config = config;
		await SandboxManager.initialize(toRuntimeConfig(config));
	}

	async dispose(): Promise<void> {
		// SandboxManager is static/global — no cleanup needed
	}
}

// ── ContainerSandboxProvider ────────────────────────────────────────────────

/**
 * Container-mode sandbox. The container itself is the enforcement boundary.
 * Only mounted directories are visible. Validates CWD against known mounts.
 */
export class ContainerSandboxProvider implements SandboxProvider {
	private _mountedPaths: string[];

	constructor(mountedPaths: string[]) {
		this._mountedPaths = mountedPaths;
	}

	async wrapCommand(command: string, cwd: string): Promise<string> {
		// Validate CWD is within mounted paths
		const isValidCwd = this._mountedPaths.some((mount) => cwd === mount || cwd.startsWith(`${mount}/`));
		if (!isValidCwd) {
			throw new Error(`CWD "${cwd}" is not within any mounted path. Mounted: ${this._mountedPaths.join(", ")}`);
		}
		// Container IS the sandbox — return command unchanged
		return command;
	}

	async updateConfig(config: SandboxConfig): Promise<void> {
		// Update mounted paths from new write-allowed config
		this._mountedPaths = config.allowedWritePaths;
	}

	async dispose(): Promise<void> {
		// No cleanup needed
	}
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the appropriate SandboxProvider for the current environment.
 *
 * - Container detected → ContainerSandboxProvider
 * - Host mode → SandboxRuntimeProvider (MUST succeed or throws)
 *
 * NEVER returns a noop provider. Sandbox is always enforced.
 */
export async function createSandboxProvider(config: SandboxConfig): Promise<SandboxProvider> {
	if (isContainerEnvironment()) {
		// In container mode, mounted paths come from config's allowedWritePaths
		// (the container only has these paths mounted)
		return new ContainerSandboxProvider(config.allowedWritePaths);
	}

	try {
		return await SandboxRuntimeProvider.create(config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to initialize sandbox: ${message}\n` +
				"Sandbox is mandatory and cannot be disabled.\n" +
				"Ensure bubblewrap (Linux) or sandbox-exec (macOS) is available.",
		);
	}
}
