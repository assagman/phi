---
name: phi-tmux-test
description: Test phi's interactive mode via tmux. Use when you need to test TUI behavior, extensions, or interactive features programmatically.
---

# Testing Phi Interactively via tmux

Use tmux to test phi's interactive mode. This allows sending input and capturing output programmatically.

## Setup

```bash
# Kill any existing test session and create a new one
tmux kill-session -t phi-test 2>/dev/null
tmux new-session -d -s phi-test -c /Users/badlogic/workspaces/phi-mono -x 100 -y 30

# Start phi using the test script (runs via tsx, picks up source changes)
# Always use --no-session to avoid creating session files during testing
tmux send-keys -t phi-test "./phi-test.sh --no-session" Enter

# Wait for startup
sleep 4
tmux capture-pane -t pi-test -p
```

## Interaction

```bash
# Send input
tmux send-keys -t phi-test "your message here" Enter

# Wait and capture output
sleep 5
tmux capture-pane -t phi-test -p

# Send special keys
tmux send-keys -t phi-test Escape
tmux send-keys -t phi-test C-c      # Ctrl+C
tmux send-keys -t phi-test C-d      # Ctrl+D
```

## Cleanup

```bash
tmux kill-session -t phi-test
```

## Testing Extensions

Write extensions to /tmp and load with `-e`:

```bash
cat > /tmp/test-extension.ts << 'EOF'
import type { ExtensionAPI } from "coding-agent";
export default function (pi: ExtensionAPI) {
  // extension code
}
EOF

# Run phi with the extension
tmux send-keys -t phi-test "./phi-test.sh --no-session -e /tmp/test-extension.ts" Enter
```

Clean up after testing: `rm /tmp/test-extension.ts`
