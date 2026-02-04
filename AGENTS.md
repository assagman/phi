# Development Rules

## Package Manager
- **Use `bun` exclusively** — never use npm, npx, yarn, or pnpm
- Install: `bun install`
- Run scripts: `bun run <script>`
- Execute packages: `bunx <package>`
- Run tests: `bun test`

## Project Structure

```
phi/
├── packages/
│   ├── ai/                    # LLM provider abstraction layer
│   │   ├── src/
│   │   │   ├── index.ts       # Public exports
│   │   │   ├── types.ts       # Api, KnownProvider, Model types
│   │   │   ├── stream.ts      # Unified streaming interface
│   │   │   ├── models.ts      # Model utilities
│   │   │   ├── models.generated.ts  # Auto-generated model definitions
│   │   │   ├── providers/     # Provider implementations
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── amazon-bedrock.ts
│   │   │   │   ├── google.ts, google-vertex.ts, google-gemini-cli.ts
│   │   │   │   ├── openai-completions.ts, openai-responses.ts
│   │   │   │   └── transform-messages.ts  # Shared message transforms
│   │   │   └── utils/         # Token counting, helpers
│   │   ├── scripts/           # generate-models.ts
│   │   └── test/
│   │
│   ├── agent/                 # Core agent loop & types
│   │   ├── src/
│   │   │   ├── index.ts       # Public exports
│   │   │   ├── types.ts       # Message, Tool, ThinkingLevel types
│   │   │   ├── agent.ts       # Agent class
│   │   │   ├── agent-loop.ts  # Main conversation loop
│   │   │   └── proxy.ts       # Proxy utilities
│   │   └── test/
│   │
│   ├── tui/                   # Terminal UI framework
│   │   ├── src/
│   │   │   ├── index.ts       # Public exports
│   │   │   ├── tui.ts         # Main TUI class, rendering
│   │   │   ├── terminal.ts    # Terminal abstraction
│   │   │   ├── keys.ts        # Key parsing
│   │   │   ├── mouse.ts       # Mouse event handling
│   │   │   ├── selection.ts   # Text selection
│   │   │   ├── editor-component.ts  # Text input component
│   │   │   └── components/    # UI components (Box, Markdown, etc.)
│   │   └── test/
│   │
│   └── coding-agent/          # Pi coding agent (main application)
│       ├── src/
│       │   ├── main.ts        # Entry point
│       │   ├── cli.ts         # CLI setup
│       │   ├── config.ts      # Configuration
│       │   ├── cli/           # CLI commands (args.ts, list-models.ts)
│       │   ├── core/          # Core logic
│       │   │   ├── agent-session.ts   # Session management
│       │   │   ├── model-resolver.ts  # Model selection
│       │   │   ├── model-registry.ts  # Model registry
│       │   │   ├── bash-executor.ts   # Shell execution
│       │   │   ├── messages.ts        # Message handling
│       │   │   └── hooks/             # Lifecycle hooks
│       │   ├── modes/
│       │   │   ├── interactive/       # Interactive TUI mode
│       │   │   ├── print-mode.ts      # Non-interactive output
│       │   │   └── rpc/               # RPC server mode
│       │   └── utils/
│       ├── docs/              # Documentation
│       ├── examples/          # Extensions & SDK examples
│       └── test/
│
├── .husky/                    # Git hooks (pre-commit runs bun run check)
├── biome.json                 # Linter/formatter config
├── tsconfig.json              # TypeScript config (uses tsgo)
└── package.json               # Workspace root
```

### Package Dependencies
```
coding-agent → agent → ai
            → tui
```

## First Message
If the user did not give you a concrete task in their first message,
read README.md, then ask which module(s) to work on. Based on the answer, explore the relevant package source:
- packages/ai/src/
- packages/tui/src/
- packages/agent/src/
- packages/coding-agent/src/

## Code Quality
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional

## Commands
- After code changes (not documentation changes): `bun run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- `bun run check` runs: `biome check --write . && tsgo --noEmit`
- **After implementation complete**: Run both `bun run check` AND `bun run build` to verify full compilation
- NEVER run: `bun run dev`, `bun test` (without specific filter)
- Only run specific tests if user instructs: `bun test packages/ai/test/specific.test.ts`
- NEVER commit unless user asks
- Pre-commit hook (husky) automatically runs `bun run check`

## GitHub Issues
When reading issues:
- Always read all comments on the issue
- Use this command to get everything in one call:
  ```bash
  gh issue view <number> --json title,body,comments,labels,state
  ```

When closing issues via commit:
- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## PR Workflow
- Analyze PRs without pulling locally first
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, and leave a comment in the user's tone
- You never open PRs yourself. We work in feature branches until everything is according to the user's requirements, then merge into main, and push.

## Tools
- GitHub CLI for issues/PRs

## Style
- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Adding a New LLM Provider (packages/ai)

Adding a new provider requires changes across multiple files:

### 1. Core Types (`packages/ai/src/types.ts`)
- Add API identifier to `Api` type union
- Current values: `openai-completions`, `openai-responses`, `openai-codex-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`
- Create options interface extending `StreamOptions`
- Add mapping to `ApiOptionsMap`
- Add provider name to `KnownProvider` type union
- Current providers: `amazon-bedrock`, `anthropic`, `google`, `google-gemini-cli`, `google-antigravity`, `google-vertex`, `openai`, `openai-codex`, `github-copilot`, `xai`, `groq`, `cerebras`, `zai`, `mistral`, `minimax`, `minimax-cn`, `openrouter`, `vercel-ai-gateway`, `opencode`, `kimi-for-coding`

### 2. Provider Implementation (`packages/ai/src/providers/`)
Create provider file exporting:
- `stream<Provider>()` function returning `AssistantMessageEventStream`
- Message/tool conversion functions
- Response parsing emitting standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

Current provider files:
- `anthropic.ts`
- `amazon-bedrock.ts`
- `google.ts`, `google-shared.ts`, `google-vertex.ts`, `google-gemini-cli.ts`
- `openai-completions.ts`, `openai-responses.ts`, `openai-codex-responses.ts`
- `transform-messages.ts` (shared utilities)

### 3. Stream Integration (`packages/ai/src/stream.ts`)
- Import provider's stream function and options type
- Add credential detection in `getEnvApiKey()`
- Add case in `mapOptionsForApi()` for `SimpleStreamOptions` mapping
- Add provider to `streamFunctions` map

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)
- Add logic to fetch/parse models from provider source
- Map to standardized `Model` interface

### 5. Tests (`packages/ai/test/`)
Add provider to relevant test files. Current test files:
- `stream.test.ts` - basic streaming
- `tokens.test.ts` - token counting
- `abort.test.ts` - abort handling
- `empty.test.ts` - empty response handling
- `context-overflow.test.ts` - context window overflow
- `unicode-surrogate.test.ts` - unicode handling
- `tool-call-without-result.test.ts` - tool call edge cases
- `image-tool-result.test.ts` - image in tool results
- `total-tokens.test.ts` - token aggregation
- `cross-provider-handoff.test.ts` - provider switching

For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families, add at least one pair per family.

For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with credential detection.

### 6. Coding Agent (`packages/coding-agent/`)
- `src/core/model-resolver.ts`: Add default model ID to `defaultModelPerProvider` record
- `src/cli/args.ts`: Add env var documentation if needed

## **CRITICAL** Tool Usage Rules **CRITICAL**
- NEVER use sed/cat to read a file or a range of a file. Always use the read tool (use offset + limit for ranged reads).
- You MUST read every file you modify in full before editing.

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing
- **ONLY commit files YOU changed in THIS session**
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session

### Forbidden Git Operations
These commands can destroy other agents' work:
- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work

### Safe Workflow
```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/my-provider.ts

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur
- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push
