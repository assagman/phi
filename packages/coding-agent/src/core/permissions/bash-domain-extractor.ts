/**
 * Static domain extraction from bash commands.
 *
 * Parses command strings for network host references to enable
 * permission checking BEFORE sandbox execution. Best-effort extraction
 * — catches common CLI patterns (curl, wget, git, npm, etc.).
 *
 * Defense layer for network access: works alongside allowedDomains in sandbox.
 */

// ── Implicit host rules ─────────────────────────────────────────────────────
// Commands that implicitly connect to well-known hosts without explicit URLs.

interface ImplicitRule {
	/** Regex matching the command prefix (anchored after pipe/semicolon/start) */
	pattern: RegExp;
	/** Hosts this command connects to */
	hosts: string[];
}

const IMPLICIT_RULES: ImplicitRule[] = [
	{
		pattern: /(?:^|[;&|]\s*)npm\s+(?:install|ci|publish|view|info|pack|search|audit|outdated|update|fund)\b/,
		hosts: ["registry.npmjs.org"],
	},
	{
		pattern: /(?:^|[;&|]\s*)bun\s+(?:install|add|remove|update|pm)\b/,
		hosts: ["registry.npmjs.org"],
	},
	{
		pattern: /(?:^|[;&|]\s*)(?:yarn)\s+(?:add|install|upgrade|info|npm\s+publish)\b/,
		hosts: ["registry.yarnpkg.com", "registry.npmjs.org"],
	},
	{
		pattern: /(?:^|[;&|]\s*)pip\s+(?:install|download|search)\b/,
		hosts: ["pypi.org", "files.pythonhosted.org"],
	},
	{
		pattern: /(?:^|[;&|]\s*)pip3\s+(?:install|download|search)\b/,
		hosts: ["pypi.org", "files.pythonhosted.org"],
	},
	{
		pattern: /(?:^|[;&|]\s*)gem\s+(?:install|fetch|search)\b/,
		hosts: ["rubygems.org"],
	},
	{
		pattern: /(?:^|[;&|]\s*)cargo\s+(?:install|publish|search|update)\b/,
		hosts: ["crates.io", "static.crates.io"],
	},
	{
		pattern: /(?:^|[;&|]\s*)go\s+(?:install|get|mod\s+download)\b/,
		hosts: ["proxy.golang.org", "sum.golang.org"],
	},
	{
		pattern: /(?:^|[;&|]\s*)gh\s+(?:api|repo|pr|issue|release|gist|run|workflow|auth)\b/,
		hosts: ["api.github.com", "github.com"],
	},
	{
		pattern: /(?:^|[;&|]\s*)docker\s+(?:pull|push|login|buildx)\b/,
		hosts: ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"],
	},
	{
		pattern: /(?:^|[;&|]\s*)brew\s+(?:install|upgrade|update|search|tap)\b/,
		hosts: ["formulae.brew.sh", "ghcr.io"],
	},
];

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract a hostname from a URL string.
 * Returns null if the string is not a valid URL with a hostname.
 */
function extractHostFromUrl(urlStr: string): string | null {
	try {
		const url = new URL(urlStr);
		if (url.hostname) return url.hostname.toLowerCase();
	} catch {
		// Not a valid URL
	}
	return null;
}

/**
 * Extract hostname from SSH-style references.
 * Patterns: git@github.com:..., user@host:..., ssh user@host
 */
function extractHostFromSsh(token: string): string | null {
	// user@host:path or user@host
	const match = token.match(/^[a-zA-Z0-9._-]+@([a-zA-Z0-9._-]+(?:\.[a-zA-Z]{2,})+)/);
	if (match) return match[1].toLowerCase();
	return null;
}

/**
 * Extract unique hostnames from a bash command string.
 *
 * Strategies:
 * 1. Parse URLs (http://, https://, ftp://, ssh://, git://)
 * 2. Parse SSH-style references (user@host:path)
 * 3. Match implicit rules (npm install → registry.npmjs.org)
 *
 * @param command - The bash command string to analyze
 * @returns Array of unique lowercase hostnames
 */
export function extractHostsFromCommand(command: string): string[] {
	const hosts = new Set<string>();

	// Normalize: join backslash-continued lines
	const normalized = command.replace(/\\\n/g, " ");

	// Strategy 1: URL extraction
	// Match common URL schemes in the command
	const urlRe = /(?:https?|ftp|ssh|git):\/\/[^\s;|&)<>"']+/g;
	let match = urlRe.exec(normalized);
	while (match !== null) {
		const host = extractHostFromUrl(match[0]);
		if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
			hosts.add(host);
		}
		match = urlRe.exec(normalized);
	}

	// Strategy 2: SSH-style host extraction
	// Match user@host patterns (common in git clone, scp, ssh)
	const sshRe = /[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+(?:\.[a-zA-Z]{2,})+/g;
	match = sshRe.exec(normalized);
	while (match !== null) {
		const host = extractHostFromSsh(match[0]);
		if (host && host !== "localhost") {
			hosts.add(host);
		}
		match = sshRe.exec(normalized);
	}

	// Strategy 3: Implicit host rules
	for (const rule of IMPLICIT_RULES) {
		if (rule.pattern.test(normalized)) {
			for (const host of rule.hosts) {
				hosts.add(host);
			}
		}
	}

	return [...hosts];
}
