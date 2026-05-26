# AbortController refactor — verification plan

Scenarios used to validate the change manually before opening the PR. Each
scenario captures its tmux pane via `tmux pipe-pane -o 'cat >> <log>'`.

## Setup once

```sh
# Point WT at your local checkout of the branch under review.
WT=/path/to/qwen-code/worktree
LOGDIR=$WT/docs/verification/abort-controller-refactor/logs
mkdir -p "$LOGDIR"

# Build the CLI once (skip sandbox image, skip vscode).
( cd "$WT" && npm run build:packages )
```

## Scenarios

For each scenario:

```sh
tmux new-session -d -s qwen-verify-XX
tmux pipe-pane -t qwen-verify-XX -o "cat >> $LOGDIR/XX-name.log"
tmux send-keys -t qwen-verify-XX "cd /path/to/your/test/workspace && exec node $WT/packages/cli/dist/index.js" C-m
tmux attach -t qwen-verify-XX
```

Then drive the session manually per the matrix below. Hit `C-b d` to detach
when done; `tmux kill-session -t qwen-verify-XX` to stop the pane.

### 00 — Baseline (PRE-fix)

- **Setup:** check out `main`, build, run with `NODE_OPTIONS=--trace-warnings`.
- **Input:** long 50-round mixed-tool session (shell + edit + grep + agent).
- **Expected:** after ~30–40 rounds, `MaxListenersExceededWarning: ... 1500+ abort listeners added to [AbortSignal]` printed to stderr.
- **Log:** `00-baseline-reproduction.log`.

### 01 — Long-session, DEBUG mode (this branch)

- **Setup:** `NODE_OPTIONS=--trace-warnings DEBUG=1 qwen`.
- **Input:** same 50-round script as #00.
- **Expected:** no `MaxListenersExceededWarning` printed; any other warnings still print.
- **Log:** `01-long-session-debug.log`.

### 02 — Long-session, prod mode (this branch)

- **Setup:** `qwen` (no debug env).
- **Input:** same 50-round script.
- **Expected:** clean output; a temporary `console.error` probe inside the handler (added then removed) confirms the filter fires.
- **Log:** `02-long-session-prod.log`.

### 03 — Ctrl-C mid-stream abort

- **Setup:** this branch, interactive.
- **Input:** ask for a long generation (>30s); press Ctrl-C mid-stream.
- **Expected:** stream stops within ~200ms, "Cancelled" banner shown, next prompt accepts input. `process._getActiveHandles()` count returns to baseline (use `:debug handles`).
- **Log:** `03-ctrlc-streaming.log`.

### 04 — Cancel long-running shell

- **Setup:** this branch.
- **Input:** run `sleep 60` via the shell tool; cancel mid-execution.
- **Expected:** child process killed (verify with `pgrep -f sleep` returning empty), tool result shows cancellation, agent accepts next prompt.
- **Log:** `04-shell-cancel.log`.

### 05 — Subagent cancellation

- **Setup:** this branch.
- **Input:** spawn a long agent task via the agent tool; cancel from parent.
- **Expected:** subagent's in-flight tool calls abort, subagent's model stream stops, parent receives cancellation event.
- **Log:** `05-subagent-cancel.log`.

### 06 — Headless / non-interactive abort

- **Setup:** `qwen --prompt "do a long task"`; send `SIGINT` from outside via `kill -INT <pid>`.
- **Expected:** clean shutdown, exit code 130, no warnings.
- **Log:** `06-headless-abort.log`.

### 07 — Background agent flow

- **Setup:** interactive.
- **Input:** spawn a background agent (`run_in_background: true`); let it complete; spawn a second one; cancel the second mid-flight.
- **Expected:** first agent completes normally; second aborts cleanly; no listener leak across the two.
- **Log:** `07-background-agent.log`.

### 08 — Memory baseline

- **Setup:** `qwen --inspect`, attach Chrome devtools.
- **Input:** 100-round session.
- **Expected:** heap snapshots at round 0/50/100. `AbortSignal` instance count and per-signal listener count stable (no monotonic growth).
- **Log:** `08-memory-snapshots/`.

### 09 — Existing combinedAbortSignal consumer

- **Setup:** trigger an HTTP hook with both an external signal and timeout.
- **Input:** (a) cancel external signal mid-hook; (b) let timeout fire in a separate run.
- **Expected:** hook aborts cleanly in both cases; deprecation shim path is exercised.
- **Log:** `09-http-hook-shim.log`.

## Automated (non-interactive) verifications

The automated checks below were run during development and recorded in
`automated-results.md`:

- All abortController unit tests pass (`abortController.test.ts`, 26 tests; 1 GC test skipped under non-`--expose-gc`).
- All warningHandler tests pass (`warningHandler.test.ts`, 13 tests including a spawned-child stderr integration test).
- All `combineAbortSignals` consumer tests pass (`httpHookRunner.test.ts`); the deprecated `createCombinedAbortSignal` shim plus its own test file were removed once the lone caller migrated.
- All agent runtime / followup / openaiContentGenerator / hooks tests pass.
- Migration scope (intentional): only the agent-runtime parent→child chain (`agent-interactive.ts`, `agent-core.ts`, `agent-headless.ts`) plus `promptHookRunner.ts` (real cleanup leak) was switched to the helper. Independent short-lived controllers (per-shell-command, per-fetch, per-recall, etc.) stay on raw `new AbortController()` — they're GC'd quickly and don't accumulate listeners on a long-lived parent. See `migration-completeness.txt` for the captured grep + rationale.
- TypeScript strict-mode typecheck passes for both `packages/core` and `packages/cli`.
- Prettier check passes on all modified files.

See `automated-results.md` for the actual command output.

## How to capture the artifacts for the PR body

After running each scenario, attach the transcript file (or relevant excerpt)
to the PR. For #08 (memory), export the heap snapshots and include the
listener-count delta between snapshots.
