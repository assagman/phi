# Teams (Removed)

Pi previously shipped multi-agent “team” orchestration (e.g. `/team`, `coop`, workflow templates) that ran multiple specialized agents and merged their outputs.

That harness has been removed as part of simplifying the architecture. The current repo supports:

- **Single-agent** interactive TUI (`packages/coding-agent`)
- Built-in tools (delta/epsilon/sigma/handoff) and extension tools
- **Agent preset templates** exposed by `@phi/agents` (`packages/agents`) for building consistent system prompts

## Agent Presets (what to use instead)

`@phi/agents` is now a **presets-only** library. It exports:

- `*Template` objects (e.g. `codeReviewerTemplate`, `securityAuditorTemplate`, …)
- `createPreset(template, model, overrides?)` to bind a template to a concrete model

See:
- `packages/agents/README.md` (preset usage)
- `packages/coding-agent/docs/sdk.md` (embedding the coding agent)

## Multi-agent orchestration

If you need multi-agent execution, build it externally (outside this repo) using `packages/agent` + the preset templates from `@phi/agents`.
