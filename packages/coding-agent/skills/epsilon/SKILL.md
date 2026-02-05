---
name: epsilon
description: >-
  Task management CLI. Create, track, and manage tasks with status, priority,
  tags, and subtasks. No JSON arguments, no enums - just simple CLI.
  Triggers: task, todo, create task, mark done, progress, epsilon.
---

# phi_epsilon - Task CLI

```
┌─────────────────────────────────────────────────────────────────┐
│ QUICK STATUS (list or transition)                               │
├─────────────────────────────────────────────────────────────────┤
│ phi_epsilon todo [ID]   │ List ○ todo  │ Mark ID as todo        │
│ phi_epsilon wip [ID]    │ List ◐ wip   │ Mark ID as wip         │
│ phi_epsilon done [ID]   │ List ✓ done  │ Mark ID as done        │
│ phi_epsilon drop [ID]   │ List ✗ drop  │ Mark ID as cancelled   │
├─────────────────────────────────────────────────────────────────┤
│ CORE COMMANDS                                                   │
├─────────────────────────────────────────────────────────────────┤
│ phi_epsilon add TITLE   │ Create task (--priority N, --parent)  │
│ phi_epsilon get ID      │ Show task details                     │
│ phi_epsilon rm ID       │ Delete task                           │
│ phi_epsilon tag ID TAG  │ Add tag                               │
├─────────────────────────────────────────────────────────────────┤
│ LIST OPTIONS                                                    │
├─────────────────────────────────────────────────────────────────┤
│ phi_epsilon backlog [N] │ wip + todo by priority (default 50)   │
│ phi_epsilon next        │ highest priority todo (single)        │
│ phi_epsilon active      │ todo + wip + blocked                  │
│ phi_epsilon all         │ include done/cancelled                │
└─────────────────────────────────────────────────────────────────┘

STATUS:    1=○todo  2=◐wip  3=⊘blocked  4=✓done  5=✗drop
PRIORITY:  1=low  2=medium  3=high  4=critical
```

## Examples

```bash
# Workflow
phi_epsilon add "Implement auth" --priority 3    # create
phi_epsilon wip 1                                # start working
phi_epsilon done 1                               # complete

# Check status
phi_epsilon todo                 # what's pending
phi_epsilon wip                  # what's active  
phi_epsilon next                 # what to do next

# Manage
phi_epsilon drop 2               # cancel task
phi_epsilon todo 2               # reopen task
phi_epsilon tag 1 backend        # add tag
```

## Advanced

```bash
# List with filters
phi_epsilon list --priority 3 --tag backend --limit 10

# Update details
phi_epsilon update 1 --title "New title" --priority 4

# Subtasks
phi_epsilon add "Feature X" --priority 3
phi_epsilon add "Subtask" --parent 1
phi_epsilon get 1                # shows subtasks
```

## Database

Location: `~/.local/share/phi/projects/<project-root-dir>/epsilon.db`

`<project-root-dir>` is derived from git common dir (supports worktrees) or cwd.

Override: `PHI_EPSILON_DATA_DIR=/path/to/dir`
