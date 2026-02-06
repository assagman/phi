/**
 * SandboxProvider implementations.
 *
 * - SandboxRuntimeProvider: wraps the sandbox manager (host mode)
 * - ContainerSandboxProvider: validates against container mounts (container mode)
 */

import { existsSync } from "node:fs";
import * as SandboxManager from "./sandbox-manager.js";
import type { SandboxConfig, SandboxProvider, SandboxRuntimeConfig } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Sensitive directories denied for read access by default.
 *
 * Note: ~/.ssh is intentionally NOT denied — SSH keys are needed for git push/pull
 * and the network restriction (allowedDomains) prevents key exfiltration.
 */
export const DEFAULT_DENIED_READ_PATHS: string[] = [
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

function isContainerEnvironment(): boolean {
	if (process.env.PHI_CONTAINER === "1") return true;
	try {
		return existsSync("/.dockerenv");
	} catch {
		return false;
	}
}

// ── SandboxRuntimeProvider ──────────────────────────────────────────────────

export class SandboxRuntimeProvider implements SandboxProvider {
	private _config: SandboxConfig;

	private constructor(config: SandboxConfig) {
		this._config = config;
	}

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
		SandboxManager.updateConfig(toRuntimeConfig(config));
	}

	async dispose(): Promise<void> {
		await SandboxManager.reset();
	}
}

// ── ContainerSandboxProvider ────────────────────────────────────────────────

export class ContainerSandboxProvider implements SandboxProvider {
	private _mountedPaths: string[];

	constructor(mountedPaths: string[]) {
		this._mountedPaths = mountedPaths;
	}

	async wrapCommand(command: string, cwd: string): Promise<string> {
		const isValidCwd = this._mountedPaths.some((mount) => cwd === mount || cwd.startsWith(`${mount}/`));
		if (!isValidCwd) {
			throw new Error(`CWD "${cwd}" is not within any mounted path. Mounted: ${this._mountedPaths.join(", ")}`);
		}
		return command;
	}

	async updateConfig(config: SandboxConfig): Promise<void> {
		this._mountedPaths = config.allowedWritePaths;
	}

	async dispose(): Promise<void> {
		// No cleanup needed
	}
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the appropriate SandboxProvider for the current environment.
 * Container detected → ContainerSandboxProvider
 * Host mode → SandboxRuntimeProvider (must succeed or throws)
 */
export async function createSandboxProvider(config: SandboxConfig): Promise<SandboxProvider> {
	if (isContainerEnvironment()) {
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
