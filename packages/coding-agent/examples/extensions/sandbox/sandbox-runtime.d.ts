// Type declarations for @anthropic-ai/sandbox-runtime
// This is an optional dependency used by the sandbox extension example

declare module "@anthropic-ai/sandbox-runtime" {
	export interface SandboxNetworkConfig {
		allowedDomains?: string[];
		deniedDomains?: string[];
	}

	export interface SandboxFilesystemConfig {
		denyRead?: string[];
		allowWrite?: string[];
		denyWrite?: string[];
	}

	export interface SandboxRuntimeConfig {
		network?: SandboxNetworkConfig;
		filesystem?: SandboxFilesystemConfig;
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	}

	export interface SandboxManagerStatic {
		isAvailable(): boolean;
		wrapWithSandbox(command: string): Promise<string>;
		initialize(config: SandboxRuntimeConfig): Promise<void>;
		reset(): Promise<void>;
	}

	export const SandboxManager: SandboxManagerStatic;
}
