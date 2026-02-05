# agents

Agent **preset templates** for Pi.

## Exports

- `PresetTemplate` — model-agnostic template type
- `createPreset(template, model, overrides?)` — bind template to model
- Template exports: `*Template` (e.g. `reviewerTemplate`, `explorerTemplate`, `plannerTemplate`)

## Usage

```ts
import { getModel } from "ai";
import { createPreset, reviewerTemplate } from "agents";

const model = getModel("anthropic", "claude-sonnet-4-20250514");

const reviewer = createPreset(reviewerTemplate, model, {
  injectToolUsage: true,  // append tool usage instructions
  injectEpsilon: false,   // append task tracking instructions
  thinkingLevel: "high",
  temperature: 0.2,
});

// reviewer.systemPrompt ready for use
```
