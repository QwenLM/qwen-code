#!/usr/bin/env bash
# Find the innermost node child process in a tmux session.
# Usage: find-leaf-node.sh <tmux-session-name>
set -euo pipefail

session=${1:?Usage: find-leaf-node.sh <tmux-session-name>}

pid=$(tmux list-panes -t "$session" -F '#{pane_pid}' | head -1)

while true; do
  child=$(pgrep -P "$pid" node 2>/dev/null | head -1 || true)
  [ -z "$child" ] && break
  pid=$child
done

echo "$pid"
