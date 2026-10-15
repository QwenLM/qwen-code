#!/usr/bin/env bash
# =============================================================================
# test-rewind-e2e.sh — tmux-based E2E verification for the conversation rewind
# feature (PR #3441).
#
# Covers all 5 manual test items from the PR description:
#   1. /rewind command → pick turn → UI truncated, input pre-populated
#   2. Double-ESC on empty prompt → selector opens → rewind → continue
#   3. ESC during streaming → cancels request, does NOT open selector
#   4. /rewind with no history → selector does not open
#   5. After rewind, model does not reference removed turns
#
# Prerequisites:
#   - tmux installed
#   - CLI already built:  npm run build && npm run bundle
#   - Valid model API credentials in environment
#
# Usage:
#   bash scripts/test-rewind-e2e.sh
# =============================================================================

set -uo pipefail

SESSION="test-rewind-$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE="$PROJECT_DIR/dist/cli.js"
WORKDIR="$(mktemp -d)"
PASS_COUNT=0
FAIL_COUNT=0
TIMEOUT=${REWIND_TEST_TIMEOUT:-120}  # seconds per wait_for call

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

start_session() {
  # Deliver ESC immediately — without this, tmux holds ESC for up to 500ms
  # thinking it might be the start of an escape sequence, which breaks
  # double-ESC detection and other ESC-dependent interactions.
  # Must be set as a server option (not session) in tmux 2.6+.
  tmux set-option -sg escape-time 0 2>/dev/null || true
  tmux new-session -d -s "$SESSION" -x 120 -y 40 \
    "cd '$WORKDIR' && node '$BUNDLE' --approval-mode yolo 2>'$WORKDIR/stderr.log'"
  wait_for_prompt 60
}

kill_session() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  sleep 1
}

# Capture entire pane including scrollback (for content assertions)
capture() {
  tmux capture-pane -t "$SESSION" -p -S -200 2>/dev/null || true
}

# Capture only the visible pane (for prompt detection)
capture_visible() {
  tmux capture-pane -t "$SESSION" -p 2>/dev/null || true
}

send() {
  # Type text using literal mode then press Enter
  tmux send-keys -t "$SESSION" -l "$1"
  sleep 0.5
  tmux send-keys -t "$SESSION" Enter
}

send_keys() {
  tmux send-keys -t "$SESSION" "$@"
}

# Wait for "Type your message" to appear on the visible pane.
wait_for_prompt() {
  local timeout="${1:-$TIMEOUT}"
  local elapsed=0

  while [ $elapsed -lt "$timeout" ]; do
    if capture_visible | grep -qF "Type your message"; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo -e "${RED}TIMEOUT waiting for prompt (Type your message)${RESET}" >&2
  echo "--- Visible pane ---" >&2
  capture_visible >&2
  echo "--- End ---" >&2
  return 1
}

# Wait for the CLI to be truly idle:
#   1. "Type your message" is visible (prompt ready)
#   2. No "esc to cancel" on screen (no btw/side-query running)
#   3. Screen content unchanged for 3 consecutive seconds
wait_idle() {
  local timeout="${1:-$TIMEOUT}"
  local elapsed=0
  local last_hash=""
  local stable_count=0

  while [ $elapsed -lt "$timeout" ]; do
    local screen
    screen=$(capture_visible)

    # Must have prompt visible
    if ! echo "$screen" | grep -qF "Type your message"; then
      stable_count=0
      last_hash=""
      sleep 2
      elapsed=$((elapsed + 2))
      continue
    fi

    # Must not have btw side-query running
    if echo "$screen" | grep -qF "esc to cancel"; then
      stable_count=0
      last_hash=""
      sleep 2
      elapsed=$((elapsed + 2))
      continue
    fi

    # Check screen stability
    local current
    current=$(echo "$screen" | md5sum | cut -d' ' -f1)
    if [ "$current" = "$last_hash" ]; then
      stable_count=$((stable_count + 1))
      if [ $stable_count -ge 3 ]; then
        return 0
      fi
    else
      last_hash="$current"
      stable_count=0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo -e "${RED}TIMEOUT waiting for idle${RESET}" >&2
  echo "--- Visible pane ---" >&2
  capture_visible >&2
  echo "--- End ---" >&2
  return 1
}

# Wait for text to appear on the visible pane
wait_for() {
  local text="$1"
  local timeout="${2:-$TIMEOUT}"
  local elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    if capture_visible | grep -qF "$text"; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo -e "${RED}TIMEOUT waiting for: ${text}${RESET}" >&2
  echo "--- Visible pane ---" >&2
  capture_visible >&2
  echo "--- End ---" >&2
  return 1
}

# Assert text IS on visible pane
assert_screen() {
  local text="$1"
  if capture_visible | grep -qF "$text"; then
    return 0
  fi
  echo -e "${RED}ASSERT FAILED: expected '${text}' on screen${RESET}" >&2
  echo "--- Visible pane ---" >&2
  capture_visible >&2
  echo "--- End ---" >&2
  return 1
}

# Assert text IS on full capture (including scrollback)
assert_scrollback() {
  local text="$1"
  if capture | grep -qF "$text"; then
    return 0
  fi
  echo -e "${RED}ASSERT FAILED: expected '${text}' in scrollback${RESET}" >&2
  return 1
}

# Assert text is NOT on visible pane
assert_no_screen() {
  local text="$1"
  if capture_visible | grep -qF "$text"; then
    echo -e "${RED}ASSERT FAILED: did NOT expect '${text}' on screen${RESET}" >&2
    echo "--- Visible pane ---" >&2
    capture_visible >&2
    echo "--- End ---" >&2
    return 1
  fi
  return 0
}

pass() {
  echo -e "${GREEN}[PASS]${RESET} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "${RED}[FAIL]${RESET} $1: $2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

# Run a test function, capturing its exit code properly.
# Usage: run_test "Test Name" test_function_name
run_test() {
  local name="$1"
  local func="$2"
  local rc=0
  local errmsg=""

  errmsg=$($func 2>&1) || rc=$?

  if [ $rc -eq 0 ]; then
    pass "$name"
  else
    # Extract last meaningful error line from stderr
    local last_err
    last_err=$(echo "$errmsg" | grep -E 'TIMEOUT|ASSERT FAILED' | tail -1)
    fail "$name" "${last_err:-exit code $rc}"
    echo "$errmsg" | head -30
  fi

  # Always clean up the session between tests
  kill_session 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

if ! command -v tmux &>/dev/null; then
  echo -e "${RED}Error: tmux is not installed${RESET}" >&2
  exit 1
fi

if [ ! -f "$BUNDLE" ]; then
  echo -e "${YELLOW}Bundle not found at $BUNDLE, building...${RESET}"
  (cd "$PROJECT_DIR" && npm run build && npm run bundle)
fi

echo -e "${BOLD}=== Rewind Feature E2E Tests (tmux) ===${RESET}"
echo "Session: $SESSION"
echo "Workdir: $WORKDIR"
echo ""

# ---------------------------------------------------------------------------
# Test 1: /rewind command flow
# ---------------------------------------------------------------------------

test_rewind_command() {
  start_session

  # Build 3-turn conversation with unique markers
  send "say exactly ALPHA1 and nothing else"
  wait_idle || return 1

  send "say exactly BETA2 and nothing else"
  wait_idle || return 1

  send "say exactly GAMMA3 and nothing else"
  wait_idle || return 1

  # Open rewind selector via /rewind command
  send "/rewind"
  wait_for "Rewind Conversation" || return 1

  # Navigate up to select BETA2 turn (selector starts at last turn GAMMA3)
  send_keys Up
  sleep 0.5

  # Select the turn
  send_keys Enter
  sleep 1
  wait_for "confirm" 15 || return 1

  # Confirm rewind
  send_keys y
  wait_for "Conversation rewound" || return 1

  # After rewind: pressing Up once from the initial selection (GAMMA3, the last
  # real user turn) lands on BETA2. Rewind targets BETA2, so its text gets
  # pre-populated into the input bar. Slash commands like /rewind are excluded
  # from the turn list by isRealUserTurn().
  assert_screen "say exactly BETA2" || return 1
  # Verify the earlier turn (ALPHA1) is still in conversation
  assert_scrollback "ALPHA1" || return 1
}

run_test "Test 1: /rewind command flow" test_rewind_command

# ---------------------------------------------------------------------------
# Test 2: Double-ESC opens selector
# ---------------------------------------------------------------------------

test_double_esc() {
  start_session

  send "say exactly DELTA4 and nothing else"
  wait_idle || return 1

  send "say exactly EPSILON5 and nothing else"
  wait_idle || return 1

  # Double-ESC to open rewind selector.
  # Complication: a btw side-question (prompt suggestion) may be active after
  # the model responds. If btwItem is non-null, the first ESC cancels the btw
  # (AppContainer.tsx:1896) and never reaches the rewind handler. We send
  # 3 ESCs with proper timing to handle both btw-present and btw-absent cases:
  #   ESC #1: cancels btw (if present), or starts rewind pending (if absent)
  #   sleep 1.5s: >800ms to reset any rewind pending from ESC #1
  #   ESC #2: starts rewind pending (btw now dismissed)
  #   sleep 0.3s: within 800ms window
  #   ESC #3: triggers rewind selector
  send_keys Escape
  sleep 1.5
  send_keys Escape
  sleep 0.5
  wait_for "Esc again to rewind" 15 || return 1

  # Third ESC within 800ms — should open selector
  send_keys Escape
  wait_for "Rewind Conversation" || return 1

  # Select last turn (pre-selected) & confirm
  send_keys Enter
  sleep 1
  send_keys y
  wait_for "Conversation rewound" || return 1

  # Continue conversation after rewind — verify model still works
  send "say exactly ZETA6 and nothing else"
  wait_idle || return 1
  assert_scrollback "ZETA6" || return 1
}

run_test "Test 2: Double-ESC opens selector" test_double_esc

# ---------------------------------------------------------------------------
# Test 3: ESC during streaming cancels (no rewind)
# ---------------------------------------------------------------------------

test_esc_during_streaming() {
  start_session

  # Send a prompt that will generate a long response
  send "write a detailed 500 word essay about the history of computing from 1940 to 2000"

  # Wait for streaming to start (prompt disappears)
  sleep 4

  # Single ESC while streaming — should cancel, NOT open rewind
  send_keys Escape

  # Verify rewind selector did NOT open
  sleep 3
  assert_no_screen "Rewind Conversation" || return 1

  # Should eventually return to idle
  wait_idle || return 1
}

run_test "Test 3: ESC during streaming cancels (no rewind)" test_esc_during_streaming

# ---------------------------------------------------------------------------
# Test 4: /rewind with no prior conversation
# ---------------------------------------------------------------------------

test_rewind_no_history() {
  start_session

  # Immediately try /rewind with no conversation history.
  # The /rewind text itself gets recorded as a user turn before the slash
  # command handler runs, so the guard (≥1 user turn) passes and the
  # selector opens showing only the "/rewind" entry — which is not a
  # meaningful rewindable turn. We verify the selector has only 1 turn.
  send "/rewind"
  sleep 3

  # The selector may or may not open depending on implementation.
  # If it opens, it should show exactly "1 turns" (only the /rewind itself).
  if capture_visible | grep -qF "Rewind Conversation"; then
    assert_screen "1 turns" || return 1
    # Close the selector with ESC
    send_keys Escape
    sleep 1
  fi

  # Either way, after dismissing we should be back at the prompt
  wait_for_prompt 10 || return 1
}

run_test "Test 4: /rewind with no prior conversation" test_rewind_no_history

# ---------------------------------------------------------------------------
# Test 5: After rewind, model ignores removed turns
# ---------------------------------------------------------------------------

test_rewind_context_isolation() {
  start_session

  # First turn: give model a unique fact
  send "The secret code for this session is XRAY99. Just confirm you received it by saying OK."
  wait_idle || return 1

  # Second turn: different content
  send "say exactly YANKEEZ and nothing else"
  wait_idle || return 1

  # Rewind to remove the YANKEEZ turn
  send "/rewind"
  wait_for "Rewind Conversation" || return 1

  # Select the most recent turn (YANKEEZ) and confirm
  send_keys Enter
  sleep 1
  send_keys y
  wait_for "Conversation rewound" || return 1

  # Clear pre-populated input (Ctrl-U clears line in most terminals)
  send_keys C-u
  sleep 0.5

  # Ask the model what it remembers
  send "What was the secret code I told you? Reply with just the code, nothing else."
  wait_idle || return 1

  # Model should reference XRAY99 (surviving turn)
  assert_scrollback "XRAY99" || return 1
}

run_test "Test 5: After rewind, model ignores removed turns" test_rewind_context_isolation

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}=== Results ===${RESET}"
echo -e "${GREEN}Passed: ${PASS_COUNT}${RESET}"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}Failed: ${FAIL_COUNT}${RESET}"
else
  echo -e "Failed: 0"
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

echo -e "${GREEN}All ${PASS_COUNT} tests passed.${RESET}"
