# Migration Guide

## Status: presets-only

Multi-agent orchestration (teams, merge strategies, workflow engine, wave orchestrator) was removed from this repository. The `agents` package is now a **presets-only** library.

If you previously used APIs like `Team`, `createTeam`, merge executors, workflow templates, or team event streams:

- Those modules no longer exist.
- Pin an older commit/tag if you need the old orchestration code.
- Or implement orchestration in your own project using `packages/agent` and the preset templates from this package.

## What to migrate to

### 1) Preset templates

Replace custom "system prompt strings" with structured templates:

```ts
import { reviewerTemplate } from "agents";
```

### 2) createPreset()

Bind a template to a concrete model:

```ts
import { getModel } from "ai";
import { createPreset, reviewerTemplate } from "agents";

const model = getModel("openai", "gpt-4o-mini");
const preset = createPreset(reviewerTemplate, model);
```

### 3) Optional prompt augmentation

If your runner exposes tools like `read`, `bash`, `delta_*`, `epsilon_*`, you can append standardized instructions:

```ts
const preset = createPreset(reviewerTemplate, model, {
  injectToolUsage: true,
  injectEpsilon: true,
});
```

## Breaking changes

### `codeReviewerTemplate` removed

The `codeReviewerTemplate` export was replaced by `reviewerTemplate`. The new reviewer is git-diff-aware and produces file:line referenced findings grouped by severity (Critical / Warnings / Suggestions).

```diff
- import { codeReviewerTemplate } from "agents";
+ import { reviewerTemplate } from "agents";
```
