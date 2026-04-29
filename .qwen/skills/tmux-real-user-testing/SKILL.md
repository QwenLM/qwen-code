---
name: tmux-real-user-testing
description: This skill should be used when the user asks to "用 tmux 做真实测试", "保存 tmux 日志", "像真实用户一样测试 Qwen", "生成可复查的 TUI 测试报告", "测试 slash command 交互", or requests a tmux-based real user E2E run with complete readable logs. It guides real TUI usage with step-by-step capture-pane snapshots rather than ANSI raw pipe logs.
---

# tmux Real User Testing

Run Qwen Code in a real tmux TUI session as a user would: navigate dialogs,
trigger slash commands, exercise workflows, and save a readable log that
maintainers can review. Prefer this workflow when the goal is not just a pass/fail
assertion, but a narrative artifact showing what happened on screen.

## Core principle

Use tmux as a real-use harness. Drive the TUI with realistic keyboard actions,
then save a step-by-step readable transcript with `tmux capture-pane -p` after
each meaningful state change.

Avoid relying on `tmux pipe-pane` as the primary report. `pipe-pane` captures raw
ANSI/control streams from React Ink TUI output and often looks like garbled text
when opened as plain text. Use `pipe-pane` only as an optional forensic artifact. Make
`tmux-readable-full.log` the main deliverable.

## When to use

Use this workflow for:

- TUI behavior, rendering, dialogs, keyboard navigation, slash commands, or auth
  flows.
- Realistic workflows where a maintainer wants to read the journey afterward.
- Regression testing where final state is insufficient and intermediate screens
  matter.
- User-facing flows such as `/auth`, `/model`, `/manage-models`, MCP setup,
  permissions, onboarding, or interactive error recovery.

Use headless JSON E2E instead when only tool execution or model API behavior
needs structured assertions.

## Standard artifact layout

Create a timestamped directory under project `tmp/`:

```text
tmp/<scenario>-tmux-YYYYMMDD-HHMMSS/
├── tmux-readable-full.log   # primary report: step-by-step readable snapshots
├── tmux-final-capture.log   # final screen only
├── current-pane.txt         # latest poll/snapshot scratch file
└── report.md                # short summary with result and artifact pointers
```

Do not overwrite previous runs. Preserve complete logs unless the user explicitly
asks to sanitize or trim them.

## Recommended helper script

Use `scripts/tmux-real-user-log.sh` to avoid rewriting shell glue. The script can
start a session, append labeled snapshots, send keys, wait for text, and finish.

The `start` command outputs `export` statements — use `eval` to set the variables
directly in your shell:

```bash
eval "$(bash .qwen/skills/tmux-real-user-testing/scripts/tmux-real-user-log.sh \
  start <scenario> . npm run dev -- --approval-mode yolo)"
# → $SESSION, $OUTDIR, $LOG are now available
```

Show the full usage before running a new scenario:

```bash
bash .qwen/skills/tmux-real-user-testing/scripts/tmux-real-user-log.sh help
```

## Manual workflow

### 1. Start the TUI

Use a large tmux viewport so dialogs render fully. Wait for the TUI to render
before interacting — poll for a known startup string rather than blind sleeping:

```bash
TS=$(date +%Y%m%d-%H%M%S)
PROJECT_ROOT="$(pwd)"
OUT="$PROJECT_ROOT/tmp/<scenario>-$TS"
SESSION="<scenario>-$TS"
mkdir -p "$OUT"
tmux new-session -d -s "$SESSION" -x 200 -y 50 \
  -c "$PROJECT_ROOT" \
  "npm run dev -- --approval-mode yolo"

# Poll until TUI is ready (adjust regex to match your app's startup line)
for i in $(seq 1 30); do
  sleep 1
  if tmux capture-pane -t "$SESSION" -p -S -100 | grep -q "Ready\|>"; then
    break
  fi
done
```

Use `node dist/cli.js` instead of `npm run dev` only when verifying a built
bundle. Use the globally installed `qwen` only when reproducing a user-reported
installed-version bug.

### 2. Append labeled readable snapshots

After each meaningful action, append a section header plus `capture-pane -p` to
the full log:

```bash
LOG="$OUT/tmux-readable-full.log"
{
  printf '\n===== 01 /auth dialog =====\n'
  tmux capture-pane -t "$SESSION" -p -S -240
} >> "$LOG"
```

Increase `-S` as the session grows (add ~100 lines per section). The important
part is that each section is a rendered frame, not raw ANSI output.

### 3. Send keys like a user

Split typing and Enter to avoid swallowed submissions:

```bash
tmux send-keys -t "$SESSION" "/auth"
sleep 0.5
tmux send-keys -t "$SESSION" Enter
sleep 2
```

For navigation:

```bash
tmux send-keys -t "$SESSION" Down
tmux send-keys -t "$SESSION" Space
tmux send-keys -t "$SESSION" Escape
```

For text input into Ink fields, prefer one key at a time if bulk text is ignored:

```bash
tmux send-keys -t "$SESSION" e n a b l e d
```

### 4. Poll for completion instead of blind sleeping

Use text on the screen as the completion condition. On timeout, dump the current
pane so the log shows what was on screen when the wait expired:

```bash
for i in $(seq 1 60); do
  sleep 2
  tmux capture-pane -t "$SESSION" -p -S -400 > "$OUT/current-pane.txt"
  if grep -q "Successfully configured\|Error\|failed" \
    "$OUT/current-pane.txt"; then
    break
  fi
done
# Always append the final poll result (match or timeout) to the log
{
  printf '\n===== 04 auth result =====\n'
  cat "$OUT/current-pane.txt"
} >> "$LOG"
```

### 5. Finish cleanly

Capture the final screen, append it, then kill the session:

```bash
tmux capture-pane -t "$SESSION" -p -S -10000 > "$OUT/tmux-final-capture.log"
{
  printf '\n===== final capture before cleanup =====\n'
  cat "$OUT/tmux-final-capture.log"
} >> "$LOG"
tmux kill-session -t "$SESSION"
```

## Reporting expectations

Write `report.md` with:

- Date, tmux session name, command, workspace.
- Scenario scope and exact steps tested.
- PASS/FAIL result.
- Key screen observations and important state transitions.
- Artifact list, with `tmux-readable-full.log` marked as the primary log.
- Any known side effects, such as settings updates, opened browser windows, or
  API calls.

Keep assertions tied to evidence in the log. Prefer phrases like “log section
`07 toggle model on` shows `16 enabled`” over unsupported summaries.

## Designing a test scenario

A good scenario is a linear sequence of observable state transitions. Design it
as a series of steps where each step produces visible TUI output you can capture:

1. **Entry point** — the slash command or action that starts the flow.
2. **Branch points** — dialogs or selectors that require navigation keys (Arrow,
   Space, Enter).
3. **Waiting states** — loading screens, auth callbacks, or async operations that
   need `wait-for` polling.
4. **Confirmation** — success/error text visible on screen that marks completion.
5. **Side effects** — external actions the flow triggers (browser open, file
   writes, config changes) that may affect subsequent runs.

For each step, define:

- The **keys** to send (`/auth`, `Down`, `Enter`, etc.)
- The **expected text** to wait for (`Successfully configured`, `Error`, `Saved`)
- When to take a **snapshot** (before and after every interaction)

### Short example: testing /auth → OAuth

```bash
HELPER=.qwen/skills/tmux-real-user-testing/scripts/tmux-real-user-log.sh

# Start
eval "$(bash "$HELPER" start auth-test . npm run dev -- --approval-mode yolo)"
# → prints SESSION=... OUTDIR=...

# Trigger /auth, navigate to OAuth provider
bash "$HELPER" type-submit "$SESSION" /auth
bash "$HELPER" snapshot "$SESSION" "$OUTDIR" "01 auth menu"
bash "$HELPER" send "$SESSION" Down Down Enter
bash "$HELPER" snapshot "$SESSION" "$OUTDIR" "02 provider selected"

# Wait for OAuth flow to complete (may involve browser interaction)
bash "$HELPER" wait-for "$SESSION" "$OUTDIR" "Successfully configured|Error|failed"
bash "$HELPER" snapshot "$SESSION" "$OUTDIR" "03 auth result"

# Finish
bash "$HELPER" finish "$SESSION" "$OUTDIR"
```

For flows involving browser OAuth callbacks, the `wait-for` poll will catch the
result after the user completes the browser step. If the flow requires the LLM to
open the browser itself, note that side effect in the scenario design.

## Safety and privacy

Ask before deleting logs or reverting settings. Do not sanitize by default if the
user explicitly requests complete logs. If logs may be shared externally, offer a
separate sanitized copy rather than modifying the original.

Mention likely side effects before starting: OAuth may open a browser, write Qwen
settings, set API key config, and update model provider entries.

## Common pitfalls

- `open <file>` on macOS producing no terminal output is normal; it launches the
  file in the associated app.
- `tmux-final-capture.log` contains only the last screen; it is not the full
  journey.
- `tmux-readable-full.log` is the report-grade artifact.
- `tmux pipe-pane` raw logs can contain ANSI control sequences and look garbled.
- Search boxes and input fields sometimes ignore bulk text; send characters
  individually.
- `capture-pane` records current rendered state, not transient flicker.
- Use a timestamped output directory for every run to avoid overwriting evidence.
