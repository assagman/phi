# Phi Skills

Built-in CLI tools for AI agent memory and task management.

## Tools

| Tool | Description |
|------|-------------|
| `phi_delta` | Persistent memory (remember, search, tag) |
| `phi_epsilon` | Task management (create, list, update, done) |

Both store data in `~/.local/share/phi/projects/<project-root-dir>/`

## Installation

```bash
# Via bun (recommended - symlinks to source)
cd packages/coding-agent && bun run link-skills

# Or copy to ~/.local/bin
./skills/install.sh
```

## Quick Reference

### phi_delta

```bash
# Quick remember by importance
phi_delta low "minor note"
phi_delta normal "API rate limit"
phi_delta high "user preference" 
phi_delta critical "found vulnerability"

# Search and manage
phi_delta recent 10               # last 10
phi_delta search "auth"           # FTS search
phi_delta search --importance 4   # critical only
phi_delta get 1                   # full details
phi_delta tag 1 security          # add tag
phi_delta forget 99               # delete
```

### phi_epsilon

```bash
# Quick status commands (list or transition)
phi_epsilon todo                  # list todo
phi_epsilon todo 1                # mark #1 as todo
phi_epsilon wip                   # list in-progress
phi_epsilon wip 1                 # start working on #1
phi_epsilon done                  # list completed
phi_epsilon done 1                # mark #1 done
phi_epsilon drop 1                # cancel #1

# Task management
phi_epsilon add "task title" --priority high
phi_epsilon backlog               # wip + todo by priority
phi_epsilon next                  # highest priority todo
phi_epsilon get 1                 # details
phi_epsilon tag 1 backend         # add tag
phi_epsilon rm 99                 # delete
```

## Design Principles

**No JSON arguments** - LLMs struggle with nested JSON in tool calls.

**Simple string values** - Readable, no memorizing numbers:

```
phi_delta:
  --importance N    1=low  2=normal  3=high  4=critical

phi_epsilon:
  --status S        todo | in_progress | blocked | done | cancelled
  --priority P      low | medium | high | critical
```

**Shorthand commands** - Common operations are single words:
- `phi_epsilon wip 1` instead of `phi_epsilon update 1 --status in_progress`
- `phi_delta high "note"` instead of `phi_delta remember "note" --importance 3`

## Database

Project-specific SQLite databases compatible with existing phi data:

```
~/.local/share/phi/projects/<project-root-dir>/delta.db
~/.local/share/phi/projects/<project-root-dir>/epsilon.db
```

`<project-root-dir>` is derived from git common dir (supports worktrees) or cwd.
