# Changelog

All notable changes to the `@phi/agents` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-04

### Highlights

This is the initial release of the `@phi/agents` package, introducing a comprehensive **multi-agent orchestration system** for code review, analysis, and software development lifecycle automation. Key capabilities include:

- **35+ Specialized Agent Presets** covering the entire SDLC
- **Team Orchestration** with parallel/sequential execution strategies
- **Intelligent Merge Strategies** (union, intersection, verification)
- **Graph-Based Workflow Engine** with dependency-aware execution waves
- **Real-time Event Streaming** for UI progress updates
- **Epsilon Task Tracking Integration** for granular progress visibility

---

### 🚀 Added

#### Core Framework

- **ADDED: Team Class** - Core orchestration engine for running multiple agents
  - Parallel and sequential execution strategies
  - Automatic retry with configurable `maxRetries`
  - Graceful error handling with `continueOnError` option
  - Abort signal support for cancellation
  - Real-time event streaming via `EventStream<TeamEvent, TeamResult>`

- **ADDED: AgentPreset System** - Reusable, model-agnostic agent configurations
  - `createPreset(template, model, overrides)` factory function
  - Support for thinking levels, temperature, and max tokens
  - Optional epsilon task tracking injection via `injectEpsilon` flag

- **ADDED: PresetTemplate Interface** - Standardized template structure
  ```typescript
  interface PresetTemplate {
    name: string;
    description: string;
    systemPrompt: string;
    thinkingLevel?: ThinkingLevel;
    temperature?: number;
    maxTokens?: number;
  }
  ```

#### Agent Presets (35+ Specialized Agents)

**UNDERSTAND Category** - Requirements, Context, Research
- `requirements-elicitor` - Elicit and structure requirements
- `context-analyzer` - Analyze codebase context and patterns
- `stakeholder-mapper` - Identify stakeholders and concerns
- `scope-guardian` - Protect scope and detect creep
- `research-synthesizer` - Synthesize technical research

**DESIGN Category** - Architecture, API, Data Modeling
- `solution-architect` - Design system architecture
- `api-contract-designer` - Design API interfaces and schemas
- `data-modeler` - Design data models and schemas
- `system-integrator` - Plan system integrations

**IMPLEMENT Category** - Task Planning, Code Generation
- `task-orchestrator` - Break down work into tasks
- `implementation-strategist` - Determine implementation approach
- `code-generator` - Generate code implementations
- `refactoring-advisor` - Advise on refactoring strategies

**VALIDATE Category** - Code Review & Auditing
- `code-reviewer` - General code quality review
- `security-auditor` - Security vulnerability analysis (OWASP/CWE)
- `perf-analyzer` - Performance analysis
- `privacy-auditor` - Privacy and data protection audit
- `type-safety-auditor` - TypeScript type safety analysis
- `test-coverage-auditor` - Test coverage gaps analysis
- `error-handling-auditor` - Error handling patterns audit
- `concurrency-auditor` - Race conditions and thread safety
- `architecture-auditor` - Architecture and SOLID principles
- `api-design-auditor` - API design quality review
- `docs-auditor` - Documentation completeness audit
- `accessibility-auditor` - WCAG/a11y compliance
- `i18n-auditor` - Internationalization readiness
- `dependency-auditor` - Dependency health and security

**VERIFY Category** - Testing Strategy & Validation
- `test-strategist` - Design test strategies
- `test-case-designer` - Design specific test cases
- `acceptance-verifier` - Verify acceptance criteria
- `regression-analyst` - Analyze regression risks

**DELIVER Category** - Release & Deployment
- `changelog-generator` - Generate release notes and changelogs
- `deployment-validator` - Validate deployment readiness
- `release-coordinator` - Coordinate release activities

**ORCHESTRATION Category** - Meta-agents
- `lead-analyzer` - Analyze and select appropriate agents
- `merge-synthesizer` - Verify and synthesize findings
- `workflow-orchestrator` - Plan dynamic workflows

#### Merge Strategies

- **ADDED: Union Strategy** - Include all findings from all agents
  - Best for comprehensive coverage
  - No deduplication by default

- **ADDED: Intersection Strategy** - Only findings reported by 2+ agents
  - Best for high-confidence results
  - Automatic clustering by file+line similarity

- **ADDED: Verification Strategy** - AI-powered finding verification
  - Cluster findings by similarity
  - Verify clusters against actual code
  - Rank by severity and agreement count
  - Generate synthesis summary

- **ADDED: Custom Strategy** - User-provided merge function
  ```typescript
  merge: {
    strategy: "custom",
    customMerge: async (results: AgentResult[]) => TeamResult
  }
  ```

#### Workflow Engine

- **ADDED: WorkflowDefinition** - Graph-based workflow definitions
  - Step dependencies with `dependsOn`
  - Context passing with `reads`/`writes`
  - Conditional branching with `thenSteps`/`elseSteps`
  - Skippable steps with user overrides

- **ADDED: 9 Pre-built Workflow Templates**
  | Workflow | Use Case | Key Steps |
  |----------|----------|-----------|
  | `quick-fix` | Small bug fixes | analyze → review |
  | `feature` | New features | requirements → design → plan → validate → verify → deliver |
  | `greenfield` | New projects | understand → research → design → integration → plan → validate → verify → deliver |
  | `refactor` | Code improvements | analyze → advise → validate |
  | `security-hardening` | Security focus | analyze → audit → plan → verify |
  | `pre-release` | Release validation | validate → verify → deploy-check → release |
  | `maintenance` | Dependencies/debt | audit → refactor → validate → changelog |
  | `api-evolution` | API changes | design → review → test → regression → changelog |
  | `full-cycle` | Complete SDLC | understand → research → design → plan → validate → verify → release |

- **ADDED: Wave Orchestrator** - Dependency-aware parallel execution
  - Topological sort for execution order
  - Teams in same wave run in parallel
  - Results from earlier waves inject as context to later waves
  - Built-in known team dependencies

#### Event System

- **ADDED: Comprehensive TeamEvent Types**
  ```typescript
  type TeamEvent =
    // Lifecycle
    | { type: "team_start"; teamName: string; agentCount: number }
    | { type: "team_end"; result: TeamResult }
    // Agent progress
    | { type: "agent_start"; agentName: string; index: number; total: number }
    | { type: "agent_event"; agentName: string; event: AgentEvent }
    | { type: "agent_end"; agentName: string; result: AgentResult }
    | { type: "agent_error"; agentName: string; error: string; willRetry: boolean }
    | { type: "agent_retry"; agentName: string; attempt: number; maxRetries: number }
    // Task tracking
    | { type: "agent_task_update"; agentName: string; taskInfo: AgentTaskInfo }
    // Merge phase
    | { type: "merge_start"; strategy: MergeStrategyType; findingCount: number }
    | { type: "merge_progress"; phase: string }
    | { type: "merge_event"; event: AgentEvent }
    | { type: "merge_end"; mergedCount: number; verifiedCount: number };
  ```

#### Finding System

- **ADDED: Structured Finding Format**
  - Standardized severity levels: `critical`, `high`, `medium`, `low`, `info`
  - 16 finding categories covering all domains
  - CWE/OWASP reference support
  - File/line location tracking
  - Confidence scores (0-1)
  - Verification status

- **ADDED: Finding Clustering Algorithm**
  - Similarity calculation based on file, line, category, title
  - O(n) optimization via file-based pre-grouping
  - Configurable similarity threshold (default: 0.6)

- **ADDED: Finding Ranking**
  - Severity-based scoring
  - Confidence boost
  - Verification status bonus

#### Integration Features

- **ADDED: Epsilon Task Tracking Integration**
  - Automatic task creation/update tracking
  - Real-time `agent_task_update` events
  - `AgentTaskInfo` with total/completed/active counts
  - `EPSILON_TASK_INSTRUCTIONS` constant for prompt injection

- **ADDED: Dynamic Template Loading**
  - Lazy-loaded templates by category
  - Runtime validation of template structure
  - Category-based organization: `understandTemplates`, `designTemplates`, etc.

#### Developer Experience

- **ADDED: Debug Logging** - `DEBUG_AGENTS=1` environment variable
  - Detailed execution tracing
  - API key validation logging (redacted)
  - Event flow visibility
  - Finding parsing diagnostics

- **ADDED: Comprehensive Type Exports**
  - All types exported from main entry point
  - Full TypeScript support with declaration files

---

## Usage Examples

### Basic Team Execution

```typescript
import { getModel } from "ai";
import { 
  Team, 
  createPreset,
  codeReviewerTemplate,
  securityAuditorTemplate 
} from "agents";

// Create agent presets
const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
const codeReviewer = createPreset(codeReviewerTemplate, model);
const securityAuditor = createPreset(securityAuditorTemplate, model);

// Configure team
const team = new Team({
  name: "review-team",
  agents: [codeReviewer, securityAuditor],
  tools: [/* read, grep, etc. */],
  strategy: "parallel",
  merge: { strategy: "union" },
});

// Execute with event streaming
for await (const event of team.run({ task: "Review src/" })) {
  if (event.type === "agent_end") {
    console.log(`${event.agentName}: ${event.result.findings.length} findings`);
  }
}
```

### Using Workflow Templates

```typescript
import { 
  getWorkflowTemplate, 
  getExecutionOrder,
  validateWorkflow 
} from "agents";

// Get pre-built workflow
const workflow = getWorkflowTemplate("feature");

// Validate it
const errors = validateWorkflow(workflow);
if (errors.length === 0) {
  const executionOrder = getExecutionOrder(workflow);
  console.log("Steps:", executionOrder);
}
```

### Verification Merge Strategy

```typescript
const team = new Team({
  name: "verified-review",
  agents: [codeReviewer, securityAuditor, perfAnalyzer],
  tools: [readTool, grepTool],
  merge: {
    strategy: "verification",
    mergeAgent: createPreset(mergeSynthesizerTemplate, model),
  },
});

const result = await team.execute({ task: "Analyze auth module" });
console.log(`Verified findings: ${result.findings.filter(f => f.verified).length}`);
```

---

## API Reference

### Team Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Unique team identifier |
| `description` | `string` | - | Human-readable description |
| `agents` | `AgentPreset[]` | required | Agent presets to execute |
| `tools` | `AgentTool[]` | required | Shared tools for all agents |
| `strategy` | `"parallel" \| "sequential"` | `"parallel"` | Execution strategy |
| `merge` | `MergeConfig` | required | Merge strategy configuration |
| `maxRetries` | `number` | `1` | Max retries per agent on failure |
| `continueOnError` | `boolean` | `true` | Continue if an agent fails |

### Finding Categories

| Category | Description |
|----------|-------------|
| `security` | Vulnerabilities, attack vectors, auth issues |
| `privacy` | PII handling, data protection, compliance |
| `bug` | Logic errors, incorrect behavior |
| `performance` | Bottlenecks, complexity, resource usage |
| `types` | Type safety, type design, type holes |
| `testing` | Test coverage, test quality, edge cases |
| `error-handling` | Error handling, resilience, fault tolerance |
| `concurrency` | Race conditions, deadlocks, thread safety |
| `architecture` | Structure, patterns, SOLID, modularity |
| `api` | API design, contracts, consistency |
| `docs` | Documentation, comments, examples |
| `accessibility` | WCAG, a11y, inclusive design |
| `i18n` | Internationalization, localization, Unicode |
| `dependencies` | Dependency health, vulnerabilities, hygiene |
| `style` | Code style, formatting |
| `maintainability` | General maintainability concerns |
| `other` | Uncategorized findings |

---

## Dependencies

- `agent` - Core agent loop and types
- `ai` - LLM model abstraction
- `@sinclair/typebox` - Runtime type validation

---

## Known Issues

- Workflow engine execution is defined but not yet integrated with Team class
- Custom merge strategy requires external implementation
- Wave orchestrator requires explicit team configs (no auto-discovery)

---

## Contributors

Initial implementation by the Phi team.
