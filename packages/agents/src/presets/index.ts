// =============================================================================
// UNDERSTAND Category - Requirements, Context, Research
// =============================================================================

// =============================================================================
// VERIFY Category - Testing Strategy & Validation
// =============================================================================
export { acceptanceVerifierTemplate } from "./acceptance-verifier.js";
// =============================================================================
// VALIDATE Category - Code Review & Auditing (Existing)
// =============================================================================
export { accessibilityAuditorTemplate } from "./accessibility-auditor.js";
// =============================================================================
// DESIGN Category - Architecture, API, Data Modeling
// =============================================================================
export { apiContractDesignerTemplate } from "./api-contract-designer.js";
export { apiDesignAuditorTemplate } from "./api-design-auditor.js";
export { architectureAuditorTemplate } from "./architecture-auditor.js";
// =============================================================================
// DELIVER Category - Release & Deployment
// =============================================================================
export { changelogGeneratorTemplate } from "./changelog-generator.js";
// =============================================================================
// IMPLEMENT Category - Task Planning, Code Generation
// =============================================================================
export { codeGeneratorTemplate } from "./code-generator.js";
export { codeReviewerTemplate } from "./code-reviewer.js";
export { concurrencyAuditorTemplate } from "./concurrency-auditor.js";
export { contextAnalyzerTemplate } from "./context-analyzer.js";
export { dataModelerTemplate } from "./data-modeler.js";
export { dependencyAuditorTemplate } from "./dependency-auditor.js";
export { deploymentValidatorTemplate } from "./deployment-validator.js";
export { docsAuditorTemplate } from "./docs-auditor.js";
export { errorHandlingAuditorTemplate } from "./error-handling-auditor.js";
export { i18nAuditorTemplate } from "./i18n-auditor.js";
export { implementationStrategistTemplate } from "./implementation-strategist.js";
// =============================================================================
// ORCHESTRATION Category - Meta-agents
// =============================================================================
export { leadAnalyzerTemplate } from "./lead-analyzer.js";
export { mergeSynthesizerTemplate } from "./merge-synthesizer.js";
export { perfAnalyzerTemplate } from "./perf-analyzer.js";
export { privacyAuditorTemplate } from "./privacy-auditor.js";
export { refactoringAdvisorTemplate } from "./refactoring-advisor.js";
export { regressionAnalystTemplate } from "./regression-analyst.js";
export { releaseCoordinatorTemplate } from "./release-coordinator.js";
export { requirementsElicitorTemplate } from "./requirements-elicitor.js";
export { researchSynthesizerTemplate } from "./research-synthesizer.js";
export { scopeGuardianTemplate } from "./scope-guardian.js";
export { securityAuditorTemplate } from "./security-auditor.js";
export { solutionArchitectTemplate } from "./solution-architect.js";
export { stakeholderMapperTemplate } from "./stakeholder-mapper.js";
export { systemIntegratorTemplate } from "./system-integrator.js";
export { taskOrchestratorTemplate } from "./task-orchestrator.js";
export { testCaseDesignerTemplate } from "./test-case-designer.js";
export { testCoverageAuditorTemplate } from "./test-coverage-auditor.js";
export { testStrategistTemplate } from "./test-strategist.js";
export { typeSafetyAuditorTemplate } from "./type-safety-auditor.js";
// =============================================================================
// Types and Utilities
// =============================================================================
export type { CreatePresetOptions, PresetTemplate } from "./types.js";
export { createPreset, EPSILON_TASK_INSTRUCTIONS, TOOL_USAGE_INSTRUCTIONS } from "./types.js";
export { workflowOrchestratorTemplate } from "./workflow-orchestrator.js";

// =============================================================================
// Dynamic Template Loaders
// =============================================================================

// Helper to wrap dynamic import with error handling and runtime type validation
function loadTemplate<T>(importFn: () => Promise<Record<string, unknown>>, key: string): Promise<T> {
	return importFn()
		.then((m) => {
			const value = m[key];
			if (value === undefined) {
				throw new Error(`Export '${key}' not found in module`);
			}
			// Runtime validation: ensure it's a PresetTemplate-like object
			if (typeof value !== "object" || value === null || !("name" in value) || !("systemPrompt" in value)) {
				throw new Error(`Export '${key}' is not a valid preset template`);
			}
			return value as T;
		})
		.catch((err) => {
			throw new Error(
				`Failed to load preset template '${key}': ${err instanceof Error ? err.message : String(err)}`,
			);
		});
}

// -----------------------------------------------------------------------------
// UNDERSTAND Templates
// -----------------------------------------------------------------------------
export const understandTemplates = {
	"requirements-elicitor": () =>
		loadTemplate(() => import("./requirements-elicitor.js"), "requirementsElicitorTemplate"),
	"context-analyzer": () => loadTemplate(() => import("./context-analyzer.js"), "contextAnalyzerTemplate"),
	"stakeholder-mapper": () => loadTemplate(() => import("./stakeholder-mapper.js"), "stakeholderMapperTemplate"),
	"scope-guardian": () => loadTemplate(() => import("./scope-guardian.js"), "scopeGuardianTemplate"),
	"research-synthesizer": () => loadTemplate(() => import("./research-synthesizer.js"), "researchSynthesizerTemplate"),
} as const;

export type UnderstandTemplateName = keyof typeof understandTemplates;

// -----------------------------------------------------------------------------
// DESIGN Templates
// -----------------------------------------------------------------------------
export const designTemplates = {
	"solution-architect": () => loadTemplate(() => import("./solution-architect.js"), "solutionArchitectTemplate"),
	"api-contract-designer": () =>
		loadTemplate(() => import("./api-contract-designer.js"), "apiContractDesignerTemplate"),
	"data-modeler": () => loadTemplate(() => import("./data-modeler.js"), "dataModelerTemplate"),
	"system-integrator": () => loadTemplate(() => import("./system-integrator.js"), "systemIntegratorTemplate"),
} as const;

export type DesignTemplateName = keyof typeof designTemplates;

// -----------------------------------------------------------------------------
// IMPLEMENT Templates
// -----------------------------------------------------------------------------
export const implementTemplates = {
	"task-orchestrator": () => loadTemplate(() => import("./task-orchestrator.js"), "taskOrchestratorTemplate"),
	"implementation-strategist": () =>
		loadTemplate(() => import("./implementation-strategist.js"), "implementationStrategistTemplate"),
	"code-generator": () => loadTemplate(() => import("./code-generator.js"), "codeGeneratorTemplate"),
	"refactoring-advisor": () => loadTemplate(() => import("./refactoring-advisor.js"), "refactoringAdvisorTemplate"),
} as const;

export type ImplementTemplateName = keyof typeof implementTemplates;

// -----------------------------------------------------------------------------
// VALIDATE Templates (Review & Audit)
// -----------------------------------------------------------------------------
export const validateTemplates = {
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

export type ValidateTemplateName = keyof typeof validateTemplates;

// Backward compatibility alias
export const reviewTemplates = validateTemplates;
export type ReviewTemplateName = ValidateTemplateName;

// -----------------------------------------------------------------------------
// VERIFY Templates (Testing)
// -----------------------------------------------------------------------------
export const verifyTemplates = {
	"test-strategist": () => loadTemplate(() => import("./test-strategist.js"), "testStrategistTemplate"),
	"test-case-designer": () => loadTemplate(() => import("./test-case-designer.js"), "testCaseDesignerTemplate"),
	"acceptance-verifier": () => loadTemplate(() => import("./acceptance-verifier.js"), "acceptanceVerifierTemplate"),
	"regression-analyst": () => loadTemplate(() => import("./regression-analyst.js"), "regressionAnalystTemplate"),
} as const;

export type VerifyTemplateName = keyof typeof verifyTemplates;

// -----------------------------------------------------------------------------
// DELIVER Templates (Release)
// -----------------------------------------------------------------------------
export const deliverTemplates = {
	"changelog-generator": () => loadTemplate(() => import("./changelog-generator.js"), "changelogGeneratorTemplate"),
	"deployment-validator": () => loadTemplate(() => import("./deployment-validator.js"), "deploymentValidatorTemplate"),
	"release-coordinator": () => loadTemplate(() => import("./release-coordinator.js"), "releaseCoordinatorTemplate"),
} as const;

export type DeliverTemplateName = keyof typeof deliverTemplates;

// -----------------------------------------------------------------------------
// ORCHESTRATION Templates (Meta-agents)
// -----------------------------------------------------------------------------
export const orchestrationTemplates = {
	"lead-analyzer": () => loadTemplate(() => import("./lead-analyzer.js"), "leadAnalyzerTemplate"),
	"merge-synthesizer": () => loadTemplate(() => import("./merge-synthesizer.js"), "mergeSynthesizerTemplate"),
	"workflow-orchestrator": () =>
		loadTemplate(() => import("./workflow-orchestrator.js"), "workflowOrchestratorTemplate"),
} as const;

export type OrchestrationTemplateName = keyof typeof orchestrationTemplates;

// -----------------------------------------------------------------------------
// ALL Templates - Union of all categories
// -----------------------------------------------------------------------------
export const allTemplates = {
	...understandTemplates,
	...designTemplates,
	...implementTemplates,
	...validateTemplates,
	...verifyTemplates,
	...deliverTemplates,
	...orchestrationTemplates,
} as const;

export type AllTemplateName = keyof typeof allTemplates;

// -----------------------------------------------------------------------------
// Category groupings for workflow engine
// -----------------------------------------------------------------------------
export const templateCategories = {
	understand: understandTemplates,
	design: designTemplates,
	implement: implementTemplates,
	validate: validateTemplates,
	verify: verifyTemplates,
	deliver: deliverTemplates,
	orchestration: orchestrationTemplates,
} as const;

export type TemplateCategory = keyof typeof templateCategories;
