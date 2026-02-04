/**
 * Workflow Engine - Graph-based workflow execution with branching, merging, and adaptive logic.
 *
 * Workflows are graphs of steps where each step can:
 * - Execute one or more agents/teams
 * - Branch based on conditions
 * - Skip steps based on context
 * - Pass context between steps
 */

import type { TeamResult } from "../types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Workflow step types
 */
export type WorkflowStepType = "agent" | "team" | "parallel" | "conditional" | "checkpoint";

/**
 * Condition for conditional steps
 */
export interface WorkflowCondition {
	/** Type of condition */
	type: "context" | "result" | "user" | "always" | "never";
	/** Field to check (for context/result conditions) */
	field?: string;
	/** Operator for comparison */
	operator?: "exists" | "equals" | "contains" | "gt" | "lt" | "empty" | "not_empty";
	/** Value to compare against */
	value?: unknown;
}

/**
 * A step in a workflow
 */
export interface WorkflowStep {
	/** Unique step ID */
	id: string;
	/** Human-readable name */
	name: string;
	/** Step type */
	type: WorkflowStepType;
	/** Agent/team names to execute (for agent/team/parallel types) */
	agents?: string[];
	/** Condition to evaluate (for conditional type) */
	condition?: WorkflowCondition;
	/** Steps to execute if condition is true */
	thenSteps?: string[];
	/** Steps to execute if condition is false */
	elseSteps?: string[];
	/** Whether this step can be skipped */
	skippable?: boolean;
	/** Default skip behavior if no explicit decision */
	skipByDefault?: boolean;
	/** Description of what this step does */
	description?: string;
	/** Steps that must complete before this one */
	dependsOn?: string[];
	/** Context keys this step reads */
	reads?: string[];
	/** Context keys this step writes */
	writes?: string[];
}

/**
 * A complete workflow definition
 */
export interface WorkflowDefinition {
	/** Unique workflow ID */
	id: string;
	/** Human-readable name */
	name: string;
	/** Description of the workflow */
	description: string;
	/** Workflow steps */
	steps: WorkflowStep[];
	/** Entry step ID */
	entryStep: string;
	/** Exit step IDs */
	exitSteps: string[];
	/** Default context values */
	defaultContext?: Record<string, unknown>;
	/** Tags for categorization */
	tags?: string[];
}

/**
 * Workflow execution context
 */
export interface WorkflowContext {
	/** Workflow-wide context data */
	data: Record<string, unknown>;
	/** Results from each completed step */
	stepResults: Map<string, WorkflowStepResult>;
	/** Current step being executed */
	currentStep?: string;
	/** Steps that have been skipped */
	skippedSteps: Set<string>;
	/** Steps that have been completed */
	completedSteps: Set<string>;
	/** User-provided skip decisions */
	skipDecisions: Map<string, boolean>;
}

/**
 * Result of a workflow step execution
 */
export interface WorkflowStepResult {
	stepId: string;
	status: "success" | "skipped" | "failed" | "pending";
	result?: TeamResult;
	error?: string;
	duration?: number;
	outputs?: Record<string, unknown>;
}

/**
 * Result of a complete workflow execution
 */
export interface WorkflowResult {
	workflowId: string;
	status: "success" | "partial" | "failed" | "aborted";
	stepResults: WorkflowStepResult[];
	context: WorkflowContext;
	duration: number;
	summary?: string;
}

/**
 * Event emitted during workflow execution
 */
export type WorkflowEvent =
	| { type: "workflow_start"; workflowId: string; steps: string[] }
	| { type: "step_start"; stepId: string; stepName: string }
	| { type: "step_skip"; stepId: string; reason: string }
	| { type: "step_complete"; stepId: string; result: WorkflowStepResult }
	| { type: "step_error"; stepId: string; error: string }
	| { type: "checkpoint"; stepId: string; message: string }
	| { type: "branch"; stepId: string; branch: "then" | "else" }
	| { type: "workflow_complete"; result: WorkflowResult };

// =============================================================================
// Workflow Templates
// =============================================================================

/**
 * Predefined workflow templates for common SDLC scenarios
 */
export const WORKFLOW_TEMPLATES: Record<string, WorkflowDefinition> = {
	"quick-fix": {
		id: "quick-fix",
		name: "Quick Fix",
		description: "Minimal workflow for small bug fixes",
		tags: ["bugfix", "fast"],
		entryStep: "analyze",
		exitSteps: ["review"],
		steps: [
			{
				id: "analyze",
				name: "Analyze Context",
				type: "agent",
				agents: ["context-analyzer"],
				writes: ["context"],
			},
			{
				id: "review",
				name: "Code Review",
				type: "team",
				agents: ["code-reviewer", "test-coverage-auditor"],
				dependsOn: ["analyze"],
				reads: ["context"],
			},
		],
	},

	feature: {
		id: "feature",
		name: "Feature Development",
		description: "Standard workflow for new feature development",
		tags: ["feature", "standard"],
		entryStep: "requirements",
		exitSteps: ["deliver"],
		steps: [
			{
				id: "requirements",
				name: "Requirements Analysis",
				type: "agent",
				agents: ["requirements-elicitor"],
				writes: ["requirements", "acceptance_criteria"],
			},
			{
				id: "design",
				name: "Solution Design",
				type: "agent",
				agents: ["solution-architect"],
				dependsOn: ["requirements"],
				reads: ["requirements"],
				writes: ["design"],
				skippable: true,
			},
			{
				id: "plan",
				name: "Task Planning",
				type: "agent",
				agents: ["task-orchestrator"],
				dependsOn: ["design"],
				reads: ["design", "requirements"],
				writes: ["tasks"],
			},
			{
				id: "validate",
				name: "Code Validation",
				type: "team",
				agents: ["code-reviewer", "security-auditor", "type-safety-auditor"],
				dependsOn: ["plan"],
				reads: ["design"],
			},
			{
				id: "verify",
				name: "Test Strategy",
				type: "agent",
				agents: ["test-strategist"],
				dependsOn: ["validate"],
				reads: ["requirements", "acceptance_criteria"],
				skippable: true,
			},
			{
				id: "deliver",
				name: "Release Preparation",
				type: "agent",
				agents: ["changelog-generator"],
				dependsOn: ["verify"],
				skippable: true,
			},
		],
	},

	greenfield: {
		id: "greenfield",
		name: "Greenfield Project",
		description: "Comprehensive workflow for new projects",
		tags: ["new-project", "comprehensive"],
		entryStep: "understand",
		exitSteps: ["deliver"],
		steps: [
			{
				id: "understand",
				name: "Requirements & Scope",
				type: "parallel",
				agents: ["requirements-elicitor", "scope-guardian", "stakeholder-mapper"],
				writes: ["requirements", "scope", "stakeholders"],
			},
			{
				id: "research",
				name: "Technology Research",
				type: "agent",
				agents: ["research-synthesizer"],
				dependsOn: ["understand"],
				reads: ["requirements"],
				writes: ["research"],
				skippable: true,
			},
			{
				id: "design",
				name: "Full Design",
				type: "parallel",
				agents: ["solution-architect", "api-contract-designer", "data-modeler"],
				dependsOn: ["research"],
				reads: ["requirements", "research"],
				writes: ["architecture", "api_contracts", "data_model"],
			},
			{
				id: "integration",
				name: "Integration Planning",
				type: "agent",
				agents: ["system-integrator"],
				dependsOn: ["design"],
				reads: ["architecture", "api_contracts"],
				writes: ["integrations"],
			},
			{
				id: "plan",
				name: "Task Breakdown",
				type: "parallel",
				agents: ["task-orchestrator", "implementation-strategist"],
				dependsOn: ["integration"],
				reads: ["architecture", "integrations"],
				writes: ["tasks", "strategy"],
			},
			{
				id: "validate",
				name: "Design Review",
				type: "team",
				agents: ["architecture-auditor", "api-design-auditor", "security-auditor"],
				dependsOn: ["plan"],
				reads: ["architecture", "api_contracts"],
			},
			{
				id: "verify",
				name: "Test Planning",
				type: "parallel",
				agents: ["test-strategist", "test-case-designer"],
				dependsOn: ["validate"],
				reads: ["requirements", "api_contracts"],
				writes: ["test_strategy", "test_cases"],
			},
			{
				id: "deliver",
				name: "Release Setup",
				type: "parallel",
				agents: ["deployment-validator", "release-coordinator"],
				dependsOn: ["verify"],
			},
		],
	},

	refactor: {
		id: "refactor",
		name: "Refactoring",
		description: "Workflow for code improvement and refactoring",
		tags: ["refactor", "improvement"],
		entryStep: "analyze",
		exitSteps: ["validate"],
		steps: [
			{
				id: "analyze",
				name: "Context Analysis",
				type: "agent",
				agents: ["context-analyzer"],
				writes: ["context", "patterns"],
			},
			{
				id: "advise",
				name: "Refactoring Advice",
				type: "agent",
				agents: ["refactoring-advisor"],
				dependsOn: ["analyze"],
				reads: ["context", "patterns"],
				writes: ["refactoring_plan"],
			},
			{
				id: "validate",
				name: "Quality Validation",
				type: "team",
				agents: ["code-reviewer", "type-safety-auditor", "test-coverage-auditor"],
				dependsOn: ["advise"],
				reads: ["refactoring_plan"],
			},
		],
	},

	"security-hardening": {
		id: "security-hardening",
		name: "Security Hardening",
		description: "Security-focused review and improvement workflow",
		tags: ["security", "hardening"],
		entryStep: "analyze",
		exitSteps: ["verify"],
		steps: [
			{
				id: "analyze",
				name: "Context Analysis",
				type: "agent",
				agents: ["context-analyzer"],
				writes: ["context"],
			},
			{
				id: "audit",
				name: "Security Audit",
				type: "team",
				agents: ["security-auditor", "privacy-auditor"],
				dependsOn: ["analyze"],
				reads: ["context"],
				writes: ["security_findings"],
			},
			{
				id: "plan",
				name: "Remediation Planning",
				type: "agent",
				agents: ["implementation-strategist"],
				dependsOn: ["audit"],
				reads: ["security_findings"],
				writes: ["remediation_plan"],
			},
			{
				id: "verify",
				name: "Regression Analysis",
				type: "agent",
				agents: ["regression-analyst"],
				dependsOn: ["plan"],
				reads: ["remediation_plan"],
			},
		],
	},

	"pre-release": {
		id: "pre-release",
		name: "Pre-Release",
		description: "Comprehensive pre-release validation workflow",
		tags: ["release", "validation"],
		entryStep: "validate",
		exitSteps: ["release"],
		steps: [
			{
				id: "validate",
				name: "Quality Validation",
				type: "team",
				agents: ["code-reviewer", "security-auditor", "type-safety-auditor", "test-coverage-auditor"],
				writes: ["validation_findings"],
			},
			{
				id: "verify",
				name: "Acceptance Verification",
				type: "parallel",
				agents: ["acceptance-verifier", "regression-analyst"],
				dependsOn: ["validate"],
				reads: ["validation_findings"],
				writes: ["verification_results"],
			},
			{
				id: "deploy-check",
				name: "Deployment Validation",
				type: "agent",
				agents: ["deployment-validator"],
				dependsOn: ["verify"],
				writes: ["deployment_readiness"],
			},
			{
				id: "release",
				name: "Release Coordination",
				type: "parallel",
				agents: ["changelog-generator", "release-coordinator"],
				dependsOn: ["deploy-check"],
				reads: ["deployment_readiness"],
			},
		],
	},

	maintenance: {
		id: "maintenance",
		name: "Maintenance",
		description: "Workflow for dependency updates and tech debt",
		tags: ["maintenance", "dependencies"],
		entryStep: "audit",
		exitSteps: ["changelog"],
		steps: [
			{
				id: "audit",
				name: "Dependency Audit",
				type: "agent",
				agents: ["dependency-auditor"],
				writes: ["dependency_findings"],
			},
			{
				id: "refactor",
				name: "Refactoring Analysis",
				type: "agent",
				agents: ["refactoring-advisor"],
				dependsOn: ["audit"],
				writes: ["refactoring_suggestions"],
				skippable: true,
			},
			{
				id: "validate",
				name: "Test Coverage Check",
				type: "agent",
				agents: ["test-coverage-auditor"],
				dependsOn: ["refactor"],
			},
			{
				id: "changelog",
				name: "Changelog Generation",
				type: "agent",
				agents: ["changelog-generator"],
				dependsOn: ["validate"],
			},
		],
	},

	"api-evolution": {
		id: "api-evolution",
		name: "API Evolution",
		description: "Workflow for API changes and versioning",
		tags: ["api", "versioning"],
		entryStep: "design",
		exitSteps: ["changelog"],
		steps: [
			{
				id: "design",
				name: "API Contract Design",
				type: "agent",
				agents: ["api-contract-designer"],
				writes: ["api_contracts"],
			},
			{
				id: "review",
				name: "API Design Review",
				type: "agent",
				agents: ["api-design-auditor"],
				dependsOn: ["design"],
				reads: ["api_contracts"],
				writes: ["api_findings"],
			},
			{
				id: "test",
				name: "Test Case Design",
				type: "agent",
				agents: ["test-case-designer"],
				dependsOn: ["review"],
				reads: ["api_contracts"],
				writes: ["test_cases"],
			},
			{
				id: "regression",
				name: "Regression Analysis",
				type: "agent",
				agents: ["regression-analyst"],
				dependsOn: ["test"],
				reads: ["api_contracts"],
			},
			{
				id: "changelog",
				name: "Changelog & Migration",
				type: "agent",
				agents: ["changelog-generator"],
				dependsOn: ["regression"],
				reads: ["api_contracts", "api_findings"],
			},
		],
	},

	"full-cycle": {
		id: "full-cycle",
		name: "Full SDLC Cycle",
		description: "Complete software development lifecycle",
		tags: ["comprehensive", "full"],
		entryStep: "understand",
		exitSteps: ["release"],
		steps: [
			{
				id: "understand",
				name: "Understand",
				type: "parallel",
				agents: ["requirements-elicitor", "context-analyzer", "scope-guardian"],
				writes: ["requirements", "context", "scope"],
			},
			{
				id: "research",
				name: "Research",
				type: "agent",
				agents: ["research-synthesizer"],
				dependsOn: ["understand"],
				reads: ["requirements"],
				writes: ["research"],
				skippable: true,
			},
			{
				id: "design",
				name: "Design",
				type: "parallel",
				agents: ["solution-architect", "api-contract-designer"],
				dependsOn: ["research"],
				reads: ["requirements", "research"],
				writes: ["architecture", "api_contracts"],
			},
			{
				id: "plan",
				name: "Plan",
				type: "parallel",
				agents: ["task-orchestrator", "implementation-strategist"],
				dependsOn: ["design"],
				reads: ["architecture"],
				writes: ["tasks", "strategy"],
			},
			{
				id: "validate",
				name: "Validate",
				type: "team",
				agents: ["code-reviewer", "security-auditor", "architecture-auditor"],
				dependsOn: ["plan"],
				reads: ["architecture", "api_contracts"],
				writes: ["validation_findings"],
			},
			{
				id: "verify",
				name: "Verify",
				type: "parallel",
				agents: ["test-strategist", "acceptance-verifier"],
				dependsOn: ["validate"],
				reads: ["requirements", "validation_findings"],
				writes: ["test_strategy", "acceptance_results"],
			},
			{
				id: "release",
				name: "Release",
				type: "parallel",
				agents: ["changelog-generator", "deployment-validator", "release-coordinator"],
				dependsOn: ["verify"],
			},
		],
	},
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get a workflow template by ID
 */
export function getWorkflowTemplate(id: string): WorkflowDefinition | undefined {
	return WORKFLOW_TEMPLATES[id];
}

/**
 * List all available workflow templates
 */
export function listWorkflowTemplates(): WorkflowDefinition[] {
	return Object.values(WORKFLOW_TEMPLATES);
}

/**
 * Get the topological order of steps for execution
 */
export function getExecutionOrder(workflow: WorkflowDefinition): string[] {
	const visited = new Set<string>();
	const result: string[] = [];
	const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));

	function visit(stepId: string) {
		if (visited.has(stepId)) return;
		visited.add(stepId);

		const step = stepMap.get(stepId);
		if (!step) return;

		// Visit dependencies first
		for (const dep of step.dependsOn || []) {
			visit(dep);
		}

		result.push(stepId);
	}

	// Start from entry step and traverse
	visit(workflow.entryStep);

	// Also visit any steps not reachable from entry (shouldn't happen in well-formed workflows)
	for (const step of workflow.steps) {
		visit(step.id);
	}

	return result;
}

/**
 * Validate a workflow definition
 */
export function validateWorkflow(workflow: WorkflowDefinition): string[] {
	const errors: string[] = [];
	const stepIds = new Set(workflow.steps.map((s) => s.id));

	// Check entry step exists
	if (!stepIds.has(workflow.entryStep)) {
		errors.push(`Entry step '${workflow.entryStep}' not found`);
	}

	// Check exit steps exist
	for (const exitStep of workflow.exitSteps) {
		if (!stepIds.has(exitStep)) {
			errors.push(`Exit step '${exitStep}' not found`);
		}
	}

	// Check dependencies exist
	for (const step of workflow.steps) {
		for (const dep of step.dependsOn || []) {
			if (!stepIds.has(dep)) {
				errors.push(`Step '${step.id}' depends on non-existent step '${dep}'`);
			}
		}
	}

	// Check for cycles
	const visited = new Set<string>();
	const recursionStack = new Set<string>();

	function hasCycle(stepId: string): boolean {
		visited.add(stepId);
		recursionStack.add(stepId);

		const step = workflow.steps.find((s) => s.id === stepId);
		for (const dep of step?.dependsOn || []) {
			if (!visited.has(dep)) {
				if (hasCycle(dep)) return true;
			} else if (recursionStack.has(dep)) {
				errors.push(`Circular dependency detected involving '${stepId}' and '${dep}'`);
				return true;
			}
		}

		recursionStack.delete(stepId);
		return false;
	}

	for (const step of workflow.steps) {
		if (!visited.has(step.id)) {
			hasCycle(step.id);
		}
	}

	return errors;
}

/**
 * Create initial workflow context
 */
export function createWorkflowContext(workflow: WorkflowDefinition): WorkflowContext {
	return {
		data: { ...workflow.defaultContext },
		stepResults: new Map(),
		skippedSteps: new Set(),
		completedSteps: new Set(),
		skipDecisions: new Map(),
	};
}

/**
 * Check if a step should be skipped
 */
export function shouldSkipStep(step: WorkflowStep, context: WorkflowContext): { skip: boolean; reason?: string } {
	// Check explicit skip decision
	if (context.skipDecisions.has(step.id)) {
		const decision = context.skipDecisions.get(step.id)!;
		return { skip: decision, reason: decision ? "User decision" : undefined };
	}

	// Check if dependencies were skipped
	for (const dep of step.dependsOn || []) {
		if (context.skippedSteps.has(dep)) {
			return { skip: true, reason: `Dependency '${dep}' was skipped` };
		}
	}

	// Check default skip behavior
	if (step.skipByDefault) {
		return { skip: true, reason: "Skipped by default" };
	}

	return { skip: false };
}
