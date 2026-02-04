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

### Comprehensive Reviews

| Team | Agents | Description |
|------|--------|-------------|
| `code-review` | code-reviewer, security-auditor, perf-analyzer | Comprehensive code review |
| `full-audit` | security, privacy, types, architecture, errors | Full-spectrum audit |

### Security & Privacy

| Team | Agents | Description |
|------|--------|-------------|
| `security-audit` | security-auditor, privacy-auditor | Deep security and privacy analysis |
| `security-deep` | security-auditor | Security-only deep dive (OWASP, CWE) |

### Performance & Reliability

| Team | Agents | Description |
|------|--------|-------------|
| `performance` | perf-analyzer, concurrency-auditor, error-handling-auditor | Performance, concurrency, resilience |

### Code Quality

| Team | Agents | Description |
|------|--------|-------------|
| `quality` | type-safety, test-coverage, error-handling | Code quality: types, testing, errors |
| `types` | type-safety-auditor | Type safety analysis |
| `testing` | test-coverage-auditor | Test coverage and quality |

### Architecture & Design

| Team | Agents | Description |
|------|--------|-------------|
| `architecture` | architecture, api-design, dependency | Architecture, API, dependencies |
| `api-review` | api-design-auditor | API design review |

### Frontend/UI

| Team | Agents | Description |
|------|--------|-------------|
| `frontend` | accessibility, i18n, perf-analyzer | Frontend: a11y, i18n, performance |
| `accessibility` | accessibility-auditor | Accessibility (WCAG) audit |

### Documentation & Dependencies

| Team | Agents | Description |
|------|--------|-------------|
| `docs` | docs-auditor | Documentation completeness |
| `dependencies` | dependency-auditor, security-auditor | Dependency health and security |

### Pre-Release

| Team | Agents | Description |
|------|--------|-------------|
| `pre-release` | security, testing, docs, dependencies | Pre-release checklist |

## Available Presets

### Core Reviewers

| Preset | Category | Description |
|--------|----------|-------------|
| `code-reviewer` | General | Code quality, bugs, logic errors, maintainability |
| `security-auditor` | Security | OWASP Top 10, CWE, attack surface, vulnerabilities |
| `perf-analyzer` | Performance | Bottlenecks, complexity, memory, I/O optimization |

### Security & Privacy

| Preset | Category | Description |
|--------|----------|-------------|
| `privacy-auditor` | Privacy | PII handling, GDPR/CCPA compliance, data protection |

### Code Quality

| Preset | Category | Description |
|--------|----------|-------------|
| `type-safety-auditor` | Types | Type safety, type holes, unsafe casts, generics |
| `test-coverage-auditor` | Testing | Test coverage gaps, edge cases, test quality |
| `error-handling-auditor` | Resilience | Error handling, fault tolerance, retries, recovery |
| `concurrency-auditor` | Concurrency | Race conditions, deadlocks, thread safety, async |

### Design

| Preset | Category | Description |
|--------|----------|-------------|
| `architecture-auditor` | Architecture | SOLID, patterns, modularity, layer violations |
| `api-design-auditor` | API | REST/GraphQL/gRPC design, contracts, versioning |

### Content & Ecosystem

| Preset | Category | Description |
|--------|----------|-------------|
| `docs-auditor` | Docs | Documentation completeness, accuracy, examples |
| `accessibility-auditor` | a11y | WCAG compliance, ARIA, keyboard navigation |
| `i18n-auditor` | i18n | Internationalization, Unicode, locale handling |
| `dependency-auditor` | Dependencies | CVEs, outdated packages, dependency hygiene |

### Internal

| Preset | Category | Description |
|--------|----------|-------------|
| `merge-synthesizer` | Internal | Combines and verifies findings (used internally) |

## Custom Teams

Define custom teams in YAML config files:

| Location | Scope |
|----------|-------|
| `.phi/teams.yaml` | Project-specific (overrides user config) |
| `~/.phi/teams.yaml` | User global |

### Config Schema

```yaml
teams:
  # Team name (used in /team <name>)
  my-review:
    # Optional description
    description: "Custom review team"
    
    # Merge strategy: verification | union | intersection
    # Default: verification (if multiple agents), union (if single)
    strategy: verification
    
    # List of agents (at least one required)
    agents:
      # Use a built-in preset
      - preset: security-auditor
        # Optional: override the model
        model: anthropic:claude-3-5-sonnet-20241022:medium
      
      # Full custom agent definition
      - name: custom-reviewer
        model: openai:gpt-4o:high
        prompt: |
          You are a code reviewer focusing on error handling.
          Report findings in the standard format.
        temperature: 0.3
        thinking: medium
        
      # Preset with appended instructions
      - preset: code-reviewer
        appendPrompt: true
        prompt: |
          Additionally focus on:
          - Thread safety
          - Resource cleanup
```

### Model String Format

Models are specified as `provider:model-id[:thinking]`:

```
anthropic:claude-3-5-sonnet-20241022
openai:gpt-4o:medium
google:gemini-2.0-flash-exp:high
```

| Component | Required | Values |
|-----------|----------|--------|
| provider | Yes | anthropic, openai, google, etc. |
| model-id | Yes | Model identifier from provider |
| thinking | No | off, low, medium, high |

If no model is specified, the agent uses the current session model.

### Agent Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Agent name (required for custom, optional for preset) |
| `preset` | string | Built-in preset to use as base |
| `model` | string | Model string (provider:model-id[:thinking]) |
| `prompt` | string | System prompt (replaces or appends) |
| `appendPrompt` | boolean | Append prompt to preset instead of replacing |
| `temperature` | number | 0-1, controls randomness |
| `thinking` | string | off, low, medium, high |
| `tools` | string[] | Allowed tools (reserved for future use) |

### Merge Strategies

| Strategy | Description |
|----------|-------------|
| `verification` | Merge agent verifies findings against actual code |
| `union` | All findings from all agents |
| `intersection` | Only findings agreed upon by multiple agents |

## Examples

### Multi-Model Security Review

```yaml
teams:
  security-multi:
    description: "Security review with multiple models for coverage"
    strategy: verification
    agents:
      - preset: security-auditor
        model: anthropic:claude-3-5-sonnet-20241022:high
      - preset: security-auditor
        name: security-openai
        model: openai:gpt-4o:high
      - preset: privacy-auditor
        model: anthropic:claude-3-5-sonnet-20241022:medium
```

### Full Stack Review

```yaml
teams:
  fullstack:
    description: "Full stack review: backend + frontend"
    strategy: verification
    agents:
      - preset: security-auditor
      - preset: api-design-auditor
      - preset: accessibility-auditor
      - preset: perf-analyzer
```

### Pre-Commit Quality Gate

```yaml
teams:
  pre-commit:
    description: "Quick quality check before commit"
    strategy: union
    agents:
      - preset: type-safety-auditor
        model: anthropic:claude-3-5-haiku-20241022
      - preset: security-auditor
        model: anthropic:claude-3-5-haiku-20241022
```

### Domain-Specific Expert

```yaml
teams:
  fintech-review:
    description: "Financial services code review"
    strategy: verification
    agents:
      - preset: security-auditor
        appendPrompt: true
        prompt: |
          Pay special attention to:
          - PCI-DSS compliance
          - Financial data encryption
          - Transaction integrity
          - Audit logging
      - preset: privacy-auditor
        appendPrompt: true
        prompt: |
          Focus on financial privacy:
          - Account number masking
          - Transaction privacy
          - Regulatory compliance (SOX, GLBA)
      - preset: error-handling-auditor
        appendPrompt: true
        prompt: |
          Financial error handling:
          - Transaction rollback
          - Idempotency
          - Reconciliation
```

### Microservices Architecture Review

```yaml
teams:
  microservices:
    description: "Microservices architecture review"
    strategy: verification
    agents:
      - preset: architecture-auditor
        appendPrompt: true
        prompt: |
          Focus on microservices patterns:
          - Service boundaries
          - API contracts
          - Event-driven communication
          - Data consistency
      - preset: api-design-auditor
      - preset: error-handling-auditor
        appendPrompt: true
        prompt: |
          Focus on distributed systems:
          - Circuit breakers
          - Retries with backoff
          - Timeout handling
          - Fallback strategies
      - preset: concurrency-auditor
```

## Finding Categories

Agents report findings in these categories:

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

## Error Handling

- Invalid YAML syntax: Parsing fails, no teams loaded from that file
- Unknown preset: Agent skipped, error logged
- Invalid model format: Agent skipped, error reported
- Model not in registry: Team validation fails at runtime
- Empty agents array: Team skipped, error reported

Errors are shown via `/team help` and as warnings when running `/team`.
