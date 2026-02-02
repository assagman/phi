<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="phi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/nKXTsAcmbT"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/phi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/phi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>

# Phi Monorepo

> **Looking for the phi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/phi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/phi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/phi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/phi-mom](packages/mom)** | Slack bot that delegates messages to the phi coding agent |
| **[@mariozechner/phi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/phi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/phi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./phi-test.sh         # Run phi from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT