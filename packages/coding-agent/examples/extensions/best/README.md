# Best Extensions for Phi

> **Note:** The builtin delta and epsilon are now CLI tools (`phi_delta`, `phi_epsilon`) 
> installed via `packages/coding-agent/skills/`. The delta and epsilon extensions below 
> are **examples of the extension framework** - they demonstrate how to build custom 
> MCP-style tools, not the actual builtin tools used by the agent.

This directory contains advanced extensions for the Phi coding agent, all adapted for the standalone fullscreen TUI mode:

- **Epsilon** - Task management with subtasks, priorities, and tags
- **Delta** - Persistent memory with FTS5 full-text search
- **Questionnaire** - Multi-question UI tool for user interaction
- **Handoff** - Transfer context to a new focused session

---

## Questionnaire (User Interaction)

Questionnaire provides a tool for asking users single or multiple questions with option lists.

### Features

- Single question: simple options list with keyboard navigation
- Multiple questions: tab bar navigation between questions
- "Type something" option for custom free-text input
- Tab-based interface for multi-question workflows
- Centered overlay rendering (standalone TUI compatible)

### Tools

| Tool | Description |
|------|-------------|
| `questionnaire` | Ask user one or more questions |

### Usage Example

The LLM can call this tool to get user preferences:

```typescript
// Single question
{ questions: [{ id: "color", prompt: "Pick a color", options: [
    { value: "red", label: "Red" },
    { value: "blue", label: "Blue" }
]}]}

// Multiple questions with tabs
{ questions: [
    { id: "scope", label: "Scope", prompt: "What scope?", options: [...] },
    { id: "priority", label: "Priority", prompt: "Priority level?", options: [...] }
]}
```

### Installation

```bash
# Global
mkdir -p ~/.phi/agent/extensions/best
cp -r questionnaire ~/.phi/agent/extensions/best/
cd ~/.phi/agent/extensions/best/questionnaire && bun install

# Or use the --extension flag
phi -e ./questionnaire/src/index.ts
```

---

## Handoff (Context Transfer)

Handoff creates a new session with summarized context from the current conversation.

### Features

- Extracts key context (decisions, files, approaches) from conversation
- Generates a focused prompt for the new session
- Editor for reviewing/editing the generated prompt
- Parent session tracking
- Centered overlay loader (standalone TUI compatible)

### Commands

| Command | Description |
|---------|-------------|
| `/handoff <goal>` | Create new session with context for the specified goal |

### Usage Examples

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

### Installation

```bash
# Global
mkdir -p ~/.phi/agent/extensions/best
cp -r handoff ~/.phi/agent/extensions/best/
cd ~/.phi/agent/extensions/best/handoff && bun install

# Or use the --extension flag
phi -e ./handoff/src/index.ts
```

---

## Epsilon (Task Management)

Epsilon provides task tracking capabilities for managing work items during coding sessions.

### Features

- Create tasks with title, description, priority, status, and tags
- Support for subtasks (parent-child relationships)
- Status tracking: todo, in_progress, blocked, done, cancelled
- Priority levels: low, medium, high, critical
- Filter tasks by status, priority, tags, or parent
- Bulk operations for creating/updating multiple tasks

### Tools

| Tool | Description |
|------|-------------|
| `epsilon_task_create` | Create a new task |
| `epsilon_task_create_bulk` | Create multiple tasks at once |
| `epsilon_task_list` | List tasks with filters |
| `epsilon_task_update` | Update an existing task |
| `epsilon_task_update_bulk` | Update multiple tasks at once |
| `epsilon_task_delete` | Delete a task by ID |
| `epsilon_task_delete_bulk` | Delete multiple tasks at once |
| `epsilon_task_get` | Get a single task's details |
| `epsilon_info` | Show database location |
| `epsilon_version` | Show schema version |

### Storage

Tasks are stored in SQLite at `~/.local/share/phi-ext-epsilon/<repo-id>/epsilon.db`

### Installation

```bash
# Global
mkdir -p ~/.phi/agent/extensions/best
cp -r epsilon ~/.phi/agent/extensions/best/
cd ~/.phi/agent/extensions/best/epsilon && bun install

# Or use the --extension flag
phi -e ./epsilon/src/index.ts
```

---

## Delta (Persistent Memory)

Delta provides long-term memory storage with full-text search capabilities.

### Features

- Store memories with content, tags, importance, and context
- FTS5 full-text search across content, tags, and context
- Importance levels: low, normal, high, critical
- Automatic git commit capture
- Memory pruning dashboard via `/delta-prune` command
- Idle nudges to encourage memory logging
- Critical memories auto-loaded into context
- Bulk operations for storing/forgetting multiple memories

### Tools

| Tool | Description |
|------|-------------|
| `delta_remember` | Store a new memory |
| `delta_remember_bulk` | Store multiple memories at once |
| `delta_search` | Search memories with FTS5 |
| `delta_forget` | Delete a memory by ID |
| `delta_forget_bulk` | Delete multiple memories at once |
| `delta_info` | Show database stats |
| `delta_version` | Show schema version |
| `delta_schema` | Dump database schema |

### Commands

| Command | Description |
|---------|-------------|
| `/delta-prune` | Open interactive pruning dashboard |

### Storage

Memories are stored in SQLite with FTS5 at `~/.local/share/phi-ext-delta/<repo-id>/delta.db`

### Installation

```bash
# Global
mkdir -p ~/.phi/agent/extensions/best
cp -r delta ~/.phi/agent/extensions/best/
cd ~/.phi/agent/extensions/best/delta && bun install

# Or use the --extension flag
phi -e ./delta/src/index.ts
```

---

## Dependencies

All extensions require:

- `@sinclair/typebox` - JSON schema validation

Epsilon and Delta additionally require:

- `better-sqlite3` - SQLite database with FTS5 support (via bun's native SQLite)

Install dependencies in each extension directory:

```bash
cd questionnaire && bun install
cd ../handoff && bun install
cd ../epsilon && bun install
cd ../delta && bun install
```

## Standalone TUI Compatibility

These extensions are specifically adapted for the standalone fullscreen TUI mode:

- **Questionnaire** and **Handoff** use overlay mode (`overlay: true`) for their custom UI
- This ensures proper rendering in the fixed-layout fullscreen mode
- The original versions in `examples/extensions/` use editor container swapping which doesn't work in standalone mode

## Configuration

No configuration required. All extensions automatically:
- Create their databases on first use (epsilon, delta)
- Handle schema migrations (epsilon, delta)
- Scope data to the current git repository (epsilon, delta)

## Usage Notes

- **Epsilon**: Tasks are automatically injected into the system prompt each turn
- **Delta**: Critical/high importance memories are auto-loaded; use `delta_search` to recall others
- **Questionnaire**: Rendered as centered overlay, navigable with keyboard
- **Handoff**: Uses model completion to generate context summary
- All extensions work with Phi branches/forks - state is reconstructed from session history
