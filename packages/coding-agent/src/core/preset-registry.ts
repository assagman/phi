/**
 * Shared preset registry - Single source of truth for agent presets.
 *
 * This module consolidates the preset registry used by both team.ts and team-config.ts,
 * eliminating duplication and providing compile-time type safety for preset names.
 */

import {
	accessibilityAuditorTemplate,
	apiDesignAuditorTemplate,
	architectureAuditorTemplate,
	codeReviewerTemplate,
	concurrencyAuditorTemplate,
	dependencyAuditorTemplate,
	docsAuditorTemplate,
	errorHandlingAuditorTemplate,
	i18nAuditorTemplate,
	mergeSynthesizerTemplate,
	type PresetTemplate,
	perfAnalyzerTemplate,
	privacyAuditorTemplate,
	securityAuditorTemplate,
	testCoverageAuditorTemplate,
	typeSafetyAuditorTemplate,
} from "agents";

// ============================================================================
// Registry Definition
// ============================================================================

/**
 * Single source of truth for all available preset templates.
 * Adding a new preset here automatically updates the PresetName type.
 */
export const PRESET_REGISTRY = {
	// Core
	"code-reviewer": codeReviewerTemplate,
	"security-auditor": securityAuditorTemplate,
	"perf-analyzer": perfAnalyzerTemplate,
	"merge-synthesizer": mergeSynthesizerTemplate,
	// Security & Privacy
	"privacy-auditor": privacyAuditorTemplate,
	// Code Quality
	"type-safety-auditor": typeSafetyAuditorTemplate,
	"test-coverage-auditor": testCoverageAuditorTemplate,
	"error-handling-auditor": errorHandlingAuditorTemplate,
	"concurrency-auditor": concurrencyAuditorTemplate,
	// Design
	"architecture-auditor": architectureAuditorTemplate,
	"api-design-auditor": apiDesignAuditorTemplate,
	// Content & Ecosystem
	"docs-auditor": docsAuditorTemplate,
	"accessibility-auditor": accessibilityAuditorTemplate,
	"i18n-auditor": i18nAuditorTemplate,
	"dependency-auditor": dependencyAuditorTemplate,
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
	// Core
	{ name: "code-reviewer", description: "General code quality, bugs, logic errors, maintainability" },
	{ name: "security-auditor", description: "Security vulnerabilities, OWASP Top 10, CWE, attack surface" },
	{ name: "perf-analyzer", description: "Performance issues, complexity, memory, I/O optimization" },
	// Security & Privacy
	{ name: "privacy-auditor", description: "PII handling, GDPR/CCPA compliance, data protection" },
	// Code Quality
	{ name: "type-safety-auditor", description: "Type safety, type holes, unsafe casts, generics" },
	{ name: "test-coverage-auditor", description: "Test coverage gaps, edge cases, test quality" },
	{ name: "error-handling-auditor", description: "Error handling, resilience, fault tolerance, retries" },
	{ name: "concurrency-auditor", description: "Race conditions, deadlocks, thread safety, async patterns" },
	// Design
	{ name: "architecture-auditor", description: "Architecture, SOLID, patterns, modularity, dependencies" },
	{ name: "api-design-auditor", description: "API design, REST/GraphQL/gRPC, contracts, versioning" },
	// Content & Ecosystem
	{ name: "docs-auditor", description: "Documentation completeness, accuracy, examples" },
	{ name: "accessibility-auditor", description: "Accessibility, WCAG compliance, a11y best practices" },
	{ name: "i18n-auditor", description: "Internationalization, Unicode, locale handling, RTL" },
	{ name: "dependency-auditor", description: "Dependency health, CVEs, outdated packages, bloat" },
] as const;

/**
 * Get agent info by name.
 */
export function getAgentInfo(name: PresetName): AgentInfo | undefined {
	return AGENT_INFO.find((a) => a.name === name);
}
