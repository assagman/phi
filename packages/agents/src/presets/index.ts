// Preset templates
export { codeReviewerTemplate } from "./code-reviewer.js";
export { mergeSynthesizerTemplate } from "./merge-synthesizer.js";
export { perfAnalyzerTemplate } from "./perf-analyzer.js";
export { securityAuditorTemplate } from "./security-auditor.js";
export type { PresetTemplate } from "./types.js";
// Preset utilities
export { createPreset } from "./types.js";

// Convenience: all review templates (excluding merge-synthesizer)
export const reviewTemplates = {
	"code-reviewer": () => import("./code-reviewer.js").then((m) => m.codeReviewerTemplate),
	"security-auditor": () => import("./security-auditor.js").then((m) => m.securityAuditorTemplate),
	"perf-analyzer": () => import("./perf-analyzer.js").then((m) => m.perfAnalyzerTemplate),
} as const;

export type ReviewTemplateName = keyof typeof reviewTemplates;
