# AbortController refactor — verification plan

Scenarios used to validate the change manually before opening the PR. Each
scenario captures its tmux pane via `tmux pipe-pane -o 'cat >> <log>'`.

## Setup once

```sh
# From repo root, the worktree path:
WT=/Users/jinye.djy/Projects/qwen-code/.claude/worktrees/joyful-honking-melody
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
tmux send-keys -t qwen-verify-XX 'cd /path/to/your/test/workspace && exec node /Users/jinye.djy/Projects/qwen-code/.claude/worktrees/joyful-honking-melody/packages/cli/dist/index.js' C-m
tmux attach -t qwen-verify-XX
```

Then drive the session manually per the matrix below. Hit `C-b d` to detach
when done; `tmux kill-session -t qwen-verify-XX` to stop the pane.

| #   | Scenario                              | Setup                                                             | Input prompt                                                                                                             | Expected user output                                                                                                                                             | Log file                                                                                 |
| --- | ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| 00  | Baseline (PRE-fix)                    | Check out `main`, build, run with `NODE_OPTIONS=--trace-warnings` | Long 50-round mixed-tool session (shell + edit + grep + agent)                                                           | After ~30-40 rounds: `MaxListenersExceededWarning: ... 1500+ abort listeners added to [AbortSignal]` printed to stderr                                           | `00-baseline-reproduction.log`                                                           |
| 01  | Long-session, DEBUG mode              | This branch, `NODE_OPTIONS=--trace-warnings DEBUG=1 qwen`         | Same 50-round script as #00                                                                                              | No `MaxListenersExceededWarning` printed; any other warnings still print                                                                                         | `01-long-session-debug.log`                                                              |
| 02  | Long-session, prod mode               | This branch, `qwen` (no debug env)                                | Same 50-round script                                                                                                     | Clean output; temporary `console.error` probe inside the handler (added then removed) confirms filter fires                                                      | `02-long-session-prod.log`                                                               |
| 03  | Ctrl-C mid-stream abort               | This branch, interactive                                          | Ask for a long generation (>30s). Press Ctrl-C mid-stream.                                                               | Stream stops within ~200ms, "Cancelled" banner shown, next prompt accepts input. `process._getActiveHandles()` count returns to baseline (use `:debug handles`). | `03-ctrlc-streaming.log`                                                                 |
| 04  | Cancel long-running shell             | This branch                                                       | `Run \`sleep 60\` via the shell tool`. Cancel mid-execution.                                                             | Child process killed (`ps -ef                                                                                                                                    | grep sleep` returns nothing), tool result shows cancellation, agent accepts next prompt. | `04-shell-cancel.log` |
| 05  | Subagent cancellation                 | This branch                                                       | Spawn a long agent task via the agent tool. Cancel from parent.                                                          | Subagent's in-flight tool calls abort, subagent's model stream stops, parent receives cancellation event.                                                        | `05-subagent-cancel.log`                                                                 |
| 06  | Headless / non-interactive abort      | `qwen --prompt "do a long task"`, send `SIGINT` from outside      | (sent via `kill -INT <pid>`)                                                                                             | Clean shutdown, exit code 130, no warnings.                                                                                                                      | `06-headless-abort.log`                                                                  |
| 07  | Background agent flow                 | Interactive                                                       | Spawn a background agent (`run_in_background: true`). Let it complete. Spawn a second one. Cancel the second mid-flight. | First agent completes normally; second aborts cleanly; no listener leak across the two.                                                                          | `07-background-agent.log`                                                                |
| 08  | Memory baseline                       | `qwen --inspect` + attach Chrome devtools                         | 100-round session                                                                                                        | Heap snapshots at round 0/50/100. `AbortSignal` instance count and per-signal listener count stable (no monotonic growth).                                       | `08-memory-snapshots/`                                                                   |
| 09  | Existing combinedAbortSignal consumer | Trigger an HTTP hook with both an external signal and timeout.    | (a) Cancel external signal mid-hook (b) Let timeout fire in a separate run                                               | Hook aborts cleanly in both cases; deprecation shim path is exercised.                                                                                           | `09-http-hook-shim.log`                                                                  |

## Automated (non-interactive) verifications

The automated checks below were run during development and recorded in
`automated-results.md`:

- All abortController unit tests pass (`abortController.test.ts`, 18 tests + 1 GC test skipped under non-`--expose-gc`).
- All warningHandler tests pass (`warningHandler.test.ts`, 9 tests).
- Existing combinedAbortSignal tests pass against the deprecation shim (8 tests).
- All agent runtime / followup / openaiContentGenerator / hooks tests pass.
- Migration completeness: `grep -rn "new AbortController" packages/core/src --include="*.ts" | grep -v test | grep -v abortController.ts` returns **empty**.
- TypeScript strict-mode typecheck passes for both `packages/core` and `packages/cli`.
- Prettier check passes on all modified files.

See `automated-results.md` for the actual command output.

## How to capture the artifacts for the PR body

After running each scenario, attach the transcript file (or relevant excerpt)
to the PR. For #08 (memory), export the heap snapshots and include the
listener-count delta between snapshots.
