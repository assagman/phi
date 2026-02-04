# Migration Guide

## Migrating to @phi/agents

This guide helps you adopt the `@phi/agents` package for multi-agent orchestration.

---

## Prerequisites

Before starting, ensure you have:

- [ ] Node.js 20+ installed
- [ ] The `@phi/agent` package for core agent loop
- [ ] The `@phi/ai` package for LLM model abstraction
- [ ] API keys for your chosen LLM provider(s)

---

## Installation

```bash
# Using npm
npm install agents

# Using bun
bun add agents
```

---

## Quick Start Migration

### Step 1: Import Required Components

```typescript
import { getModel } from "ai";
import { 
  // Preset system
  createPreset,
  codeReviewerTemplate,
  securityAuditorTemplate,
  
  // Team orchestration
  Team,
  
  // Types (optional but recommended)
  type TeamConfig,
  type TeamEvent,
  type TeamResult,
  type Finding,
} from "agents";
```

### Step 2: Create Your First Team

**Before:** Manual sequential agent execution
```typescript
// Old approach - manual coordination
const result1 = await runAgent(reviewer, task);
const result2 = await runAgent(security, task);
const combined = [...result1, ...result2]; // Manual merge
```

**After:** Team orchestration
```typescript
// New approach - automated orchestration
const model = getModel("anthropic", "claude-3-5-sonnet-20241022");

const team = new Team({
  name: "review-team",
  agents: [
    createPreset(codeReviewerTemplate, model),
    createPreset(securityAuditorTemplate, model),
  ],
  tools: [readTool, grepTool],
  strategy: "parallel",  // or "sequential"
  merge: { strategy: "union" },
});

const result = await team.execute({ task: "Review the authentication module" });
```

### Step 3: Handle Events for UI Progress

```typescript
// Stream events for real-time UI updates
for await (const event of team.run({ task })) {
  switch (event.type) {
    case "team_start":
      console.log(`Starting ${event.agentCount} agents...`);
      break;
      
    case "agent_start":
      console.log(`Agent ${event.index + 1}/${event.total}: ${event.agentName}`);
      break;
      
    case "agent_end":
      console.log(`${event.agentName}: ${event.result.findings.length} findings`);
      break;
      
    case "merge_progress":
      console.log(`Merge phase: ${event.phase}`);
      break;
      
    case "team_end":
      console.log(`Total findings: ${event.result.findings.length}`);
      break;
  }
}
```

---

## Migration Patterns

### Pattern 1: Single Agent → Team

**Before:**
```typescript
const agent = createAgent(reviewerPrompt, model);
const result = await agent.run(task, tools);
```

**After:**
```typescript
const team = new Team({
  name: "single-reviewer",
  agents: [createPreset(codeReviewerTemplate, model)],
  tools,
  merge: { strategy: "union" },
});
const result = await team.execute({ task });
```

### Pattern 2: Custom Prompts → Preset Templates

**Before:**
```typescript
const customPrompt = `You are a code reviewer...`;
const agent = createAgent(customPrompt, model);
```

**After:**
```typescript
// Option A: Use built-in template
const reviewer = createPreset(codeReviewerTemplate, model);

// Option B: Create custom template
const customTemplate: PresetTemplate = {
  name: "my-reviewer",
  description: "Custom code reviewer",
  systemPrompt: `You are a code reviewer...`,
  thinkingLevel: "medium",
  temperature: 0.3,
};
const reviewer = createPreset(customTemplate, model);
```

### Pattern 3: Manual Merging → Merge Strategies

**Before:**
```typescript
const allFindings = [];
for (const result of agentResults) {
  allFindings.push(...result.findings);
}
// Manual deduplication...
```

**After:**
```typescript
const team = new Team({
  // ...
  merge: {
    // Choose strategy based on needs:
    strategy: "union",        // All findings
    // strategy: "intersection",  // Only agreed-upon findings  
    // strategy: "verification",  // AI-verified findings
  },
});
```

### Pattern 4: Adding Epsilon Task Tracking

To enable task progress tracking in the UI:

```typescript
const reviewer = createPreset(codeReviewerTemplate, model, {
  injectEpsilon: true,  // Adds task tracking instructions
});
```

Then handle task events:
```typescript
for await (const event of team.run({ task })) {
  if (event.type === "agent_task_update") {
    const { agentName, taskInfo } = event;
    console.log(`${agentName}: ${taskInfo.completed}/${taskInfo.total} tasks`);
    if (taskInfo.activeTaskTitle) {
      console.log(`  Current: ${taskInfo.activeTaskTitle}`);
    }
  }
}
```

---

## Configuration Reference

### Team Configuration Options

| Old Approach | New Configuration | Notes |
|--------------|-------------------|-------|
| Manual parallel execution | `strategy: "parallel"` | Default, fastest |
| Manual sequential execution | `strategy: "sequential"` | For dependent agents |
| Manual retry logic | `maxRetries: 2` | Automatic retries |
| Manual error handling | `continueOnError: true` | Resilient execution |
| Manual result merging | `merge: { strategy: "union" }` | Automatic merging |

### Finding Format Migration

If you have existing finding parsers, adapt them to the new format:

```typescript
interface Finding {
  id: string;           // Unique ID: "${agentName}-${index}"
  agentName: string;    // Source agent
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: FindingCategory;  // 16 supported categories
  file?: string;        // File path
  line?: number | [number, number];  // Line or range
  title: string;        // Short summary
  description: string;  // Detailed explanation
  suggestion?: string;  // Recommended fix
  codeSnippet?: string; // Relevant code
  confidence?: number;  // 0-1 confidence score
  verified?: boolean;   // Verification status
  references?: string[];  // CWE, OWASP refs
}
```

---

## Common Migration Issues

### Issue: API Key Not Found

**Symptom:** `Error: No API key for provider anthropic`

**Solution:**
```typescript
// Provide API key resolver
const result = await team.execute({
  task,
  getApiKey: async (provider) => {
    if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
    if (provider === "openai") return process.env.OPENAI_API_KEY;
  },
});
```

### Issue: Findings Not Parsing

**Symptom:** Empty findings array despite agent output

**Solution:** Ensure agent output follows the structured format:
```markdown
### Finding: Title Here
**Severity:** high
**Category:** security
**File:** path/to/file.ts
**Line:** 42

**Description:**
Your description here.
```

### Issue: Team Execution Hangs

**Symptom:** Team never completes

**Solution:**
```typescript
// Add timeout via AbortSignal
const controller = new AbortController();
setTimeout(() => controller.abort(), 60000); // 60s timeout

const result = await team.execute({
  task,
  signal: controller.signal,
});
```

### Issue: Memory Usage High

**Symptom:** Process memory grows during execution

**Solution:**
- Use streaming (`team.run()`) instead of buffered (`team.execute()`)
- Process events incrementally instead of collecting all
- Limit concurrent agents with `strategy: "sequential"`

---

## Verification Checklist

After migration, verify:

- [ ] Team executes without errors
- [ ] All agents produce findings
- [ ] Findings are properly merged
- [ ] Events stream to UI correctly
- [ ] Task progress updates display
- [ ] Abort/cancellation works
- [ ] Error handling is graceful
- [ ] Token usage is tracked

---

## Getting Help

If you encounter issues:

1. Enable debug logging: `DEBUG_AGENTS=1`
2. Check the [README](./README.md) for examples
3. Review the [CHANGELOG](./CHANGELOG.md) for known issues
4. File an issue with reproduction steps

---

## Next Steps

After basic migration:

1. **Explore more presets** - 35+ specialized agents available
2. **Try verification merge** - AI-powered finding validation
3. **Use workflow templates** - Pre-built SDLC workflows
4. **Customize presets** - Create domain-specific agents
5. **Add wave orchestration** - Dependency-aware parallel execution
