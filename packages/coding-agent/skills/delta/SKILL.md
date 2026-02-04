---
name: phi_delta
description: >-
  Persistent memory CLI. Store, search, and manage memories with importance levels
  and tags. No JSON arguments, no enums - just simple CLI.
  Triggers: remember, recall, memory, what did I decide, preferences, delta.
version: "2.0"
---

# phi_delta - Memory CLI

```
┌─────────────────────────────────────────────────────────────────┐
│ QUICK REMEMBER (by importance)                                  │
├─────────────────────────────────────────────────────────────────┤
│ phi_delta low CONTENT       │ Remember with importance 1        │
│ phi_delta normal CONTENT    │ Remember with importance 2        │
│ phi_delta high CONTENT      │ Remember with importance 3        │
│ phi_delta critical CONTENT  │ Remember with importance 4        │
├─────────────────────────────────────────────────────────────────┤
│ CORE COMMANDS                                                   │
├─────────────────────────────────────────────────────────────────┤
│ phi_delta remember CONTENT  │ Store [--importance N] [--context]│
│ phi_delta search [QUERY]    │ Search [--importance N] [--tag T] │
│ phi_delta recent [N]        │ Show N most recent (default 10)   │
│ phi_delta get ID            │ Get full memory                   │
│ phi_delta forget ID         │ Delete memory                     │
│ phi_delta tag ID TAG        │ Add tag                           │
│ phi_delta untag ID TAG      │ Remove tag                        │
│ phi_delta tags              │ List all tags                     │
│ phi_delta info              │ Database stats                    │
└─────────────────────────────────────────────────────────────────┘

IMPORTANCE:  1=low  2=normal  3=high  4=critical
```

## Examples

```bash
# Quick remember by importance
phi_delta high "User prefers vim keybindings"
phi_delta critical "Found XSS vulnerability in auth module"
phi_delta normal "API rate limit is 100 req/min"

# Search and recall
phi_delta recent                      # last 10
phi_delta search "auth"               # search by content
phi_delta search --importance 4       # critical only
phi_delta search --tag security       # by tag

# Organize
phi_delta tag 1 preference
phi_delta tag 2 security
phi_delta get 1                       # full details
```

## When to Remember

| Event | Importance | Example |
|-------|------------|---------|
| User preference | 3 (high) | `phi_delta high "prefers dark mode"` |
| Decision made | 3 (high) | `phi_delta high "chose React over Vue"` |
| Bug found | 4 (critical) | `phi_delta critical "race condition in auth"` |
| API detail | 2 (normal) | `phi_delta normal "rate limit 100/min"` |
| Architecture | 3 (high) | `phi_delta high "uses microservices"` |

## Database

Location: `~/.local/share/phi/projects/<project-root-dir>/delta.db`

`<project-root-dir>` is derived from git common dir (supports worktrees) or cwd.

Override: `PHI_DELTA_DATA_DIR=/path/to/dir`
