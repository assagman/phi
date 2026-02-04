# agents

Agent **preset templates** for Pi / Phi.

This package is intentionally **presets-only**: it provides model-agnostic system prompts and a small helper (`createPreset`) to bind a template to a concrete model. Multi-agent orchestration (teams, merge strategies, workflow engine) was removed from this repository.

## What you get

Exports:
- `PresetTemplate` (model-agnostic template)
- `createPreset(template, model, overrides?)`
- A library of `*Template` presets (e.g. `codeReviewerTemplate`, `securityAuditorTemplate`, `testStrategistTemplate`, …)
- Category maps like `validateTemplates`, `allTemplates`, etc.

`createPreset()` returns a plain object you can pass into your own runner:

```ts
{
  name: string;
  description: string;
  model: Model<Api>;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
}
```

## Usage

```ts
import { getModel } from "ai";
import { createPreset, codeReviewerTemplate } from "agents";

const model = getModel("anthropic", "claude-3-5-sonnet-20241022");

const reviewer = createPreset(codeReviewerTemplate, model, {
  // Optional prompt augmentation
  injectToolUsage: true,
  injectEpsilon: false,

  // Optional overrides
  thinkingLevel: "high",
  temperature: 0.3,
});

// reviewer.systemPrompt is ready to be used as a system prompt
```

## Notes

- `injectToolUsage` / `injectEpsilon` only **append instructions** to the prompt. They do not register tools by themselves.
- Some templates (e.g. `leadAnalyzerTemplate`, `workflowOrchestratorTemplate`) remain useful as *single-agent* “meta” prompts, even though this repo no longer ships a built-in multi-agent harness.
