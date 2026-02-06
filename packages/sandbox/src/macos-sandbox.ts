/**
 * macOS Seatbelt sandbox profile generation and command wrapping.
 *
 * Generates an Apple Sandbox (.sb) profile and wraps commands with
 * `sandbox-exec -p <profile> bash -c <command>`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { quote } from "shell-quote";
import type { IgnoreViolationsConfig } from "./sandbox-manager.js";
import {
	containsGlobChars,
	DANGEROUS_FILES,
	decodeSandboxedCommand,
	encodeSandboxedCommand,
	generateProxyEnvVars,
	getDangerousDirectories,
	globToRegex,
	normalizePathForSandbox,
} from "./sandbox-utils.js";
import type { FsReadRestrictionConfig, FsWriteRestrictionConfig, SandboxViolationCallback } from "./types.js";
import { whichSync } from "./which.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface MacOSSandboxParams {
	command: string;
	needsNetworkRestriction: boolean;
	httpProxyPort?: number;
	socksProxyPort?: number;
	allowUnixSockets?: string[];
	allowAllUnixSockets?: boolean;
	allowLocalBinding?: boolean;
	readConfig: FsReadRestrictionConfig | undefined;
	writeConfig: FsWriteRestrictionConfig | undefined;
	ignoreViolations?: IgnoreViolationsConfig | undefined;
	allowPty?: boolean;
	allowGitConfig?: boolean;
	binShell?: string;
}

// ── Session tag ─────────────────────────────────────────────────────────────

const sessionSuffix = `_${Math.random().toString(36).slice(2, 11)}_SBX`;

function generateLogTag(command: string): string {
	const encodedCommand = encodeSandboxedCommand(command);
	return `CMD64_${encodedCommand}_END_${sessionSuffix}`;
}

// ── Mandatory deny patterns ─────────────────────────────────────────────────

export function macGetMandatoryDenyPatterns(allowGitConfig = false): string[] {
	const cwd = process.cwd();
	const denyPaths: string[] = [];

	for (const fileName of DANGEROUS_FILES) {
		denyPaths.push(resolvePath(cwd, fileName));
		denyPaths.push(`**/${fileName}`);
	}

	for (const dirName of getDangerousDirectories()) {
		denyPaths.push(resolvePath(cwd, dirName));
		denyPaths.push(`**/${dirName}`);
	}

	// Always deny .git/hooks (both regular and bare repo patterns)
	denyPaths.push(resolvePath(cwd, ".git/hooks"));
	denyPaths.push("**/.git/hooks");
	// Bare repos use repo.git/ instead of .git/ — cover *.git/hooks too
	denyPaths.push("**/*.git/hooks");

	if (!allowGitConfig) {
		denyPaths.push(resolvePath(cwd, ".git/config"));
		denyPaths.push("**/.git/config");
		// Bare repo config
		denyPaths.push("**/*.git/config");
	}

	return [...new Set(denyPaths)];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapePath(pathStr: string): string {
	return JSON.stringify(pathStr);
}

function getAncestorDirectories(pathStr: string): string[] {
	const ancestors: string[] = [];
	let currentPath = dirname(pathStr);
	while (currentPath !== "/" && currentPath !== ".") {
		ancestors.push(currentPath);
		const parentPath = dirname(currentPath);
		if (parentPath === currentPath) break;
		currentPath = parentPath;
	}
	return ancestors;
}

function getTmpdirParentIfMacOSPattern(): string[] {
	const tmpdir = process.env.TMPDIR;
	if (!tmpdir) return [];

	const match = tmpdir.match(/^\/(private\/)?var\/folders\/[^/]{2}\/[^/]+\/T\/?$/);
	if (!match) return [];

	const parent = tmpdir.replace(/\/T\/?$/, "");
	if (parent.startsWith("/private/var/")) {
		return [parent, parent.replace("/private", "")];
	}
	if (parent.startsWith("/var/")) {
		return [parent, `/private${parent}`];
	}
	return [parent];
}

// ── Rule generation ─────────────────────────────────────────────────────────

function generateMoveBlockingRules(pathPatterns: string[], logTag: string): string[] {
	const rules: string[] = [];
	for (const pathPattern of pathPatterns) {
		const normalizedPath = normalizePathForSandbox(pathPattern);
		if (containsGlobChars(normalizedPath)) {
			const regexPattern = globToRegex(normalizedPath);
			rules.push(
				`(deny file-write-unlink`,
				`  (regex ${escapePath(regexPattern)})`,
				`  (with message "${logTag}"))`,
			);
			const staticPrefix = normalizedPath.split(/[*?[\]]/)[0];
			if (staticPrefix && staticPrefix !== "/") {
				const baseDir = staticPrefix.endsWith("/") ? staticPrefix.slice(0, -1) : dirname(staticPrefix);
				rules.push(
					`(deny file-write-unlink`,
					`  (literal ${escapePath(baseDir)})`,
					`  (with message "${logTag}"))`,
				);
				for (const ancestorDir of getAncestorDirectories(baseDir)) {
					rules.push(
						`(deny file-write-unlink`,
						`  (literal ${escapePath(ancestorDir)})`,
						`  (with message "${logTag}"))`,
					);
				}
			}
		} else {
			rules.push(
				`(deny file-write-unlink`,
				`  (subpath ${escapePath(normalizedPath)})`,
				`  (with message "${logTag}"))`,
			);
			for (const ancestorDir of getAncestorDirectories(normalizedPath)) {
				rules.push(
					`(deny file-write-unlink`,
					`  (literal ${escapePath(ancestorDir)})`,
					`  (with message "${logTag}"))`,
				);
			}
		}
	}
	return rules;
}

function generateReadRules(config: FsReadRestrictionConfig | undefined, logTag: string): string[] {
	if (!config) return ["(allow file-read*)"];

	const rules: string[] = ["(allow file-read*)"];

	for (const pathPattern of config.denyOnly || []) {
		const normalizedPath = normalizePathForSandbox(pathPattern);
		if (containsGlobChars(normalizedPath)) {
			const regexPattern = globToRegex(normalizedPath);
			rules.push(`(deny file-read*`, `  (regex ${escapePath(regexPattern)})`, `  (with message "${logTag}"))`);
		} else {
			rules.push(`(deny file-read*`, `  (subpath ${escapePath(normalizedPath)})`, `  (with message "${logTag}"))`);
		}
	}

	rules.push(...generateMoveBlockingRules(config.denyOnly || [], logTag));
	return rules;
}

function generateWriteRules(
	config: FsWriteRestrictionConfig | undefined,
	logTag: string,
	allowGitConfig = false,
): string[] {
	if (!config) return ["(allow file-write*)"];

	const rules: string[] = [];

	// Allow tmpdir parent paths on macOS
	const tmpdirParents = getTmpdirParentIfMacOSPattern();
	for (const tmpdirParent of tmpdirParents) {
		const normalizedPath = normalizePathForSandbox(tmpdirParent);
		rules.push(`(allow file-write*`, `  (subpath ${escapePath(normalizedPath)})`, `  (with message "${logTag}"))`);
	}

	for (const pathPattern of config.allowOnly || []) {
		const normalizedPath = normalizePathForSandbox(pathPattern);
		if (containsGlobChars(normalizedPath)) {
			const regexPattern = globToRegex(normalizedPath);
			rules.push(`(allow file-write*`, `  (regex ${escapePath(regexPattern)})`, `  (with message "${logTag}"))`);
		} else {
			rules.push(`(allow file-write*`, `  (subpath ${escapePath(normalizedPath)})`, `  (with message "${logTag}"))`);
		}
	}

	const denyPaths = [...(config.denyWithinAllow || []), ...macGetMandatoryDenyPatterns(allowGitConfig)];
	for (const pathPattern of denyPaths) {
		const normalizedPath = normalizePathForSandbox(pathPattern);
		if (containsGlobChars(normalizedPath)) {
			const regexPattern = globToRegex(normalizedPath);
			rules.push(`(deny file-write*`, `  (regex ${escapePath(regexPattern)})`, `  (with message "${logTag}"))`);
		} else {
			rules.push(`(deny file-write*`, `  (subpath ${escapePath(normalizedPath)})`, `  (with message "${logTag}"))`);
		}
	}

	rules.push(...generateMoveBlockingRules(denyPaths, logTag));
	return rules;
}

// ── Profile generation ──────────────────────────────────────────────────────

function generateSandboxProfile(opts: {
	readConfig: FsReadRestrictionConfig | undefined;
	writeConfig: FsWriteRestrictionConfig | undefined;
	httpProxyPort?: number;
	socksProxyPort?: number;
	needsNetworkRestriction: boolean;
	allowUnixSockets?: string[];
	allowAllUnixSockets?: boolean;
	allowLocalBinding?: boolean;
	allowPty?: boolean;
	allowGitConfig?: boolean;
	logTag: string;
}): string {
	const profile: string[] = [
		"(version 1)",
		`(deny default (with message "${opts.logTag}"))`,
		"",
		`;LogTag:${opts.logTag}`,
		"",
		";Essential permissions",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow process-info* (target same-sandbox))",
		"(allow signal (target same-sandbox))",
		"(allow mach-priv-task-port (target same-sandbox))",
		"",
		"(allow user-preference-read)",
		"",
		";Mach IPC",
		"(allow mach-lookup",
		'  (global-name "com.apple.audio.systemsoundserver")',
		'  (global-name "com.apple.distributed_notifications@Uv3")',
		'  (global-name "com.apple.FontObjectsServer")',
		'  (global-name "com.apple.fonts")',
		'  (global-name "com.apple.logd")',
		'  (global-name "com.apple.lsd.mapdb")',
		'  (global-name "com.apple.PowerManagement.control")',
		'  (global-name "com.apple.system.logger")',
		'  (global-name "com.apple.system.notification_center")',
		'  (global-name "com.apple.system.opendirectoryd.libinfo")',
		'  (global-name "com.apple.system.opendirectoryd.membership")',
		'  (global-name "com.apple.bsd.dirhelper")',
		'  (global-name "com.apple.securityd.xpc")',
		'  (global-name "com.apple.coreservices.launchservicesd")',
		"",
		"  ;TLS certificate verification (Security.framework / SecTrustEvaluateWithError)",
		'  (global-name "com.apple.trustd.agent")',
		'  (global-name "com.apple.ocspd")',
		'  (global-name "com.apple.networkd")',
		'  (global-name "com.apple.SystemConfiguration.DNSConfiguration")',
		'  (global-name "com.apple.SystemConfiguration.configd")',
		")",
		"",
		"(allow ipc-posix-shm)",
		"(allow ipc-posix-sem)",
		"",
		"(allow iokit-open",
		'  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
		'  (iokit-registry-entry-class "RootDomainUserClient")',
		'  (iokit-user-client-class "IOSurfaceSendRight")',
		")",
		"(allow iokit-get-properties)",
		"",
		"(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
		"",
		";sysctl",
		"(allow sysctl-read",
		'  (sysctl-name "hw.activecpu")',
		'  (sysctl-name "hw.busfrequency_compat")',
		'  (sysctl-name "hw.byteorder")',
		'  (sysctl-name "hw.cacheconfig")',
		'  (sysctl-name "hw.cachelinesize_compat")',
		'  (sysctl-name "hw.cpufamily")',
		'  (sysctl-name "hw.cpufrequency")',
		'  (sysctl-name "hw.cpufrequency_compat")',
		'  (sysctl-name "hw.cputype")',
		'  (sysctl-name "hw.l1dcachesize_compat")',
		'  (sysctl-name "hw.l1icachesize_compat")',
		'  (sysctl-name "hw.l2cachesize_compat")',
		'  (sysctl-name "hw.l3cachesize_compat")',
		'  (sysctl-name "hw.logicalcpu")',
		'  (sysctl-name "hw.logicalcpu_max")',
		'  (sysctl-name "hw.machine")',
		'  (sysctl-name "hw.memsize")',
		'  (sysctl-name "hw.ncpu")',
		'  (sysctl-name "hw.nperflevels")',
		'  (sysctl-name "hw.packages")',
		'  (sysctl-name "hw.pagesize_compat")',
		'  (sysctl-name "hw.pagesize")',
		'  (sysctl-name "hw.physicalcpu")',
		'  (sysctl-name "hw.physicalcpu_max")',
		'  (sysctl-name "hw.tbfrequency_compat")',
		'  (sysctl-name "hw.vectorunit")',
		'  (sysctl-name "kern.argmax")',
		'  (sysctl-name "kern.bootargs")',
		'  (sysctl-name "kern.hostname")',
		'  (sysctl-name "kern.maxfiles")',
		'  (sysctl-name "kern.maxfilesperproc")',
		'  (sysctl-name "kern.maxproc")',
		'  (sysctl-name "kern.ngroups")',
		'  (sysctl-name "kern.osproductversion")',
		'  (sysctl-name "kern.osrelease")',
		'  (sysctl-name "kern.ostype")',
		'  (sysctl-name "kern.osvariant_status")',
		'  (sysctl-name "kern.osversion")',
		'  (sysctl-name "kern.secure_kernel")',
		'  (sysctl-name "kern.tcsm_available")',
		'  (sysctl-name "kern.tcsm_enable")',
		'  (sysctl-name "kern.usrstack64")',
		'  (sysctl-name "kern.version")',
		'  (sysctl-name "kern.willshutdown")',
		'  (sysctl-name "machdep.cpu.brand_string")',
		'  (sysctl-name "machdep.ptrauth_enabled")',
		'  (sysctl-name "security.mac.lockdown_mode_state")',
		'  (sysctl-name "sysctl.proc_cputype")',
		'  (sysctl-name "vm.loadavg")',
		'  (sysctl-name-prefix "hw.optional.arm")',
		'  (sysctl-name-prefix "hw.optional.arm.")',
		'  (sysctl-name-prefix "hw.optional.armv8_")',
		'  (sysctl-name-prefix "hw.perflevel")',
		'  (sysctl-name-prefix "kern.proc.all")',
		'  (sysctl-name-prefix "kern.proc.pgrp.")',
		'  (sysctl-name-prefix "kern.proc.pid.")',
		'  (sysctl-name-prefix "machdep.cpu.")',
		'  (sysctl-name-prefix "net.routetable.")',
		")",
		"",
		"(allow sysctl-write",
		'  (sysctl-name "kern.tcsm_enable")',
		")",
		"",
		"(allow distributed-notification-post)",
		'(allow mach-lookup (global-name "com.apple.SecurityServer"))',
		"",
		";File I/O on device files",
		'(allow file-ioctl (literal "/dev/null"))',
		'(allow file-ioctl (literal "/dev/zero"))',
		'(allow file-ioctl (literal "/dev/random"))',
		'(allow file-ioctl (literal "/dev/urandom"))',
		'(allow file-ioctl (literal "/dev/dtracehelper"))',
		'(allow file-ioctl (literal "/dev/tty"))',
		"",
		"(allow file-ioctl file-read-data file-write-data",
		"  (require-all",
		'    (literal "/dev/null")',
		"    (vnode-type CHARACTER-DEVICE)",
		"  )",
		")",
		"",
	];

	// Network
	profile.push(";Network");
	if (!opts.needsNetworkRestriction) {
		profile.push("(allow network*)");
	} else {
		if (opts.allowLocalBinding) {
			profile.push('(allow network-bind (local ip "localhost:*"))');
			profile.push('(allow network-inbound (local ip "localhost:*"))');
			profile.push('(allow network-outbound (local ip "localhost:*"))');
		}

		if (opts.allowAllUnixSockets) {
			profile.push('(allow network* (subpath "/"))');
		} else if (opts.allowUnixSockets && opts.allowUnixSockets.length > 0) {
			for (const socketPath of opts.allowUnixSockets) {
				const normalizedPath = normalizePathForSandbox(socketPath);
				profile.push(`(allow network* (subpath ${escapePath(normalizedPath)}))`);
			}
		}

		if (opts.httpProxyPort !== undefined) {
			profile.push(`(allow network-bind (local ip "localhost:${opts.httpProxyPort}"))`);
			profile.push(`(allow network-inbound (local ip "localhost:${opts.httpProxyPort}"))`);
			profile.push(`(allow network-outbound (remote ip "localhost:${opts.httpProxyPort}"))`);
		}

		if (opts.socksProxyPort !== undefined) {
			profile.push(`(allow network-bind (local ip "localhost:${opts.socksProxyPort}"))`);
			profile.push(`(allow network-inbound (local ip "localhost:${opts.socksProxyPort}"))`);
			profile.push(`(allow network-outbound (remote ip "localhost:${opts.socksProxyPort}"))`);
		}
	}

	profile.push("");
	profile.push(";File read");
	profile.push(...generateReadRules(opts.readConfig, opts.logTag));
	profile.push("");
	profile.push(";File write");
	profile.push(...generateWriteRules(opts.writeConfig, opts.logTag, opts.allowGitConfig));

	if (opts.allowPty) {
		profile.push("");
		profile.push(";Pseudo-terminal (pty) support");
		profile.push("(allow pseudo-tty)");
		profile.push("(allow file-ioctl");
		profile.push('  (literal "/dev/ptmx")');
		profile.push('  (regex #"^/dev/ttys")');
		profile.push(")");
		profile.push("(allow file-read* file-write*");
		profile.push('  (literal "/dev/ptmx")');
		profile.push('  (regex #"^/dev/ttys")');
		profile.push(")");
	}

	return profile.join("\n");
}

// ── Public API ──────────────────────────────────────────────────────────────

export function wrapCommandWithSandboxMacOS(params: MacOSSandboxParams): string {
	const {
		command,
		needsNetworkRestriction,
		httpProxyPort,
		socksProxyPort,
		allowUnixSockets,
		allowAllUnixSockets,
		allowLocalBinding,
		readConfig,
		writeConfig,
		allowPty,
		allowGitConfig = false,
		binShell,
	} = params;

	const hasReadRestrictions = readConfig && readConfig.denyOnly.length > 0;
	const hasWriteRestrictions = writeConfig !== undefined;

	if (!needsNetworkRestriction && !hasReadRestrictions && !hasWriteRestrictions) {
		return command;
	}

	const logTag = generateLogTag(command);
	const profile = generateSandboxProfile({
		readConfig,
		writeConfig,
		httpProxyPort,
		socksProxyPort,
		needsNetworkRestriction,
		allowUnixSockets,
		allowAllUnixSockets,
		allowLocalBinding,
		allowPty,
		allowGitConfig,
		logTag,
	});

	const proxyEnvArgs = generateProxyEnvVars(httpProxyPort, socksProxyPort);
	const shellName = binShell || "bash";
	const shell = whichSync(shellName);
	if (!shell) {
		throw new Error(`Shell '${shellName}' not found in PATH`);
	}

	return quote(["env", ...proxyEnvArgs, "sandbox-exec", "-p", profile, shell, "-c", command]);
}

// ── Log Monitor ─────────────────────────────────────────────────────────────

export function startMacOSSandboxLogMonitor(
	callback: SandboxViolationCallback,
	ignoreViolations?: IgnoreViolationsConfig,
): () => void {
	const cmdExtractRegex = /CMD64_(.+?)_END/;
	const sandboxExtractRegex = /Sandbox:\s+(.+)$/;

	const wildcardPaths = ignoreViolations?.["*"] || [];
	const commandPatterns = ignoreViolations
		? Object.entries(ignoreViolations).filter(([pattern]) => pattern !== "*")
		: [];

	const logProcess: ChildProcess = spawn("log", [
		"stream",
		"--predicate",
		`(eventMessage ENDSWITH "${sessionSuffix}")`,
		"--style",
		"compact",
	]);

	logProcess.stdout?.on("data", (data: Buffer) => {
		const lines = data.toString().split("\n");
		const violationLine = lines.find((line) => line.includes("Sandbox:") && line.includes("deny"));
		const commandLine = lines.find((line) => line.startsWith("CMD64_"));

		if (!violationLine) return;

		const sandboxMatch = violationLine.match(sandboxExtractRegex);
		if (!sandboxMatch?.[1]) return;

		const violationDetails = sandboxMatch[1];
		let command: string | undefined;
		let encodedCommand: string | undefined;

		if (commandLine) {
			const cmdMatch = commandLine.match(cmdExtractRegex);
			encodedCommand = cmdMatch?.[1];
			if (encodedCommand) {
				try {
					command = decodeSandboxedCommand(encodedCommand);
				} catch {
					// Ignore decode errors
				}
			}
		}

		// Filter noise
		if (
			violationDetails.includes("mDNSResponder") ||
			violationDetails.includes("mach-lookup com.apple.diagnosticd") ||
			violationDetails.includes("mach-lookup com.apple.analyticsd")
		) {
			return;
		}

		if (ignoreViolations && command) {
			if (wildcardPaths.length > 0 && wildcardPaths.some((path) => violationDetails.includes(path))) {
				return;
			}
			for (const [pattern, paths] of commandPatterns) {
				if (command.includes(pattern) && paths.some((path) => violationDetails.includes(path))) {
					return;
				}
			}
		}

		callback({
			line: violationDetails,
			command,
			encodedCommand,
			timestamp: new Date(),
		});
	});

	logProcess.on("error", () => {
		// Failed to start log monitor
	});

	return () => {
		logProcess.kill("SIGTERM");
	};
}
