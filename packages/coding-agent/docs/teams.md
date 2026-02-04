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

| Team | Agents | Description |
|------|--------|-------------|
| `code-review` | code-reviewer, security-auditor, perf-analyzer | Comprehensive code review |
| `security-audit` | security-auditor | Deep security analysis |
| `performance` | perf-analyzer | Performance optimization |

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

### Available Presets

| Preset | Description |
|--------|-------------|
| `code-reviewer` | General code quality, bugs, logic errors |
| `security-auditor` | Security vulnerabilities, OWASP, CWE |
| `perf-analyzer` | Performance issues, complexity, optimization |
| `merge-synthesizer` | Combines findings (used internally) |

### Merge Strategies

| Strategy | Description |
|----------|-------------|
| `verification` | Merge agent verifies findings against actual code |
| `union` | All findings from all agents |
| `intersection` | Only findings agreed upon by multiple agents |

## Examples

### Security-Focused Review

```yaml
teams:
  security-deep:
    description: "Deep security review with multiple perspectives"
    strategy: verification
    agents:
      - preset: security-auditor
        model: anthropic:claude-3-5-sonnet-20241022:high
      - preset: security-auditor
        name: security-auditor-openai
        model: openai:gpt-4o:high
```

### Quick Code Check

```yaml
teams:
  quick-check:
    description: "Fast code quality check"
    strategy: union
    agents:
      - preset: code-reviewer
        model: anthropic:claude-3-5-haiku-20241022
```

### Custom Domain Expert

```yaml
teams:
  api-review:
    description: "API design review"
    agents:
      - name: api-expert
        model: anthropic:claude-3-5-sonnet-20241022:medium
        prompt: |
          You are an API design expert. Review code for:
          - RESTful design principles
          - Consistent naming conventions
          - Proper HTTP status codes
          - Request/response validation
          - API versioning practices
          
          Report findings in the standard format with severity levels.
```

## Error Handling

- Invalid YAML syntax: Parsing fails, no teams loaded from that file
- Unknown preset: Agent skipped, error logged
- Invalid model format: Agent skipped, error reported
- Model not in registry: Team validation fails at runtime
- Empty agents array: Team skipped, error reported

Errors are shown via `/team help` and as warnings when running `/team`.
