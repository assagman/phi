/**
 * Project Analyzer Tools
 *
 * Tools for the Lead Analyzer agent to understand project context:
 * - analyze_project_structure: File structure scan using fd
 * - analyze_dependencies: Parse package.json, go.mod, pyproject.toml, etc.
 * - analyze_languages: Detect languages and frameworks
 * - analyze_configs: Read key configuration files
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "agent";
import { exec } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

// ============================================================================
// analyze_project_structure
// ============================================================================

const structureSchema = Type.Object({
	maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth to scan (default: 4)" })),
	excludePatterns: Type.Optional(
		Type.Array(Type.String(), { description: "Patterns to exclude (default: node_modules, .git, dist, build)" }),
	),
});

interface StructureDetails {
	totalFiles: number;
	totalDirs: number;
	topLevelDirs: string[];
}

export function createAnalyzeStructureTool(cwd: string): AgentTool<typeof structureSchema, StructureDetails> {
	return {
		name: "analyze_project_structure",
		label: "analyze structure",
		description:
			"Scan project file structure to understand layout. Returns directory tree, file counts, and top-level organization.",
		parameters: structureSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<StructureDetails>> => {
			const maxDepth = params.maxDepth ?? 4;
			const excludePatterns = params.excludePatterns ?? [
				"node_modules",
				".git",
				"dist",
				"build",
				"__pycache__",
				".venv",
				"target",
			];

			// Build fd command
			const excludeArgs = excludePatterns.map((p) => `-E "${p}"`).join(" ");
			const cmd = `fd --type d --max-depth ${maxDepth} ${excludeArgs} . "${cwd}" 2>/dev/null | head -200`;

			try {
				const { stdout: dirsOut } = await execAsync(cmd, { cwd });
				const dirs = dirsOut.trim().split("\n").filter(Boolean);

				// Get file count
				const fileCmd = `fd --type f ${excludeArgs} . "${cwd}" 2>/dev/null | wc -l`;
				const { stdout: fileCountOut } = await execAsync(fileCmd, { cwd });
				const totalFiles = Number.parseInt(fileCountOut.trim(), 10) || 0;

				// Get top-level directories
				const topLevelCmd = `fd --type d --max-depth 1 ${excludeArgs} . "${cwd}" 2>/dev/null`;
				const { stdout: topLevelOut } = await execAsync(topLevelCmd, { cwd });
				const topLevelDirs = topLevelOut
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((d) => relative(cwd, d) || d);

				// Build tree representation
				const tree = buildTreeString(dirs, cwd);

				const details: StructureDetails = {
					totalFiles,
					totalDirs: dirs.length,
					topLevelDirs,
				};

				return {
					content: [
						{
							type: "text",
							text: `## Project Structure

**Files:** ${totalFiles} | **Directories:** ${dirs.length}

### Top-Level Layout
${topLevelDirs.map((d) => `- ${d}/`).join("\n")}

### Directory Tree (depth ${maxDepth})
\`\`\`
${tree}
\`\`\``,
						},
					],
					details,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error scanning structure: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { totalFiles: 0, totalDirs: 0, topLevelDirs: [] },
				};
			}
		},
	};
}

function buildTreeString(dirs: string[], cwd: string): string {
	// Simple tree representation
	const lines: string[] = ["."];
	const sorted = dirs
		.map((d) => relative(cwd, d))
		.filter(Boolean)
		.sort();

	for (const dir of sorted.slice(0, 100)) {
		// Limit output
		const depth = dir.split("/").length;
		const indent = "  ".repeat(depth);
		const name = dir.split("/").pop() || dir;
		lines.push(`${indent}${name}/`);
	}

	if (sorted.length > 100) {
		lines.push(`  ... and ${sorted.length - 100} more directories`);
	}

	return lines.join("\n");
}

// ============================================================================
// analyze_dependencies
// ============================================================================

const depsSchema = Type.Object({
	includeDevDeps: Type.Optional(Type.Boolean({ description: "Include dev dependencies (default: true)" })),
});

interface DependencyInfo {
	ecosystem: string;
	file: string;
	dependencies: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
}

interface DepsDetails {
	ecosystems: string[];
	dependencyCount: number;
}

export function createAnalyzeDependenciesTool(cwd: string): AgentTool<typeof depsSchema, DepsDetails> {
	return {
		name: "analyze_dependencies",
		label: "analyze deps",
		description:
			"Analyze project dependencies from package.json, go.mod, pyproject.toml, Cargo.toml, etc. Returns dependency list and ecosystem info.",
		parameters: depsSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<DepsDetails>> => {
			const includeDevDeps = params.includeDevDeps ?? true;
			const results: DependencyInfo[] = [];

			// Check each ecosystem
			const ecosystemFiles: Array<{ file: string; ecosystem: string; parser: (content: string) => DependencyInfo }> =
				[
					{ file: "package.json", ecosystem: "npm", parser: parsePackageJson },
					{ file: "go.mod", ecosystem: "go", parser: parseGoMod },
					{ file: "pyproject.toml", ecosystem: "python", parser: parsePyproject },
					{ file: "Cargo.toml", ecosystem: "rust", parser: parseCargoToml },
					{ file: "Gemfile", ecosystem: "ruby", parser: parseGemfile },
					{ file: "pom.xml", ecosystem: "maven", parser: parsePomXml },
					{ file: "build.gradle", ecosystem: "gradle", parser: parseGradle },
				];

			for (const { file, ecosystem, parser } of ecosystemFiles) {
				const filePath = join(cwd, file);
				if (existsSync(filePath)) {
					try {
						const content = readFileSync(filePath, "utf-8");
						const info = parser(content);
						info.ecosystem = ecosystem;
						info.file = file;
						results.push(info);
					} catch {
						// Skip unparseable files
					}
				}
			}

			// Also check for monorepo patterns
			const workspaceFiles = await findWorkspaceFiles(cwd);

			const ecosystems = [...new Set(results.map((r) => r.ecosystem))];
			let totalDeps = 0;

			const sections: string[] = ["## Dependencies Analysis\n"];

			for (const info of results) {
				const depCount = Object.keys(info.dependencies).length;
				const devCount = info.devDependencies ? Object.keys(info.devDependencies).length : 0;
				totalDeps += depCount + (includeDevDeps ? devCount : 0);

				sections.push(`### ${info.ecosystem.toUpperCase()} (${info.file})\n`);
				sections.push(`**Dependencies:** ${depCount}`);
				if (devCount > 0) {
					sections.push(` | **Dev:** ${devCount}`);
				}
				sections.push("\n\n");

				// List key dependencies
				const deps = Object.entries(info.dependencies).slice(0, 20);
				if (deps.length > 0) {
					sections.push("**Key Dependencies:**\n");
					for (const [name, version] of deps) {
						sections.push(`- ${name}: ${version}\n`);
					}
					if (Object.keys(info.dependencies).length > 20) {
						sections.push(`- ... and ${Object.keys(info.dependencies).length - 20} more\n`);
					}
				}

				if (includeDevDeps && info.devDependencies && Object.keys(info.devDependencies).length > 0) {
					sections.push("\n**Dev Dependencies:** ");
					sections.push(Object.keys(info.devDependencies).slice(0, 10).join(", "));
					if (Object.keys(info.devDependencies).length > 10) {
						sections.push(`, ... +${Object.keys(info.devDependencies).length - 10} more`);
					}
					sections.push("\n");
				}

				if (info.scripts && Object.keys(info.scripts).length > 0) {
					sections.push("\n**Scripts:** ");
					sections.push(Object.keys(info.scripts).join(", "));
					sections.push("\n");
				}
			}

			if (workspaceFiles.length > 0) {
				sections.push("\n### Monorepo Structure\n");
				sections.push(`Found ${workspaceFiles.length} workspace packages\n`);
			}

			if (results.length === 0) {
				sections.push("No recognized dependency files found.\n");
			}

			return {
				content: [{ type: "text", text: sections.join("") }],
				details: { ecosystems, dependencyCount: totalDeps },
			};
		},
	};
}

// Parsers for different ecosystems
function parsePackageJson(content: string): DependencyInfo {
	const pkg = JSON.parse(content);
	return {
		ecosystem: "npm",
		file: "package.json",
		dependencies: pkg.dependencies || {},
		devDependencies: pkg.devDependencies || {},
		scripts: pkg.scripts || {},
	};
}

function parseGoMod(content: string): DependencyInfo {
	const deps: Record<string, string> = {};
	const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
	if (requireBlock) {
		const lines = requireBlock[1].split("\n");
		for (const line of lines) {
			const match = line.trim().match(/^([^\s]+)\s+([^\s]+)/);
			if (match) {
				deps[match[1]] = match[2];
			}
		}
	}
	return { ecosystem: "go", file: "go.mod", dependencies: deps };
}

function parsePyproject(content: string): DependencyInfo {
	const deps: Record<string, string> = {};
	// Simple TOML parsing for dependencies
	const depsMatch = content.match(/\[project\.dependencies\]([\s\S]*?)(?=\[|$)/);
	if (depsMatch) {
		const lines = depsMatch[1].split("\n");
		for (const line of lines) {
			const match = line.match(/"([^"]+)"/);
			if (match) {
				deps[match[1].split(/[<>=]/)[0]] = match[1];
			}
		}
	}
	return { ecosystem: "python", file: "pyproject.toml", dependencies: deps };
}

function parseCargoToml(content: string): DependencyInfo {
	const deps: Record<string, string> = {};
	const depsMatch = content.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/);
	if (depsMatch) {
		const lines = depsMatch[1].split("\n");
		for (const line of lines) {
			const match = line.match(/^([^=\s]+)\s*=\s*"?([^"\n]+)"?/);
			if (match) {
				deps[match[1]] = match[2];
			}
		}
	}
	return { ecosystem: "rust", file: "Cargo.toml", dependencies: deps };
}

function parseGemfile(content: string): DependencyInfo {
	const deps: Record<string, string> = {};
	const lines = content.split("\n");
	for (const line of lines) {
		const match = line.match(/gem\s+['"]([^'"]+)['"]/);
		if (match) {
			deps[match[1]] = "*";
		}
	}
	return { ecosystem: "ruby", file: "Gemfile", dependencies: deps };
}

function parsePomXml(content: string): DependencyInfo {
	const deps: Record<string, string> = {};
	const depMatches = content.matchAll(
		/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g,
	);
	for (const match of depMatches) {
		deps[`${match[1]}:${match[2]}`] = "*";
	}
	return { ecosystem: "maven", file: "pom.xml", dependencies: deps };
}

function parseGradle(content: string): DependencyInfo {
	const deps: Record<string, string> = {};
	const depMatches = content.matchAll(/(?:implementation|compile|api)\s+['"]([^'"]+)['"]/g);
	for (const match of depMatches) {
		deps[match[1]] = "*";
	}
	return { ecosystem: "gradle", file: "build.gradle", dependencies: deps };
}

async function findWorkspaceFiles(cwd: string): Promise<string[]> {
	try {
		// Check for npm/yarn workspaces
		const pkgPath = join(cwd, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			if (pkg.workspaces) {
				const { stdout } = await execAsync(`fd package.json --max-depth 3 "${cwd}" 2>/dev/null | head -50`, {
					cwd,
				});
				return stdout.trim().split("\n").filter(Boolean);
			}
		}
	} catch {
		// Ignore
	}
	return [];
}

// ============================================================================
// analyze_languages
// ============================================================================

const langSchema = Type.Object({});

interface LangDetails {
	primary: string;
	all: string[];
	frameworks: string[];
}

export function createAnalyzeLanguagesTool(cwd: string): AgentTool<typeof langSchema, LangDetails> {
	return {
		name: "analyze_languages",
		label: "analyze languages",
		description:
			"Detect programming languages and frameworks used in the project based on file extensions and config files.",
		parameters: langSchema,
		execute: async (): Promise<AgentToolResult<LangDetails>> => {
			const langCounts: Record<string, number> = {};
			const frameworks: string[] = [];

			// Count files by extension
			const extMap: Record<string, string> = {
				ts: "TypeScript",
				tsx: "TypeScript",
				js: "JavaScript",
				jsx: "JavaScript",
				py: "Python",
				go: "Go",
				rs: "Rust",
				rb: "Ruby",
				java: "Java",
				kt: "Kotlin",
				swift: "Swift",
				cs: "C#",
				cpp: "C++",
				c: "C",
				php: "PHP",
				scala: "Scala",
				ex: "Elixir",
				exs: "Elixir",
				hs: "Haskell",
				ml: "OCaml",
				vue: "Vue",
				svelte: "Svelte",
			};

			try {
				const { stdout } = await execAsync(
					`fd --type f -E node_modules -E .git -E dist -E build . "${cwd}" 2>/dev/null | head -1000`,
					{ cwd },
				);
				const files = stdout.trim().split("\n").filter(Boolean);

				for (const file of files) {
					const ext = file.split(".").pop()?.toLowerCase();
					if (ext && extMap[ext]) {
						langCounts[extMap[ext]] = (langCounts[extMap[ext]] || 0) + 1;
					}
				}
			} catch {
				// Ignore fd errors
			}

			// Detect frameworks
			const frameworkIndicators: Array<{ files: string[]; framework: string }> = [
				{ files: ["next.config.js", "next.config.ts", "next.config.mjs"], framework: "Next.js" },
				{ files: ["nuxt.config.js", "nuxt.config.ts"], framework: "Nuxt" },
				{ files: ["svelte.config.js"], framework: "SvelteKit" },
				{ files: ["angular.json"], framework: "Angular" },
				{ files: ["vite.config.ts", "vite.config.js"], framework: "Vite" },
				{ files: ["webpack.config.js"], framework: "Webpack" },
				{ files: ["tailwind.config.js", "tailwind.config.ts"], framework: "Tailwind CSS" },
				{ files: ["prisma/schema.prisma"], framework: "Prisma" },
				{ files: ["drizzle.config.ts"], framework: "Drizzle" },
				{ files: ["docker-compose.yml", "docker-compose.yaml"], framework: "Docker Compose" },
				{ files: ["Dockerfile"], framework: "Docker" },
				{ files: [".github/workflows"], framework: "GitHub Actions" },
				{ files: ["jest.config.js", "jest.config.ts"], framework: "Jest" },
				{ files: ["vitest.config.ts"], framework: "Vitest" },
				{ files: ["playwright.config.ts"], framework: "Playwright" },
				{ files: ["cypress.config.js", "cypress.config.ts"], framework: "Cypress" },
				{ files: ["fastapi"], framework: "FastAPI" },
				{ files: ["django"], framework: "Django" },
				{ files: ["flask"], framework: "Flask" },
				{ files: ["express"], framework: "Express" },
				{ files: ["nestjs"], framework: "NestJS" },
			];

			// Check package.json for JS frameworks
			const pkgPath = join(cwd, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
					const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
					if (allDeps.react) frameworks.push("React");
					if (allDeps.vue) frameworks.push("Vue");
					if (allDeps.svelte) frameworks.push("Svelte");
					if (allDeps.express) frameworks.push("Express");
					if (allDeps["@nestjs/core"]) frameworks.push("NestJS");
					if (allDeps.fastify) frameworks.push("Fastify");
					if (allDeps.hono) frameworks.push("Hono");
					if (allDeps.electron) frameworks.push("Electron");
					if (allDeps["react-native"]) frameworks.push("React Native");
				} catch {
					// Ignore
				}
			}

			for (const { files, framework } of frameworkIndicators) {
				for (const file of files) {
					if (existsSync(join(cwd, file))) {
						if (!frameworks.includes(framework)) {
							frameworks.push(framework);
						}
						break;
					}
				}
			}

			// Sort by count
			const sorted = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
			const primary = sorted[0]?.[0] || "Unknown";
			const all = sorted.map(([lang]) => lang);
			const totalFiles = sorted.reduce((sum, [, count]) => sum + count, 0);

			const sections: string[] = ["## Language & Framework Analysis\n"];

			sections.push("### Languages\n");
			for (const [lang, count] of sorted) {
				const pct = totalFiles > 0 ? ((count / totalFiles) * 100).toFixed(1) : "0";
				sections.push(`- **${lang}**: ${count} files (${pct}%)\n`);
			}

			if (frameworks.length > 0) {
				sections.push("\n### Frameworks & Tools\n");
				for (const fw of frameworks) {
					sections.push(`- ${fw}\n`);
				}
			}

			sections.push(`\n**Primary Language:** ${primary}\n`);

			return {
				content: [{ type: "text", text: sections.join("") }],
				details: { primary, all, frameworks },
			};
		},
	};
}

// ============================================================================
// analyze_configs
// ============================================================================

const configsSchema = Type.Object({
	configTypes: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific config types to analyze: linting, testing, build, ci, all (default: all)",
		}),
	),
});

interface ConfigDetails {
	found: string[];
	categories: Record<string, string[]>;
}

export function createAnalyzeConfigsTool(cwd: string): AgentTool<typeof configsSchema, ConfigDetails> {
	return {
		name: "analyze_configs",
		label: "analyze configs",
		description:
			"Analyze project configuration files (linting, testing, build, CI/CD) to understand project setup and conventions.",
		parameters: configsSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<ConfigDetails>> => {
			const configTypes = params.configTypes ?? ["all"];
			const checkAll = configTypes.includes("all");

			const categories: Record<string, Array<{ file: string; summary: string }>> = {
				linting: [],
				testing: [],
				build: [],
				ci: [],
				formatting: [],
				types: [],
				other: [],
			};

			const configFiles: Array<{ file: string; category: string; summarizer?: (content: string) => string }> = [
				// Linting
				{ file: ".eslintrc.js", category: "linting" },
				{ file: ".eslintrc.json", category: "linting" },
				{ file: "eslint.config.js", category: "linting" },
				{ file: "eslint.config.mjs", category: "linting" },
				{ file: "biome.json", category: "linting", summarizer: summarizeBiome },
				{ file: ".pylintrc", category: "linting" },
				{ file: ".flake8", category: "linting" },
				{ file: "ruff.toml", category: "linting" },

				// Formatting
				{ file: ".prettierrc", category: "formatting" },
				{ file: ".prettierrc.json", category: "formatting" },
				{ file: "prettier.config.js", category: "formatting" },
				{ file: ".editorconfig", category: "formatting" },

				// Types
				{ file: "tsconfig.json", category: "types", summarizer: summarizeTsconfig },
				{ file: "jsconfig.json", category: "types" },
				{ file: "pyrightconfig.json", category: "types" },

				// Testing
				{ file: "jest.config.js", category: "testing" },
				{ file: "jest.config.ts", category: "testing" },
				{ file: "vitest.config.ts", category: "testing" },
				{ file: "pytest.ini", category: "testing" },
				{ file: "playwright.config.ts", category: "testing" },

				// Build
				{ file: "vite.config.ts", category: "build" },
				{ file: "webpack.config.js", category: "build" },
				{ file: "rollup.config.js", category: "build" },
				{ file: "esbuild.config.js", category: "build" },
				{ file: "turbo.json", category: "build" },

				// CI/CD
				{ file: ".github/workflows", category: "ci" },
				{ file: ".gitlab-ci.yml", category: "ci" },
				{ file: ".circleci/config.yml", category: "ci" },
				{ file: "Jenkinsfile", category: "ci" },
				{ file: ".travis.yml", category: "ci" },
			];

			const found: string[] = [];

			for (const { file, category, summarizer } of configFiles) {
				if (!checkAll && !configTypes.includes(category)) continue;

				const filePath = join(cwd, file);
				if (existsSync(filePath)) {
					found.push(file);
					let summary = file;
					if (summarizer) {
						try {
							const content = readFileSync(filePath, "utf-8");
							summary = summarizer(content);
						} catch {
							// Ignore read errors
						}
					}
					categories[category].push({ file, summary });
				}
			}

			// Check for GitHub workflows
			const workflowsPath = join(cwd, ".github/workflows");
			if (existsSync(workflowsPath)) {
				try {
					const { stdout } = await execAsync(`ls "${workflowsPath}" 2>/dev/null`);
					const workflows = stdout.trim().split("\n").filter(Boolean);
					if (workflows.length > 0) {
						categories.ci.push({
							file: ".github/workflows/",
							summary: `${workflows.length} workflows: ${workflows.join(", ")}`,
						});
					}
				} catch {
					// Ignore
				}
			}

			const sections: string[] = ["## Configuration Analysis\n"];

			const categoryLabels: Record<string, string> = {
				linting: "🔍 Linting",
				formatting: "✨ Formatting",
				types: "📝 Type Checking",
				testing: "🧪 Testing",
				build: "🔨 Build",
				ci: "🚀 CI/CD",
				other: "📦 Other",
			};

			for (const [cat, items] of Object.entries(categories)) {
				if (items.length === 0) continue;
				sections.push(`### ${categoryLabels[cat] || cat}\n`);
				for (const { file, summary } of items) {
					if (summary !== file) {
						sections.push(`- **${file}**: ${summary}\n`);
					} else {
						sections.push(`- ${file}\n`);
					}
				}
				sections.push("\n");
			}

			if (found.length === 0) {
				sections.push("No configuration files found.\n");
			}

			const detailCategories: Record<string, string[]> = {};
			for (const [cat, items] of Object.entries(categories)) {
				if (items.length > 0) {
					detailCategories[cat] = items.map((i) => i.file);
				}
			}

			return {
				content: [{ type: "text", text: sections.join("") }],
				details: { found, categories: detailCategories },
			};
		},
	};
}

function summarizeTsconfig(content: string): string {
	try {
		const config = JSON.parse(content);
		const parts: string[] = [];
		if (config.compilerOptions?.strict) parts.push("strict");
		if (config.compilerOptions?.target) parts.push(`target: ${config.compilerOptions.target}`);
		if (config.compilerOptions?.module) parts.push(`module: ${config.compilerOptions.module}`);
		return parts.join(", ") || "TypeScript config";
	} catch {
		return "TypeScript config";
	}
}

function summarizeBiome(content: string): string {
	try {
		const config = JSON.parse(content);
		const parts: string[] = [];
		if (config.linter?.enabled !== false) parts.push("linter");
		if (config.formatter?.enabled !== false) parts.push("formatter");
		return parts.join(" + ") || "Biome config";
	} catch {
		return "Biome config";
	}
}

// ============================================================================
// Export all tools
// ============================================================================

export interface ProjectAnalyzerTools {
	analyzeStructure: AgentTool<typeof structureSchema, StructureDetails>;
	analyzeDependencies: AgentTool<typeof depsSchema, DepsDetails>;
	analyzeLanguages: AgentTool<typeof langSchema, LangDetails>;
	analyzeConfigs: AgentTool<typeof configsSchema, ConfigDetails>;
}

export function createProjectAnalyzerTools(cwd: string): ProjectAnalyzerTools {
	return {
		analyzeStructure: createAnalyzeStructureTool(cwd),
		analyzeDependencies: createAnalyzeDependenciesTool(cwd),
		analyzeLanguages: createAnalyzeLanguagesTool(cwd),
		analyzeConfigs: createAnalyzeConfigsTool(cwd),
	};
}

/** Get all project analyzer tools as an array (typed for generic AgentTool compatibility) */
export function getProjectAnalyzerToolsArray(cwd: string): AgentTool<any, any>[] {
	const tools = createProjectAnalyzerTools(cwd);
	return [tools.analyzeStructure, tools.analyzeDependencies, tools.analyzeLanguages, tools.analyzeConfigs];
}
