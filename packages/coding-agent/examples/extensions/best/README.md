# Best Extensions for Phi

This directory contains two advanced extensions for the Phi coding agent:

- **Epsilon** - Task management with subtasks, priorities, and tags
- **Delta** - Persistent memory with FTS5 full-text search

## Epsilon (Task Management)

Epsilon provides task tracking capabilities for managing work items during coding sessions.

### Features

- Create tasks with title, description, priority, status, and tags
- Support for subtasks (parent-child relationships)
- Status tracking: todo, in_progress, blocked, done, cancelled
- Priority levels: low, medium, high, critical
- Filter tasks by status, priority, tags, or parent

### Tools

| Tool | Description |
|------|-------------|
| `epsilon_task_create` | Create a new task |
| `epsilon_task_list` | List tasks with filters |
| `epsilon_task_update` | Update an existing task |
| `epsilon_task_delete` | Delete a task by ID |
| `epsilon_task_get` | Get a single task's details |
| `epsilon_info` | Show database location |
| `epsilon_version` | Show schema version |

### Storage

Tasks are stored in SQLite at `~/.local/share/phi-ext-epsilon/<repo-id>/epsilon.db`

### Installation

Copy the `epsilon` directory to your extensions folder:

```bash
# Global
mkdir -p ~/.phi/agent/extensions/best
cp -r epsilon ~/.phi/agent/extensions/best/

# Project-local
mkdir -p .phi/extensions/best
cp -r epsilon .phi/extensions/best/
```

Or use the `--extension` flag:

```bash
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

### Tools

| Tool | Description |
|------|-------------|
| `delta_remember` | Store a new memory |
| `delta_search` | Search memories with FTS5 |
| `delta_forget` | Delete a memory by ID |
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

Copy the `delta` directory to your extensions folder:

```bash
# Global
mkdir -p ~/.phi/agent/extensions/best
cp -r delta ~/.phi/agent/extensions/best/

# Project-local
mkdir -p .phi/extensions/best
cp -r delta .phi/extensions/best/
```

Or use the `--extension` flag:

```bash
phi -e ./delta/src/index.ts
```

---

## Dependencies

Both extensions require:

- `better-sqlite3` - SQLite database with FTS5 support
- `@sinclair/typebox` - JSON schema validation

Install dependencies in each extension directory:

```bash
cd epsilon && bun install
cd ../delta && bun install
```

## Configuration

No configuration required. Both extensions automatically:
- Create their databases on first use
- Handle schema migrations
- Scope data to the current git repository

## Usage Notes

- **Epsilon**: Tasks are automatically injected into the system prompt each turn
- **Delta**: Critical/high importance memories are auto-loaded; use `delta_search` to recall others
- Both extensions work with Phi branches/forks - state is reconstructed from session history
