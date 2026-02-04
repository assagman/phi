import { spawnSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, relative } from "path";
import { fuzzyFilter } from "./fuzzy.js";

/**
 * Find the git root directory by walking up from the given directory.
 * Returns null if not in a git repository.
 */
function findGitRoot(startDir: string): string | null {
	let dir = startDir;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// Use fd to walk directory tree (fast, respects .gitignore)
// Returns all files up to maxResults - filtering is done by caller using full paths
function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	maxResults: number,
): Array<{ path: string; isDirectory: boolean }> {
	const args = ["--base-directory", baseDir, "--max-results", String(maxResults), "--type", "f", "--type", "d"];

	// Don't pass query to fd - fd only matches against basenames, not full paths.
	// We'll filter using fuzzy matching on the full relative path ourselves.

	const result = spawnSync(fdPath, args, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 10 * 1024 * 1024,
	});

	if (result.status !== 0 || !result.stdout) {
		return [];
	}

	const lines = result.stdout.trim().split("\n").filter(Boolean);
	const results: Array<{ path: string; isDirectory: boolean }> = [];

	for (const line of lines) {
		// fd outputs directories with trailing /
		const isDirectory = line.endsWith("/");
		results.push({
			path: line,
			isDirectory,
		});
	}

	return results;
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export interface SlashCommand {
	name: string;
	description?: string;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}

export interface AutocompleteProvider {
	// Get autocomplete suggestions for current text/cursor position
	// Returns null if no suggestions available
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): {
		items: AutocompleteItem[];
		prefix: string; // What we're matching against (e.g., "/" or "src/")
	} | null;

	// Apply the selected item
	// Returns the new text and cursor position
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
}

// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;
	// For fuzzy file search, we search from git root (if available) to enable
	// full path matching like "packages/tui/fuzz" regardless of cwd
	private gitRoot: string | null;

	constructor(
		commands: (SlashCommand | AutocompleteItem)[] = [],
		basePath: string = process.cwd(),
		fdPath: string | null = null,
	) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
		// Find git root for fuzzy searches - allows searching full repo paths
		this.gitRoot = findGitRoot(basePath);
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Check for @ file reference (fuzzy search) - must be after a space or at start
		// Supports space-separated tokens for fzf-style matching (e.g., "@tui auto" matches "packages/tui/src/autocomplete.ts")
		const atMatch = textBeforeCursor.match(/(?:^|[\s])(@[^@]*)$/);
		if (atMatch) {
			const prefix = atMatch[1]?.trimEnd() ?? "@"; // The @... part (trim trailing whitespace for cleaner matching)
			const query = prefix.slice(1); // Remove the @
			const suggestions = this.getFuzzyFileSuggestions(query);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: prefix,
			};
		}

		// Check for slash commands
		if (textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				// No space yet - complete command names with fuzzy matching
				const prefix = textBeforeCursor.slice(1); // Remove the "/"
				const commandItems = this.commands.map((cmd) => ({
					name: "name" in cmd ? cmd.name : cmd.value,
					label: "name" in cmd ? cmd.name : cmd.label,
					description: cmd.description,
				}));

				const filtered = fuzzyFilter(commandItems, prefix, (item) => item.name).map((item) => ({
					value: item.name,
					label: item.label,
					...(item.description && { description: item.description }),
				}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: textBeforeCursor,
				};
			} else {
				// Space found - complete command arguments
				const commandName = textBeforeCursor.slice(1, spaceIndex); // Command without "/"
				const argumentText = textBeforeCursor.slice(spaceIndex + 1); // Text after space

				const command = this.commands.find((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					return name === commandName;
				});
				if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
					return null; // No argument completion for this command
				}

				const argumentSuggestions = command.getArgumentCompletions(argumentText);
				if (!argumentSuggestions || argumentSuggestions.length === 0) {
					return null;
				}

				return {
					items: argumentSuggestions,
					prefix: argumentText,
				};
			}
		}

		// Check for file paths - triggered by Tab or if we detect a path pattern
		const pathMatch = this.extractPathPrefix(textBeforeCursor, false);

		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			// Check if we have an exact match that is a directory
			// In that case, we might want to return suggestions for the directory content instead
			// But only if the prefix ends with /
			if (suggestions.length === 1 && suggestions[0]?.value === pathMatch && !pathMatch.endsWith("/")) {
				// Exact match found (e.g. user typed "src" and "src/" is the only match)
				// We still return it so user can select it and add /
				return {
					items: suggestions,
					prefix: pathMatch,
				};
			}

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);

		// Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
		// Slash commands are at the start of the line and don't contain path separators after the first /
		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (isSlashCommand) {
			// This is a command name completion
			const newLine = `${beforePrefix}/${item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			// This is a file attachment completion
			const newLine = `${beforePrefix + item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1, // +1 for space
			};
		}

		// Check if we're in a slash command context (beforePrefix contains "/command ")
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// This is likely a command argument completion
			const newLine = beforePrefix + item.value + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}

		// For file paths, complete the path
		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}

	// Extract a path-like prefix from the text before cursor
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		// Check for @ file attachment syntax first
		const atMatch = text.match(/@([^\s]*)$/);
		if (atMatch) {
			return atMatch[0]; // Return the full @path pattern
		}

		// Simple approach: find the last whitespace/delimiter and extract the word after it
		// This avoids catastrophic backtracking from nested quantifiers
		const lastDelimiterIndex = Math.max(
			text.lastIndexOf(" "),
			text.lastIndexOf("\t"),
			text.lastIndexOf('"'),
			text.lastIndexOf("'"),
			text.lastIndexOf("="),
		);

		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return empty string only if we're at the beginning of the line or after a space
		// (not after quotes or other delimiters that don't suggest file paths)
		if (pathPrefix === "" && (text === "" || text.endsWith(" "))) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	// Get file/directory suggestions for a given path prefix
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			let expandedPrefix = prefix;
			let isAtPrefix = false;

			// Handle @ file attachment prefix
			if (prefix.startsWith("@")) {
				isAtPrefix = true;
				expandedPrefix = prefix.slice(1); // Remove the @
			}

			// Handle home directory expansion
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			if (
				expandedPrefix === "" ||
				expandedPrefix === "./" ||
				expandedPrefix === "../" ||
				expandedPrefix === "~" ||
				expandedPrefix === "~/" ||
				expandedPrefix === "/" ||
				prefix === "@"
			) {
				// Complete from specified position
				if (prefix.startsWith("~") || expandedPrefix === "/") {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (expandedPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				if (prefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// Split into directory and file prefix
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (prefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = readdirSync(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				// Check if entry is a directory (or a symlink pointing to a directory)
				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = join(searchDir, entry.name);
						isDirectory = statSync(fullPath).isDirectory();
					} catch {
						// Broken symlink or permission error - treat as file
					}
				}

				let relativePath: string;
				const name = entry.name;

				// Handle @ prefix path construction
				if (isAtPrefix) {
					const pathWithoutAt = expandedPrefix;
					if (pathWithoutAt.endsWith("/")) {
						relativePath = `@${pathWithoutAt}${name}`;
					} else if (pathWithoutAt.includes("/")) {
						if (pathWithoutAt.startsWith("~/")) {
							const homeRelativeDir = pathWithoutAt.slice(2); // Remove ~/
							const dir = dirname(homeRelativeDir);
							relativePath = `@~/${dir === "." ? name : join(dir, name)}`;
						} else {
							relativePath = `@${join(dirname(pathWithoutAt), name)}`;
						}
					} else {
						if (pathWithoutAt.startsWith("~")) {
							relativePath = `@~/${name}`;
						} else {
							relativePath = `@${name}`;
						}
					}
				} else if (prefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					relativePath = prefix + name;
				} else if (prefix.includes("/")) {
					// Preserve ~/ format for home directory paths
					if (prefix.startsWith("~/")) {
						const homeRelativeDir = prefix.slice(2); // Remove ~/
						const dir = dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : join(dir, name)}`;
					} else if (prefix.startsWith("/")) {
						// Absolute path - construct properly
						const dir = dirname(prefix);
						if (dir === "/") {
							relativePath = `/${name}`;
						} else {
							relativePath = `${dir}/${name}`;
						}
					} else {
						relativePath = join(dirname(prefix), name);
					}
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					if (prefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				suggestions.push({
					value: isDirectory ? `${relativePath}/` : relativePath,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// Sort directories first, then alphabetically
			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch (_e) {
			// Directory doesn't exist or not accessible
			return [];
		}
	}

	// Fuzzy file search using fd (fast, respects .gitignore)
	// Uses full relative paths for matching, so queries like "tui/fuzz" work
	// Searches from git root (if available) to enable matching paths like "packages/tui/..."
	// regardless of which subdirectory the user started from
	private getFuzzyFileSuggestions(query: string): AutocompleteItem[] {
		if (!this.fdPath) {
			// fd not available, return empty results
			return [];
		}

		try {
			// Search from git root if available, otherwise from basePath (cwd)
			// This allows full repo path matching like "packages/tui/fuzz"
			const searchRoot = this.gitRoot ?? this.basePath;
			const entries = walkDirectoryWithFd(searchRoot, this.fdPath, 1000);

			// Calculate relative path from cwd to git root for path adjustment
			// e.g., if cwd is /repo/packages/tui and gitRoot is /repo,
			// cwdRelativeToRoot would be "packages/tui"
			const cwdRelativeToRoot = this.gitRoot ? relative(this.gitRoot, this.basePath) : "";

			if (!query) {
				// No query - return first 20 entries
				const topEntries = entries.slice(0, 20);
				return topEntries.map(({ path: entryPath, isDirectory }) => {
					const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
					const entryName = basename(pathWithoutSlash);
					// Convert path to be relative to cwd for the actual file reference
					const pathRelativeToCwd = this.convertToRelativePath(entryPath, cwdRelativeToRoot);
					return {
						value: `@${pathRelativeToCwd}`,
						label: entryName + (isDirectory ? "/" : ""),
						description: pathWithoutSlash, // Show full repo path for context
					};
				});
			}

			// Fuzzy match against full relative paths (from git root, not just basenames)
			// This allows queries like "tui/fuzz" or "src/auto" to work properly
			const entriesWithPaths = entries.map((entry) => ({
				...entry,
				// Use path without trailing slash for matching
				matchPath: entry.isDirectory ? entry.path.slice(0, -1) : entry.path,
			}));

			// Use fuzzyFilter to match and sort by score
			const filtered = fuzzyFilter(entriesWithPaths, query, (e) => e.matchPath);

			// Take top 20 results
			const topEntries = filtered.slice(0, 20);

			// Build suggestions
			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory, matchPath } of topEntries) {
				const entryName = basename(matchPath);
				// Convert path to be relative to cwd for the actual file reference
				const pathRelativeToCwd = this.convertToRelativePath(entryPath, cwdRelativeToRoot);

				suggestions.push({
					value: `@${pathRelativeToCwd}`,
					label: entryName + (isDirectory ? "/" : ""),
					description: matchPath, // Show full repo path for context
				});
			}

			return suggestions;
		} catch {
			return [];
		}
	}

	/**
	 * Convert a path relative to git root to a path relative to cwd.
	 * If cwdRelativeToRoot is empty (cwd === gitRoot), returns the path as-is.
	 * Otherwise, adjusts the path to be relative from cwd.
	 *
	 * Example: If gitRoot is /repo, cwd is /repo/packages/tui,
	 * and entryPath is "packages/ai/src/index.ts",
	 * the result would be "../ai/src/index.ts"
	 */
	private convertToRelativePath(entryPath: string, cwdRelativeToRoot: string): string {
		if (!cwdRelativeToRoot) {
			// cwd is at git root, no conversion needed
			return entryPath;
		}
		// Use relative() to compute the path from cwd to the entry
		// entryPath is relative to gitRoot, and cwdRelativeToRoot is cwd's position within gitRoot
		return relative(cwdRelativeToRoot, entryPath);
	}

	// Force file completion (called on Tab key) - always returns suggestions
	getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return null;
		}

		// Force extract path prefix - this will always return something
		const pathMatch = this.extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
