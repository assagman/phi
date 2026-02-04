# @phi/agents

Multi-agent orchestration for code review and analysis.

## Overview

The `agents` package provides:
- **Agent Presets**: Reusable agent configurations (code-reviewer, security-auditor, perf-analyzer)
- **Team Orchestration**: Run multiple agents in parallel or sequentially
- **Merge Strategies**: Combine findings from multiple agents (union, intersection, verification)
- **Event Streaming**: Real-time progress updates during execution

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Team                                 │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Preset A   │  │   Preset B   │  │   Preset C   │       │
│  │  (Reviewer)  │  │  (Security)  │  │   (Perf)     │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │                │
│         ▼                 ▼                 ▼                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Agent Loop (packages/agent)              │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                 │                 │                │
│         └────────────────┼─────────────────┘                │
│                          ▼                                   │
│              ┌───────────────────────┐                       │
│              │    Merge Strategy     │                       │
│              │  • Union              │                       │
│              │  • Intersection       │                       │
│              │  • Verification       │                       │
│              └───────────────────────┘                       │
│                          │                                   │
│                          ▼                                   │
│              ┌───────────────────────┐                       │
│              │     TeamResult        │                       │
│              │  • findings           │                       │
│              │  • clusters           │                       │
│              │  • summary            │                       │
│              └───────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

```typescript
import { getModel } from "ai";
import { 
  Team, 
  createPreset,
  codeReviewerTemplate,
  securityAuditorTemplate 
} from "agents";

// 1. Create agent presets
const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
const codeReviewer = createPreset(codeReviewerTemplate, model);
const securityAuditor = createPreset(securityAuditorTemplate, model);

// 2. Configure the team
const team = new Team({
  name: "review-team",
  agents: [codeReviewer, securityAuditor],
  tools: [/* read, grep, etc. */],
  strategy: "parallel",
  merge: {
    strategy: "union",
  },
});

// 3. Execute and handle events
for await (const event of team.run()) {
  switch (event.type) {
    case "team_start":
      console.log(`Starting ${event.agentCount} agents`);
      break;
    case "agent_end":
      console.log(`${event.agentName}: ${event.result.findings.length} findings`);
      break;
    case "team_end":
      console.log(`Total findings: ${event.result.findings.length}`);
      break;
  }
}
```

## Built-in Presets

| Preset | Description | Focus Areas |
|--------|-------------|-------------|
| `codeReviewerTemplate` | General code quality | Bugs, logic errors, maintainability |
| `securityAuditorTemplate` | Security analysis | OWASP Top 10, CWE references |
| `perfAnalyzerTemplate` | Performance review | Complexity, memory, I/O |
| `mergeSynthesizerTemplate` | Finding verification | Cross-check findings against code |

## Merge Strategies

### Union
All findings from all agents are included. Best for comprehensive coverage.

### Intersection  
Only findings reported by 2+ agents are included. Best for high-confidence results.

### Verification
Findings are:
1. Clustered by similarity (file+line+title)
2. Verified against actual code by a merge agent
3. Ranked by severity and agreement count

## Team Events

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
  // Merge progress
  | { type: "merge_start"; strategy: MergeStrategyType; findingCount: number }
  | { type: "merge_progress"; phase: "parsing" | "clustering" | "verifying" | "ranking" | "synthesizing" }
  | { type: "merge_event"; event: AgentEvent }
  | { type: "merge_end"; mergedCount: number; verifiedCount: number };
```

## Finding Format

Agents parse findings from structured markdown:

```markdown
### Finding: Buffer Overflow Risk
**Severity:** high
**Category:** security
**File:** src/parser.ts
**Line:** 42-50
**Confidence:** 0.9
**CWE:** CWE-120

**Description:**
The buffer allocation doesn't check input size...

**Suggestion:**
Add bounds checking before allocation...

```typescript
if (size > MAX_BUFFER_SIZE) throw new Error("Size exceeds limit");
```
```

## API Reference

### Team Class

```typescript
class Team {
  constructor(config: TeamConfig)
  
  // Execute and stream events
  run(options?: TeamRunOptions): EventStream<TeamEvent, TeamResult>
  
  // Execute and await result
  execute(options?: TeamRunOptions): Promise<TeamResult>
  
  // Abort execution
  abort(): void
}
```

### TeamConfig

```typescript
interface TeamConfig {
  name: string;
  description?: string;
  agents: AgentPreset[];
  tools: AgentTool[];
  strategy?: "parallel" | "sequential";
  merge: MergeConfig;
  maxRetries?: number;
  continueOnError?: boolean;
}
```

### createPreset

```typescript
function createPreset(
  template: PresetTemplate,
  model: Model<any>,
  overrides?: Partial<PresetTemplate>
): AgentPreset
```

## Contributing

See the main monorepo contributing guidelines.
