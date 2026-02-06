/**
 * Static path extraction from bash commands.
 *
 * Parses command strings for filesystem path tokens to enable
 * permission checking BEFORE execution. Catches ~95% of LLM-generated
 * commands which use literal paths. Not a full bash parser.
 */

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

const SAFE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/urandom"]);

const URL_PREFIXES = ["http://", "https://", "ftp://", "ssh://", "git://", "file://"];

// ── Helpers ─────────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	return p;
}

function isUrl(s: string): boolean {
	const lower = s.toLowerCase();
	return URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function looksLikeFile(p: string): boolean {
	if (p.endsWith("/")) return false;
	const lastSegment = p.split("/").pop() ?? "";
	return lastSegment.includes(".");
}

function toDirectory(absolutePath: string): string {
	if (looksLikeFile(absolutePath)) {
		return dirname(absolutePath);
	}
	return absolutePath.endsWith("/") ? absolutePath.slice(0, -1) : absolutePath;
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
			return s.slice(1, -1);
		}
	}
	return s;
}

// ── Path Pattern Extraction ─────────────────────────────────────────────────

function extractRawPaths(command: string): string[] {
	const paths: string[] = [];
	const normalized = command.replace(/\\\n/g, " ");

	// Pattern 1: Absolute paths
	const absolutePathRe = /(?:^|[\s;|&(=])("\/[^"]*"|'\/[^']*'|\/[^\s;|&)<>*?'"]+)/g;
	let match: RegExpExecArray | null;
	match = absolutePathRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = absolutePathRe.exec(normalized);
	}

	// Pattern 2: Tilde paths
	const tildePathRe = /(?:^|[\s;|&(=])("~\/[^"]*"|'~\/[^']*'|~\/[^\s;|&)<>*?'"]*)/g;
	match = tildePathRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = tildePathRe.exec(normalized);
	}

	// Pattern 3: Bare tilde
	const bareTildeRe = /(?:^|[\s;|&(])("~"|'~'|~)(?=[\s;|&)]|$)/g;
	match = bareTildeRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = bareTildeRe.exec(normalized);
	}

	// Pattern 4: Relative escapes
	const relativeEscapeRe = /(?:^|[\s;|&(=])("\.\.\/[^"]*"|'\.\.\/[^']*'|\.\.\/[^\s;|&)<>*?'"]*)/g;
	match = relativeEscapeRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = relativeEscapeRe.exec(normalized);
	}

	// Pattern 5: cd/pushd targets
	const cdRe = /(?:^|[\s;|&])(?:cd|pushd)\s+("(?:[^"]+)"|'(?:[^']+)'|[^\s;|&)]+)/g;
	match = cdRe.exec(normalized);
	while (match !== null) {
		const target = stripQuotes(match[1].trim());
		if (target && target !== "-" && target !== "~") {
			paths.push(target);
		}
		match = cdRe.exec(normalized);
	}

	// Pattern 6: Redirect targets
	const redirectRe = /[0-9]*>>?\s*("(?:[^"]+)"|'(?:[^']+)'|[^\s;|&)]+)/g;
	match = redirectRe.exec(normalized);
	while (match !== null) {
		const target = stripQuotes(match[1].trim());
		if (target.startsWith("/") || target.startsWith("~") || target.startsWith("..")) {
			paths.push(target);
		}
		match = redirectRe.exec(normalized);
	}

	return paths;
}

function filterEnvAssignments(command: string, paths: string[]): string[] {
	const envAssignRe = /(?:^|[\s;]|&&|\|\|)\s*[A-Za-z_][A-Za-z0-9_]*=(["']?)([^\s;|&]*)\1/g;
	const envPaths = new Set<string>();
	let match = envAssignRe.exec(command);
	while (match !== null) {
		envPaths.add(match[2]);
		match = envAssignRe.exec(command);
	}

	if (envPaths.size === 0) return paths;
	return paths.filter((p) => !envPaths.has(p));
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isOutsideCwd(absolutePath: string, cwd: string): boolean {
	return absolutePath !== cwd && !absolutePath.startsWith(`${cwd}/`);
}

/**
 * Extract filesystem paths from a bash command that are outside CWD.
 * Returns deduplicated absolute directory paths.
 */
export function extractPathsFromCommand(command: string, cwd: string): string[] {
	let rawPaths = extractRawPaths(command);
	rawPaths = filterEnvAssignments(command, rawPaths);

	const seen = new Set<string>();
	const result: string[] = [];

	for (const raw of rawPaths) {
		if (isUrl(raw)) continue;
		if (!raw || raw === "/") continue;

		const expanded = expandTilde(raw);
		const absolute = resolve(cwd, expanded);

		if (SAFE_PATHS.has(absolute)) continue;

		const dir = toDirectory(absolute);

		if (!isOutsideCwd(dir, cwd)) continue;

		if (seen.has(dir)) continue;
		seen.add(dir);

		result.push(dir);
	}

	return result;
}
