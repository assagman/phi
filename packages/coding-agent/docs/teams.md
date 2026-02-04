# Team Configuration

Pi supports multi-agent team orchestration via the `/team` command. Teams run multiple specialized agents in parallel and merge their findings.

## Quick Start

```bash
# Run a built-in team
/team code-review

# Show all available teams
/team help

# Show team details
/team help security-audit

# List available presets
/team presets
```

## Built-in Teams

### UNDERSTAND - Requirements & Research

| Team | Agents | Description |
|------|--------|-------------|
| `understand` | requirements-elicitor, context-analyzer, scope-guardian | Full requirements analysis |
| `research` | research-synthesizer, context-analyzer | Technology research & best practices |
| `kickoff` | requirements-elicitor, scope-guardian, solution-architect | Quick project kickoff |

### DESIGN - Architecture & Planning

| Team | Agents | Description |
|------|--------|-------------|
| `design` | solution-architect, api-contract-designer, data-modeler, system-integrator | Full design suite |
| `deep-design` | context-analyzer, solution-architect, api-contract-designer, data-modeler | Deep design with context |

### IMPLEMENT - Execution Planning

| Team | Agents | Description |
|------|--------|-------------|
| `plan` | task-orchestrator, implementation-strategist | Implementation planning |
| `implement` | code-generator, refactoring-advisor | Implementation guidance |
| `refactor` | context-analyzer, refactoring-advisor, test-coverage-auditor | Refactoring analysis |

### VALIDATE - Code Review & Audit

| Team | Agents | Description |
|------|--------|-------------|
| `code-review` | code-reviewer, security-auditor, perf-analyzer | Comprehensive code review |
| `full-audit` | security, privacy, types, architecture, errors | Full-spectrum audit |
| `security-audit` | security-auditor, privacy-auditor | Security & privacy analysis |
| `security-deep` | security-auditor | Security-only deep dive |
| `performance` | perf-analyzer, concurrency-auditor, error-handling-auditor | Performance & reliability |
| `quality` | type-safety, test-coverage, error-handling | Code quality |
| `types` | type-safety-auditor | Type safety analysis |
| `testing` | test-coverage-auditor | Test coverage analysis |
| `architecture` | architecture-auditor, api-design-auditor, dependency-auditor | Architecture & design |
| `api-review` | api-design-auditor | API design review |
| `frontend` | accessibility, i18n, perf-analyzer | Frontend review |
| `accessibility` | accessibility-auditor | WCAG audit |
| `docs` | docs-auditor | Documentation review |
| `dependencies` | dependency-auditor, security-auditor | Dependency health |
| `quality-gate` | code-reviewer, security-auditor, type-safety-auditor, test-coverage-auditor | Quality checkpoint |

### VERIFY - Testing

| Team | Agents | Description |
|------|--------|-------------|
| `verify` | test-strategist, test-case-designer, acceptance-verifier, regression-analyst | Full verification |
| `test-planning` | test-strategist, test-case-designer | Test planning |
| `acceptance` | acceptance-verifier, regression-analyst | Acceptance & regression |

### DELIVER - Release

| Team | Agents | Description |
|------|--------|-------------|
| `deliver` | changelog-generator, deployment-validator, release-coordinator | Full delivery |
| `pre-release` | security-auditor, test-coverage, acceptance-verifier, deployment-validator | Pre-release checklist |
| `release-prep` | changelog-generator, deployment-validator | Release preparation |

### CROSS-PHASE Workflows

| Team | Agents | Description |
|------|--------|-------------|
| `before-coding` | requirements-elicitor, scope-guardian, solution-architect, task-orchestrator | Pre-implementation |
| `after-coding` | code-reviewer, security-auditor, acceptance-verifier, changelog-generator | Post-implementation |
| `quick-fix` | context-analyzer, code-reviewer, test-coverage-auditor | Quick bug fix |
| `feature` | requirements-elicitor, solution-architect, code-reviewer, test-strategist | Feature development |
| `greenfield` | requirements-elicitor, research-synthesizer, solution-architect, api-contract-designer | New project |
| `maintenance` | dependency-auditor, refactoring-advisor, test-coverage-auditor, changelog-generator | Maintenance |
| `full-cycle` | One agent from each SDLC phase | Full SDLC |

## Available Agent Presets

### UNDERSTAND - Requirements & Research

| Preset | Description |
|--------|-------------|
| `requirements-elicitor` | Extract requirements, identify ambiguities, generate acceptance criteria |
| `context-analyzer` | Analyze existing codebase context, patterns, constraints |
| `stakeholder-mapper` | Identify stakeholders, map priorities, analyze trade-offs (not in default teams) |
| `scope-guardian` | Define scope boundaries, detect scope creep, protect focus |
| `research-synthesizer` | Research technologies, evaluate libraries, find best practices |

### DESIGN - Architecture & Planning

| Preset | Description |
|--------|-------------|
| `solution-architect` | High-level design, component breakdown, integration strategy |
| `api-contract-designer` | Design API interfaces, contracts, schemas, versioning |
| `data-modeler` | Database schemas, data structures, migration strategies |
| `system-integrator` | Plan integrations, service dependencies, third-party coordination |

### IMPLEMENT - Execution Planning

| Preset | Description |
|--------|-------------|
| `task-orchestrator` | Task decomposition, dependency mapping, effort estimation |
| `implementation-strategist` | Implementation approach, patterns, migration planning |
| `code-generator` | Generate code from specs, scaffolds, boilerplate |
| `refactoring-advisor` | Identify refactoring opportunities, code smells, improvements |

### VALIDATE - Code Review & Audit

| Preset | Description |
|--------|-------------|
| `code-reviewer` | General code quality, bugs, logic errors, maintainability |
| `security-auditor` | Security vulnerabilities, OWASP Top 10, CWE, attack surface |
| `perf-analyzer` | Performance issues, complexity, memory, I/O optimization |
| `privacy-auditor` | PII handling, GDPR/CCPA compliance, data protection |
| `type-safety-auditor` | Type safety, type holes, unsafe casts, generics |
| `test-coverage-auditor` | Test coverage gaps, edge cases, test quality |
| `error-handling-auditor` | Error handling, resilience, fault tolerance, retries |
| `concurrency-auditor` | Race conditions, deadlocks, thread safety, async patterns |
| `architecture-auditor` | Architecture, SOLID, patterns, modularity, dependencies |
| `api-design-auditor` | API design quality, REST/GraphQL/gRPC, contracts |
| `docs-auditor` | Documentation completeness, accuracy, examples |
| `accessibility-auditor` | Accessibility, WCAG compliance, a11y best practices |
| `i18n-auditor` | Internationalization, Unicode, locale handling, RTL |
| `dependency-auditor` | Dependency health, CVEs, outdated packages, bloat |

### VERIFY - Testing

| Preset | Description |
|--------|-------------|
| `test-strategist` | Test strategy, coverage plans, test pyramid design |
| `test-case-designer` | Generate test cases, edge cases, test scenarios |
| `acceptance-verifier` | Validate against acceptance criteria, requirement traceability |
| `regression-analyst` | Change impact analysis, regression risks, blast radius |

### DELIVER - Release

| Preset | Description |
|--------|-------------|
| `changelog-generator` | Release notes, changelogs, migration guides |
| `deployment-validator` | Deployment readiness, configuration validation |
| `release-coordinator` | Release orchestration, gate validation, sign-offs |

### ORCHESTRATION - Meta-agents

| Preset | Description |
|--------|-------------|
| `workflow-orchestrator` | Plan and coordinate dynamic agent workflows |
| `lead-analyzer` | Analyze project context, select appropriate teams |
| `merge-synthesizer` | Merge and verify findings from multiple agents |

## Custom Teams

Define custom teams in YAML config files:

| Location | Scope |
|----------|-------|
| `.phi/config.yaml` | Project-specific (overrides user config) |
| `~/.phi/config.yaml` | User global |

### Config Schema

```yaml
teams:
  my-review:
    description: "Custom review team"
    strategy: verification  # verification | union | intersection
    agents:
      # Use a built-in preset
      - preset: security-auditor
        model: anthropic:claude-3-5-sonnet-20241022:medium

      # Full custom agent definition
      - name: custom-reviewer
        model: openai:gpt-4o:high
        prompt: |
          You are a code reviewer focusing on error handling.
        temperature: 0.3
        thinking: medium

      # Preset with appended instructions
      - preset: code-reviewer
        appendPrompt: true
        prompt: |
          Additionally focus on thread safety.
```

### Model String Format

```
provider:model-id[:thinking]
```

| Component | Required | Values |
|-----------|----------|--------|
| provider | Yes | anthropic, openai, google, etc. |
| model-id | Yes | Model identifier |
| thinking | No | off, low, medium, high |

### Merge Strategies

| Strategy | Description |
|----------|-------------|
| `verification` | Merge agent verifies findings against actual code |
| `union` | All findings from all agents |
| `intersection` | Only findings agreed upon by multiple agents |

## Workflow Templates

Teams can be combined for common workflows:

| Workflow | Teams | Use Case |
|----------|-------|----------|
| Quick Fix | `quick-fix` | Small bug fixes |
| Feature | `before-coding` → `implement` → `after-coding` | New feature development |
| Greenfield | `greenfield` → `design` → `implement` → `full-audit` | New project |
| Refactor | `refactor` → `quality` | Code improvement |
| Security Hardening | `security-audit` → `implementation-strategist` | Security focus |
| Pre-Release | `pre-release` → `deliver` | Release preparation |
| Maintenance | `maintenance` | Dependency updates, tech debt |
| Full Cycle | `full-cycle` | Complete SDLC coverage |

## Agent Categories Summary

| Category | Count | Focus |
|----------|-------|-------|
| UNDERSTAND | 5 | Requirements, context, research |
| DESIGN | 4 | Architecture, APIs, data modeling |
| IMPLEMENT | 4 | Task planning, code generation |
| VALIDATE | 14 | Code review, security, quality audits |
| VERIFY | 4 | Testing strategy, acceptance |
| DELIVER | 3 | Release, deployment, changelog |
| ORCHESTRATION | 3 | Meta-agents for coordination |
| **Total** | **37** | |

## Finding Categories

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
