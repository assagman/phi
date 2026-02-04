import { Type } from "@sinclair/typebox";
import type { AgentTool } from "agent";
import { spawn, spawnSync } from "child_process";
import path from "path";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/** Check if ast-grep (sg) command exists in PATH */
function findAstGrep(): string | null {
	// Try 'sg' first (shorter alias), then 'ast-grep'
	for (const cmd of ["sg", "ast-grep"]) {
		try {
			const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
			if (result.error === undefined || result.error === null) {
				return cmd;
			}
		} catch {
			// Continue to next candidate
		}
	}
	return null;
}

const astGrepSchema = Type.Object({
	pattern: Type.String({
		description:
			"AST pattern to match. Use $NAME for single node, $$$ARGS for multiple nodes. Example: 'function $NAME($$$ARGS) { $$$BODY }'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	lang: Type.Optional(
		Type.String({
			description:
				"Language to search. Supported: typescript, javascript, tsx, jsx, python, go, rust, java, c, cpp, csharp, ruby, swift, kotlin, etc. Auto-detected if not specified.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 50)" })),
});

const DEFAULT_LIMIT = 50;

export interface AstGrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
}

export interface AstGrepMatch {
	text: string;
	file: string;
	lines: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	language: string;
}

export function createAstGrepTool(cwd: string): AgentTool<typeof astGrepSchema> {
	return {
		name: "ast_grep",
		label: "ast-grep",
		description: `Search code using AST patterns. Unlike text grep, this understands code structure. Use $VAR for wildcards, $$$VAR for multiple nodes. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		parameters: astGrepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				lang,
				limit,
			}: {
				pattern: string;
				path?: string;
				lang?: string;
				limit?: number;
			},
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const sgPath = findAstGrep();
						if (!sgPath) {
							settle(() =>
								reject(new Error("ast-grep (sg) is not available. Install with: npm install -g @ast-grep/cli")),
							);
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

						const args: string[] = ["run", "--pattern", pattern, "--json"];

						if (lang) {
							args.push("--lang", lang);
						}

						args.push(searchPath);

						const child = spawn(sgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						let stdout = "";
						let stderr = "";
						let aborted = false;

						const cleanup = () => {
							signal?.removeEventListener("abort", onAbort);
						};

						const onAbort = () => {
							aborted = true;
							if (!child.killed) {
								child.kill();
							}
						};

						signal?.addEventListener("abort", onAbort, { once: true });

						child.stdout?.on("data", (chunk) => {
							stdout += chunk.toString();
						});

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ast-grep: ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();

							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}

							// ast-grep returns 0 for matches, 1 for no matches, other codes for errors
							if (code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ast-grep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}

							let matches: AstGrepMatch[];
							try {
								matches = JSON.parse(stdout || "[]");
							} catch {
								settle(() => reject(new Error("Failed to parse ast-grep output")));
								return;
							}

							if (matches.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No matches found" }],
										details: undefined,
									}),
								);
								return;
							}

							// Limit matches
							const matchLimitReached = matches.length > effectiveLimit;
							const limitedMatches = matches.slice(0, effectiveLimit);

							// Format output
							const outputLines: string[] = [];

							for (const match of limitedMatches) {
								// Relativize file path
								let relPath = match.file;
								if (relPath.startsWith(searchPath)) {
									relPath = relPath.slice(searchPath.length + 1);
								} else {
									relPath = path.relative(searchPath, match.file);
								}

								const startLine = match.range.start.line;
								const endLine = match.range.end.line;
								const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

								// Use the full matched text (multi-line aware)
								const matchedText = match.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

								outputLines.push(`${relPath}:${lineRange}`);
								outputLines.push(matchedText);
								outputLines.push(""); // Blank line separator
							}

							// Apply truncation
							const rawOutput = outputLines.join("\n").trim();
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

							let output = truncation.content;
							const details: AstGrepToolDetails = {};
							const notices: string[] = [];

							if (matchLimitReached) {
								notices.push(
									`Showing first ${effectiveLimit} of ${matches.length} matches. Use limit=${effectiveLimit * 2} for more`,
								);
								details.matchLimitReached = effectiveLimit;
							}

							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}

							if (notices.length > 0) {
								output += `\n\n[${notices.join(". ")}]`;
							}

							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
	};
}

/** Default ast-grep tool using process.cwd() */
export const astGrepTool = createAstGrepTool(process.cwd());
