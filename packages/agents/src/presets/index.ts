// Preset templates - Core

export { accessibilityAuditorTemplate } from "./accessibility-auditor.js";
export { apiDesignAuditorTemplate } from "./api-design-auditor.js";
// Preset templates - Design
export { architectureAuditorTemplate } from "./architecture-auditor.js";
export { codeReviewerTemplate } from "./code-reviewer.js";
export { concurrencyAuditorTemplate } from "./concurrency-auditor.js";
export { dependencyAuditorTemplate } from "./dependency-auditor.js";
// Preset templates - Content & Ecosystem
export { docsAuditorTemplate } from "./docs-auditor.js";
export { errorHandlingAuditorTemplate } from "./error-handling-auditor.js";
export { i18nAuditorTemplate } from "./i18n-auditor.js";
export { mergeSynthesizerTemplate } from "./merge-synthesizer.js";
export { perfAnalyzerTemplate } from "./perf-analyzer.js";
// Preset templates - Security & Privacy
export { privacyAuditorTemplate } from "./privacy-auditor.js";
export { securityAuditorTemplate } from "./security-auditor.js";
export { testCoverageAuditorTemplate } from "./test-coverage-auditor.js";
// Preset templates - Code Quality
export { typeSafetyAuditorTemplate } from "./type-safety-auditor.js";

// Types and utilities
export type { PresetTemplate } from "./types.js";
export { createPreset, EPSILON_TASK_INSTRUCTIONS } from "./types.js";

// Helper to wrap dynamic import with error handling
function loadTemplate<T>(importFn: () => Promise<{ default?: T } & Record<string, T>>, key: string): Promise<T> {
	return importFn()
		.then((m) => m[key as keyof typeof m] as T)
		.catch((err) => {
			throw new Error(
				`Failed to load preset template '${key}': ${err instanceof Error ? err.message : String(err)}`,
			);
		});
}

// Convenience: all review templates (excluding merge-synthesizer)
// Uses dynamic imports for tree-shaking with error handling for module load failures
export const reviewTemplates = {
	// Core reviewers
	"code-reviewer": () => loadTemplate(() => import("./code-reviewer.js"), "codeReviewerTemplate"),
	"security-auditor": () => loadTemplate(() => import("./security-auditor.js"), "securityAuditorTemplate"),
	"perf-analyzer": () => loadTemplate(() => import("./perf-analyzer.js"), "perfAnalyzerTemplate"),
	// Security & Privacy
	"privacy-auditor": () => loadTemplate(() => import("./privacy-auditor.js"), "privacyAuditorTemplate"),
	// Code Quality
	"type-safety-auditor": () => loadTemplate(() => import("./type-safety-auditor.js"), "typeSafetyAuditorTemplate"),
	"test-coverage-auditor": () =>
		loadTemplate(() => import("./test-coverage-auditor.js"), "testCoverageAuditorTemplate"),
	"error-handling-auditor": () =>
		loadTemplate(() => import("./error-handling-auditor.js"), "errorHandlingAuditorTemplate"),
	"concurrency-auditor": () => loadTemplate(() => import("./concurrency-auditor.js"), "concurrencyAuditorTemplate"),
	// Design
	"architecture-auditor": () => loadTemplate(() => import("./architecture-auditor.js"), "architectureAuditorTemplate"),
	"api-design-auditor": () => loadTemplate(() => import("./api-design-auditor.js"), "apiDesignAuditorTemplate"),
	// Content & Ecosystem
	"docs-auditor": () => loadTemplate(() => import("./docs-auditor.js"), "docsAuditorTemplate"),
	"accessibility-auditor": () =>
		loadTemplate(() => import("./accessibility-auditor.js"), "accessibilityAuditorTemplate"),
	"i18n-auditor": () => loadTemplate(() => import("./i18n-auditor.js"), "i18nAuditorTemplate"),
	"dependency-auditor": () => loadTemplate(() => import("./dependency-auditor.js"), "dependencyAuditorTemplate"),
} as const;

export type ReviewTemplateName = keyof typeof reviewTemplates;
