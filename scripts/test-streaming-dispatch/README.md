# Streaming Tool Dispatch — Manual / E2E Test Harness

End-to-end smoke-test scaffolding for the experimental
`streamingToolDispatch` feature (PR #4402 / RFC #4387). Drives the built
`packages/cli/dist/index.js` against real model calls, captures
per-invocation logs under `test-results/<timestamp>/`, and surfaces a
side-by-side tmux watch session for visual progress.

The vitest suites in `packages/core/src/core/streaming*.test.ts` cover
the unit-level invariants. This harness is the integration layer — it
catches issues that only appear when the dispatcher, executor, Turn,
and the headless consumer are wired together against a live provider.

## Layout

```
scripts/test-streaming-dispatch/
├── run.sh                      # entrypoint — orchestrates one or all scenarios
├── lib.sh                      # shared helpers (run_cli_once, tmux session, timing)
├── scenario-baseline.sh        # flag-off vs flag-on wall-time + behavior diff
├── scenario-json-schema.sh     # --json-schema gate (dispatcher must stay off)
├── scenario-shell-bypass.sh    # classifier rejects wrapper-trailing-content bypass
├── scenario-abort.sh           # SIGINT must not leave orphan tool subprocesses
└── test-results/<stamp>/       # per-run logs (gitignored)
```

## Prerequisites

- `npm run build` — the harness invokes the compiled
  `packages/cli/dist/index.js`, not the TS sources. A background watcher
  that re-emits `dist` will trip the per-invocation existence check.
- A working CLI auth setup (e.g. `~/.qwen/settings.json` with an OpenAI-
  compatible provider) — the scenarios make real API calls.
- `tmux` (only for the optional watch session — scenarios run fine
  without it).

## Usage

```bash
# All scenarios, 3 samples each (≈ 18 LLM calls):
bash scripts/test-streaming-dispatch/run.sh

# A specific scenario:
bash scripts/test-streaming-dispatch/run.sh baseline

# Smoke pass (1 sample per scenario):
RUNS=1 bash scripts/test-streaming-dispatch/run.sh

# Watch live output while the sweep runs:
tmux attach -t qwen-stream-test
```

## What each scenario asserts

### `baseline`

Same prompt asks for three independent safe tool calls (read_file +
glob + grep_search). Both flag-off and flag-on must finish; the median
wall time is reported per side. **Expected speedup is small in
practice** — local file ops complete in milliseconds, so the model's
streaming time dominates total wall time. Early dispatch shows
meaningful wins only when tools take significant wall-clock time (slow
fetches, large grep on remote FS, etc.).

The semantic verification is "both outputs are non-empty and the model
issued the expected tool count" — the actual prose differs between
runs (model RNG).

### `json-schema`

Adds `--json-schema @schema.json`. The dispatcher gate in
`nonInteractiveCli.ts` is supposed to disable streaming dispatch
entirely when a schema is active (sibling-suppression for
`structured_output` is unsafe to bypass mid-stream — RFC §3.5). Asserts
every run's stdout is a JSON object conforming to the schema. A
regression in the gate would either produce malformed output or
mismatched tool/response pairing.

### `shell-bypass`

**No model call.** Imports the built `isEarlyDispatchSafe` and feeds it
a battery of `bash -c "..." && rm -rf /` shapes. We can't safely
provoke the model into emitting these, and even if it did, the test
would risk actually executing the trailing command on a regression.
This scenario asserts the classifier rejects every malicious shape at
the same code path the streaming loop uses.

### `abort`

Asks the model to run a tight `for i in $(seq 1 50); do find ...; done`
loop via the shell tool, lets it execute for ~3 seconds, sends SIGINT,
and waits up to 15s for the CLI to exit on its own.

**Primary assertion (hard fail):** every CLI invocation exits within
15s of SIGINT without needing a SIGKILL escalation. This is exactly
what the orphan-prevention guarantee from RFC §4 buys at the e2e
layer — `executor.discard('aborted')` must cascade through the
dispatcher's `cancelInFlight()` listener so `AbortController.abort()`
fires, `executeToolCall`'s child gets aborted, and the CLI's await
returns instead of hanging.

**Secondary observation (warn-only):** count of `find` processes still
alive after an 8-second cool-down. Earlier counters were defeated by:
(a) `pgrep -af 'sleep 30'` matching the harness's own bash pipelines
that carried the search string in their argv; (b) the shell tool
refusing bare `sleep N` calls as blocking, leaving zero real
subprocesses to abort; and (c) `find` scans completing naturally
within ~1-2s, so a process counted at SIGINT+2s was a transient
in-flight find, not a true orphan. The current shape (find loop +
`pgrep -x find` + 8s cool-down) gives the cleanest signal but is
still noisy on macOS where Spotlight may spawn unrelated finds. We
report the count as a warning rather than a hard fail.

The cleanest unit-level verification of orphan-prevention lives in
`packages/core/src/core/turn.test.ts` (the Phase 4 orphan-prevention
block) — this scenario is the integration-level companion.

## Reading the results

Each `test-results/<stamp>/` contains, per invocation:

- `<label>.stdout` — final CLI output (final assistant text or JSON object)
- `<label>.stderr` — warnings, MCP startup errors, debug output
- `<label>.time` — wall seconds (single float)
- `<label>.meta` — flag, prompt, exit code, started/ended timestamps
- `<scenario>-summary.txt` — aggregated metrics

`run.sh`'s final block prints all summary files in sequence.

## When the dist disappears mid-sweep

A background `npm run dev` / vitest watcher / IDE extension can wipe
`packages/cli/dist/index.js` during a rebuild after a source edit. The
per-invocation guard in `lib.sh` retries for 5 seconds then aborts
that invocation with a clear `FATAL: ... disappeared mid-run (rebuild?)`
message — so the failure surfaces as a harness-level message instead
of a confusing "Cannot find module" in stderr that looks like a feature
bug.

If you hit this, either stop the watcher or run `npm run build` and
re-launch the harness.

## Adding a new scenario

1. Create `scenario-<name>.sh`. Source `lib.sh`. Use `init_run_dir` is
   already done by `run.sh`; just write to `$RESULTS_DIR`.
2. Use `run_cli_once "<label>" "<prompt>" "off|on" "<extra-args>"` for
   each invocation. It handles timing, env wiring, and metadata files.
3. Drop a `$RESULTS_DIR/<name>-summary.txt` with at minimum
   `scenario=<name>` so the aggregate report picks it up.
4. Register the scenario in the default list in `run.sh` if it should
   run by default.
