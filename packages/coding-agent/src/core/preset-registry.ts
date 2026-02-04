/**
 * Shared preset registry - Single source of truth for agent presets.
 *
 * This module consolidates the preset registry used by both team.ts and team-config.ts,
 * eliminating duplication and providing compile-time type safety for preset names.
 */

import {
	// VERIFY
	acceptanceVerifierTemplate,
	// VALIDATE (existing)
	accessibilityAuditorTemplate,
	// DESIGN
	apiContractDesignerTemplate,
	apiDesignAuditorTemplate,
	architectureAuditorTemplate,
	// DELIVER
	changelogGeneratorTemplate,
	// IMPLEMENT
	codeGeneratorTemplate,
	codeReviewerTemplate,
	concurrencyAuditorTemplate,
	// UNDERSTAND
	contextAnalyzerTemplate,
	dataModelerTemplate,
	dependencyAuditorTemplate,
	deploymentValidatorTemplate,
	docsAuditorTemplate,
	errorHandlingAuditorTemplate,
	i18nAuditorTemplate,
	implementationStrategistTemplate,
	// ORCHESTRATION
	leadAnalyzerTemplate,
	mergeSynthesizerTemplate,
	type PresetTemplate,
	perfAnalyzerTemplate,
	privacyAuditorTemplate,
	refactoringAdvisorTemplate,
	regressionAnalystTemplate,
	releaseCoordinatorTemplate,
	requirementsElicitorTemplate,
	researchSynthesizerTemplate,
	scopeGuardianTemplate,
	securityAuditorTemplate,
	solutionArchitectTemplate,
	stakeholderMapperTemplate,
	systemIntegratorTemplate,
	taskOrchestratorTemplate,
	testCaseDesignerTemplate,
	testCoverageAuditorTemplate,
	testStrategistTemplate,
	typeSafetyAuditorTemplate,
	workflowOrchestratorTemplate,
} from "agents";

// ============================================================================
// Registry Definition
// ============================================================================

/**
 * Single source of truth for all available preset templates.
 * Adding a new preset here automatically updates the PresetName type.
 */
export const PRESET_REGISTRY = {
	// -------------------------------------------------------------------------
	// UNDERSTAND - Requirements, Context, Research
	// -------------------------------------------------------------------------
	"requirements-elicitor": requirementsElicitorTemplate,
	"context-analyzer": contextAnalyzerTemplate,
	"stakeholder-mapper": stakeholderMapperTemplate,
	"scope-guardian": scopeGuardianTemplate,
	"research-synthesizer": researchSynthesizerTemplate,

	// -------------------------------------------------------------------------
	// DESIGN - Architecture, API, Data Modeling
	// -------------------------------------------------------------------------
	"solution-architect": solutionArchitectTemplate,
	"api-contract-designer": apiContractDesignerTemplate,
	"data-modeler": dataModelerTemplate,
	"system-integrator": systemIntegratorTemplate,

	// -------------------------------------------------------------------------
	// IMPLEMENT - Task Planning, Code Generation
	// -------------------------------------------------------------------------
	"task-orchestrator": taskOrchestratorTemplate,
	"implementation-strategist": implementationStrategistTemplate,
	"code-generator": codeGeneratorTemplate,
	"refactoring-advisor": refactoringAdvisorTemplate,

	// -------------------------------------------------------------------------
	// VALIDATE - Code Review & Auditing
	// -------------------------------------------------------------------------
	"code-reviewer": codeReviewerTemplate,
	"security-auditor": securityAuditorTemplate,
	"perf-analyzer": perfAnalyzerTemplate,
	"privacy-auditor": privacyAuditorTemplate,
	"type-safety-auditor": typeSafetyAuditorTemplate,
	"test-coverage-auditor": testCoverageAuditorTemplate,
	"error-handling-auditor": errorHandlingAuditorTemplate,
	"concurrency-auditor": concurrencyAuditorTemplate,
	"architecture-auditor": architectureAuditorTemplate,
	"api-design-auditor": apiDesignAuditorTemplate,
	"docs-auditor": docsAuditorTemplate,
	"accessibility-auditor": accessibilityAuditorTemplate,
	"i18n-auditor": i18nAuditorTemplate,
	"dependency-auditor": dependencyAuditorTemplate,

	// -------------------------------------------------------------------------
	// VERIFY - Testing Strategy & Validation
	// -------------------------------------------------------------------------
	"test-strategist": testStrategistTemplate,
	"test-case-designer": testCaseDesignerTemplate,
	"acceptance-verifier": acceptanceVerifierTemplate,
	"regression-analyst": regressionAnalystTemplate,

	// -------------------------------------------------------------------------
	// DELIVER - Release & Deployment
	// -------------------------------------------------------------------------
	"changelog-generator": changelogGeneratorTemplate,
	"deployment-validator": deploymentValidatorTemplate,
	"release-coordinator": releaseCoordinatorTemplate,

	// -------------------------------------------------------------------------
	// ORCHESTRATION - Meta-agents
	// -------------------------------------------------------------------------
	"lead-analyzer": leadAnalyzerTemplate,
	"merge-synthesizer": mergeSynthesizerTemplate,
	"workflow-orchestrator": workflowOrchestratorTemplate,
} as const satisfies Record<string, PresetTemplate>;

// ============================================================================
// Types (derived from registry)
// ============================================================================

/**
 * Union type of all valid preset names.
 * Derived from PRESET_REGISTRY keys for compile-time safety.
 */
export type PresetName = keyof typeof PRESET_REGISTRY;

/**
 * Array of all preset names (for iteration).
 */
export const PRESET_NAMES = Object.keys(PRESET_REGISTRY) as PresetName[];

// ============================================================================
// Accessors
// ============================================================================

/**
 * Get a preset template by name with type-safe lookup.
 */
export function getPresetTemplate(name: PresetName): PresetTemplate;
export function getPresetTemplate(name: string): PresetTemplate | undefined;
export function getPresetTemplate(name: string): PresetTemplate | undefined {
	return PRESET_REGISTRY[name as PresetName];
}

/**
 * Check if a string is a valid preset name.
 */
export function isPresetName(name: string): name is PresetName {
	return name in PRESET_REGISTRY;
}

/**
 * Get list of available preset names.
 */
export function getAvailablePresets(): PresetName[] {
	return PRESET_NAMES;
}

// ============================================================================
// Agent Metadata (descriptions for help/UI)
// ============================================================================

/**
 * Agent info for help text and UI display.
 */
export interface AgentInfo {
	name: PresetName;
	description: string;
}

/**
 * Available agents with descriptions.
 * Uses PresetName for compile-time validation against PRESET_REGISTRY.
 */
export const AGENT_INFO: readonly AgentInfo[] = [
	// UNDERSTAND
	{
		name: "requirements-elicitor",
		description: "Extract requirements, identify ambiguities, generate acceptance criteria",
	},
	{ name: "context-analyzer", description: "Analyze existing codebase context, patterns, constraints" },
	{ name: "stakeholder-mapper", description: "Identify stakeholders, map priorities, analyze trade-offs" },
	{ name: "scope-guardian", description: "Define scope boundaries, detect scope creep, protect focus" },
	{ name: "research-synthesizer", description: "Research technologies, evaluate libraries, find best practices" },
	// DESIGN
	{ name: "solution-architect", description: "High-level design, component breakdown, integration strategy" },
	{ name: "api-contract-designer", description: "Design API interfaces, contracts, schemas, versioning" },
	{ name: "data-modeler", description: "Database schemas, data structures, migration strategies" },
	{ name: "system-integrator", description: "Plan integrations, service dependencies, third-party coordination" },
	// IMPLEMENT
	{ name: "task-orchestrator", description: "Task decomposition, dependency mapping, effort estimation" },
	{ name: "implementation-strategist", description: "Implementation approach, patterns, migration planning" },
	{ name: "code-generator", description: "Generate code from specs, scaffolds, boilerplate" },
	{ name: "refactoring-advisor", description: "Identify refactoring opportunities, code smells, improvements" },
	// VALIDATE
	{ name: "code-reviewer", description: "General code quality, bugs, logic errors, maintainability" },
	{ name: "security-auditor", description: "Security vulnerabilities, OWASP Top 10, CWE, attack surface" },
	{ name: "perf-analyzer", description: "Performance issues, complexity, memory, I/O optimization" },
	{ name: "privacy-auditor", description: "PII handling, GDPR/CCPA compliance, data protection" },
	{ name: "type-safety-auditor", description: "Type safety, type holes, unsafe casts, generics" },
	{ name: "test-coverage-auditor", description: "Test coverage gaps, edge cases, test quality" },
	{ name: "error-handling-auditor", description: "Error handling, resilience, fault tolerance, retries" },
	{ name: "concurrency-auditor", description: "Race conditions, deadlocks, thread safety, async patterns" },
	{ name: "architecture-auditor", description: "Architecture, SOLID, patterns, modularity, dependencies" },
	{ name: "api-design-auditor", description: "API design quality, REST/GraphQL/gRPC, contracts" },
	{ name: "docs-auditor", description: "Documentation completeness, accuracy, examples" },
	{ name: "accessibility-auditor", description: "Accessibility, WCAG compliance, a11y best practices" },
	{ name: "i18n-auditor", description: "Internationalization, Unicode, locale handling, RTL" },
	{ name: "dependency-auditor", description: "Dependency health, CVEs, outdated packages, bloat" },
	// VERIFY
	{ name: "test-strategist", description: "Test strategy, coverage plans, test pyramid design" },
	{ name: "test-case-designer", description: "Generate test cases, edge cases, test scenarios" },
	{ name: "acceptance-verifier", description: "Validate against acceptance criteria, requirement traceability" },
	{ name: "regression-analyst", description: "Change impact analysis, regression risks, blast radius" },
	// DELIVER
	{ name: "changelog-generator", description: "Release notes, changelogs, migration guides" },
	{ name: "deployment-validator", description: "Deployment readiness, configuration validation" },
	{ name: "release-coordinator", description: "Release orchestration, gate validation, sign-offs" },
	// ORCHESTRATION (meta-agents, typically not shown to users)
	{ name: "lead-analyzer", description: "Analyze project context, select appropriate teams (meta)" },
	{ name: "merge-synthesizer", description: "Merge and verify findings from multiple agents (meta)" },
	{ name: "workflow-orchestrator", description: "Plan and coordinate dynamic agent workflows (meta)" },
] as const;

/**
 * Get agent info by name.
 */
export function getAgentInfo(name: PresetName): AgentInfo | undefined {
	return AGENT_INFO.find((a) => a.name === name);
}

// ============================================================================
// Agent Categories for UI grouping
// ============================================================================

export const AGENT_CATEGORIES = {
	understand: [
		"requirements-elicitor",
		"context-analyzer",
		"stakeholder-mapper",
		"scope-guardian",
		"research-synthesizer",
	] as const,
	design: ["solution-architect", "api-contract-designer", "data-modeler", "system-integrator"] as const,
	implement: ["task-orchestrator", "implementation-strategist", "code-generator", "refactoring-advisor"] as const,
	validate: [
		"code-reviewer",
		"security-auditor",
		"perf-analyzer",
		"privacy-auditor",
		"type-safety-auditor",
		"test-coverage-auditor",
		"error-handling-auditor",
		"concurrency-auditor",
		"architecture-auditor",
		"api-design-auditor",
		"docs-auditor",
		"accessibility-auditor",
		"i18n-auditor",
		"dependency-auditor",
	] as const,
	verify: ["test-strategist", "test-case-designer", "acceptance-verifier", "regression-analyst"] as const,
	deliver: ["changelog-generator", "deployment-validator", "release-coordinator"] as const,
	orchestration: ["lead-analyzer", "merge-synthesizer", "workflow-orchestrator"] as const,
} as const;

export type AgentCategory = keyof typeof AGENT_CATEGORIES;
