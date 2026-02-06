/**
 * Static path extraction from bash commands.
 *
 * Parses command strings for filesystem path tokens to enable
 * permission checking BEFORE execution. Catches ~95% of LLM-generated
 * commands which use literal paths. Not a full bash parser.
 *
 * Defense layer 1: works in all execution modes (host, container).
 */

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

/** Paths that are always safe to access — skip these */
const SAFE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/urandom"]);

/** URL-like prefixes that are not filesystem paths */
const URL_PREFIXES = ["http://", "https://", "ftp://", "ssh://", "git://", "file://"];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Expand ~ to home directory */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	return p;
}

/** Check if a string looks like a URL rather than a path */
function isUrl(s: string): boolean {
	const lower = s.toLowerCase();
	return URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Check if a path looks like a file (has extension or doesn't end with /) */
function looksLikeFile(p: string): boolean {
	if (p.endsWith("/")) return false;
	const lastSegment = p.split("/").pop() ?? "";
	return lastSegment.includes(".");
}

/**
 * Get the directory component of a path.
 * For file-like paths, returns dirname. For directory-like paths, returns as-is.
 */
function toDirectory(absolutePath: string): string {
	if (looksLikeFile(absolutePath)) {
		return dirname(absolutePath);
	}
	// Remove trailing slash for consistency
	return absolutePath.endsWith("/") ? absolutePath.slice(0, -1) : absolutePath;
}

/**
 * Strip balanced quotes from a string.
 * Handles: "path", 'path', but not unbalanced quotes.
 */
function stripQuotes(s: string): string {
	if (s.length >= 2) {
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
			return s.slice(1, -1);
		}
	}
	return s;
}

// ── Path Pattern Extraction ─────────────────────────────────────────────────

/**
 * Extract raw path-like tokens from a command string.
 * Returns unresolved paths as found in the command.
 */
function extractRawPaths(command: string): string[] {
	const paths: string[] = [];

	// Normalize: split multi-line and chained commands into segments
	// Process the whole command as one string — patterns match across segments
	const normalized = command.replace(/\\\n/g, " ");

	// Pattern 1: Absolute paths — /foo/bar (but not // or /\n)
	// Matches paths in various positions: arguments, after operators, etc.
	const absolutePathRe = /(?:^|[\s;|&(=])("\/[^"]*"|'\/[^']*'|\/[^\s;|&)<>*?'"]+)/g;
	let match: RegExpExecArray | null;
	match = absolutePathRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = absolutePathRe.exec(normalized);
	}

	// Pattern 2: Tilde paths — ~/foo, ~/.ssh/id_rsa
	const tildePathRe = /(?:^|[\s;|&(=])("~\/[^"]*"|'~\/[^']*'|~\/[^\s;|&)<>*?'"]*)/g;
	match = tildePathRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = tildePathRe.exec(normalized);
	}

	// Pattern 3: Bare tilde (just ~)
	const bareTildeRe = /(?:^|[\s;|&(])("~"|'~'|~)(?=[\s;|&)]|$)/g;
	match = bareTildeRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = bareTildeRe.exec(normalized);
	}

	// Pattern 4: Relative escapes — ../foo, ../../bar
	const relativeEscapeRe = /(?:^|[\s;|&(=])("\.\.\/[^"]*"|'\.\.\/[^']*'|\.\.\/[^\s;|&)<>*?'"]*)/g;
	match = relativeEscapeRe.exec(normalized);
	while (match !== null) {
		paths.push(stripQuotes(match[1].trim()));
		match = relativeEscapeRe.exec(normalized);
	}

	// Pattern 5: cd/pushd targets — extract the argument
	const cdRe = /(?:^|[\s;|&])(?:cd|pushd)\s+("(?:[^"]+)"|'(?:[^']+)'|[^\s;|&)]+)/g;
	match = cdRe.exec(normalized);
	while (match !== null) {
		const target = stripQuotes(match[1].trim());
		// Only add if not already captured by absolute/tilde/relative patterns
		if (target && target !== "-" && target !== "~") {
			paths.push(target);
		}
		match = cdRe.exec(normalized);
	}

	// Pattern 6: Redirect targets — > /path, >> /path, 2> /path
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

/**
 * Filter out paths that appear in environment variable assignment position.
 * Pattern: VAR=/some/path command (the path is an env value, not accessed)
 */
function filterEnvAssignments(command: string, paths: string[]): string[] {
	// Match env assignments: WORD=/path (at start or after whitespace/;/&&/||)
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

/**
 * Check if an absolute path is outside the given CWD.
 */
export function isOutsideCwd(absolutePath: string, cwd: string): boolean {
	return absolutePath !== cwd && !absolutePath.startsWith(`${cwd}/`);
}

/**
 * Extract filesystem paths from a bash command that are outside CWD.
 *
 * Returns deduplicated absolute directory paths that need permission checking.
 * Paths within CWD are filtered out. Safe system paths (/dev/null etc.) are skipped.
 *
 * @param command - The bash command string to analyze
 * @param cwd - The current working directory (absolute path)
 * @returns Array of absolute directory paths outside CWD
 */
export function extractPathsFromCommand(command: string, cwd: string): string[] {
	// Extract raw path tokens
	let rawPaths = extractRawPaths(command);

	// Filter out env assignment values
	rawPaths = filterEnvAssignments(command, rawPaths);

	const seen = new Set<string>();
	const result: string[] = [];

	for (const raw of rawPaths) {
		// Skip URLs
		if (isUrl(raw)) continue;

		// Skip empty
		if (!raw || raw === "/") continue;

		// Expand tilde and resolve to absolute
		const expanded = expandTilde(raw);
		const absolute = resolve(cwd, expanded);

		// Skip safe system paths
		if (SAFE_PATHS.has(absolute)) continue;

		// Get directory component
		const dir = toDirectory(absolute);

		// Skip if inside CWD
		if (!isOutsideCwd(dir, cwd)) continue;

		// Deduplicate
		if (seen.has(dir)) continue;
		seen.add(dir);

		result.push(dir);
	}

	return result;
}
