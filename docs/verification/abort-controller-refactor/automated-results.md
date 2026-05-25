# Automated verification results

Captured 2026-05-20 during the AbortController refactor.

## 1. Listener-accumulation reproducer

Direct simulation of the listener-accumulation pattern observed in long
sessions (1500+ abort listeners on a single AbortSignal). The script lives
at `listener-accumulation-repro.mjs`.

```text
$ node docs/verification/abort-controller-refactor/listener-accumulation-repro.mjs
Simulating 2000 rounds for each pattern.

OLD pattern listener count on long-lived parent: 2000
NEW pattern listener count on long-lived parent: 0
PASS: OLD pattern accumulated >1500 listeners (reproduces the bug).
PASS: NEW pattern kept listener count at 0 — the helper prevents accumulation.
```

This is a self-contained proof: the OLD pattern (raw `addEventListener`
without `{once:true}` or reverse cleanup) accumulates 2000 listeners over
2000 rounds — well past the 1500 threshold the user observed. The NEW
pattern (`createChildAbortController` from `packages/core/src/utils/abortController.ts`)
keeps the parent listener count at 0 across 2000 rounds because each child's
reverse-cleanup listener removes the parent listener when the child aborts.

## 2. Migration scope (intentional)

Only the agent-runtime parent→child chain that actually accumulates listeners
on a long-lived parent signal is migrated to the helper:

- `packages/core/src/agents/runtime/agent-interactive.ts` (master + per-message round)
- `packages/core/src/agents/runtime/agent-core.ts` (per-iteration round + waitForExternalInputs + processFunctionCalls try/finally)
- `packages/core/src/agents/runtime/agent-headless.ts` (external → execution)
- `packages/core/src/hooks/promptHookRunner.ts` (had a real cleanup leak: manual addEventListener without `{once:true}` and never removed)

Plus three `{once:true}`-only fixes (no helper switch, just defensive
correctness):

- `packages/core/src/hooks/hookRunner.ts`
- `packages/core/src/hooks/functionHookRunner.ts`
- `packages/core/src/confirmation-bus/message-bus.ts`

Independent short-lived controllers (per-shell-command in `tools/shell.ts`,
per-monitor in `tools/monitor.ts`, per-arena-session in
`agents/arena/ArenaManager.ts`, per-recall in `core/client.ts`,
per-fetch in `utils/fetch.ts`, per-dream / per-title / per-judge / per-resume,
etc.) stay on raw `new AbortController()` — they're GC'd at end of use and
do not accumulate on a long-lived parent.

See `migration-completeness.txt` for the actual grep + rationale.

## 3. Affected test suites

All 71 affected test files / 2085 tests pass (3 skipped — 1 is the GC test
that requires `--expose-gc`, 2 are pre-existing skips in the headless suite).

```text
 Test Files  71 passed (71)
      Tests  2085 passed | 3 skipped (2088)
   Duration  16.71s
```

Coverage:

- `packages/core/src/utils/abortController.test.ts` — 26 tests: factory cap (default + custom), child propagation, reverse cleanup, fast path, undefined parent, custom-maxListeners passthrough, `combineAbortSignals` semantics (incl. cleanup-cancels-timeout, timeout-cleans-input-listeners, `timeoutMs <= 0` boundary, mid-iteration defensive check), GC safety (best-effort).
- `packages/cli/src/utils/warningHandler.test.ts` — 13 tests: idempotency, AbortSignal suppression (including `[AbortSignal{...}]` shape), generic EventTarget NOT suppressed, debug-mode passthrough, fan-out to prior listeners, spawned-child end-to-end stderr integration.
- `packages/core/src/hooks/httpHookRunner.test.ts` — covers the migrated `combineAbortSignals` consumer (the deprecated `createCombinedAbortSignal` shim plus its test file were removed once the lone caller migrated).
- `packages/core/src/agents/runtime/{agent-core,agent-interactive,agent-headless,agent-context,agent-statistics}.test.ts` — 102 tests covering the high-impact migrated files.
- `packages/core/src/core/openaiContentGenerator/**` — 280+ tests including the pipeline that lost the `raiseAbortListenerCap` band-aid.
- `packages/core/src/followup/**` — 100+ tests including the migrated speculation controller.
- `packages/core/src/tools/agent/**`, `packages/core/src/tools/shell.test.ts`, `packages/core/src/services/**`, `packages/core/src/hooks/**`, `packages/core/src/confirmation-bus/**` — all migrated tool/hook/service files.

## 4. TypeScript strict-mode typecheck

```sh
$ node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit
(no output, exit 0)

$ node_modules/.bin/tsc -p packages/cli/tsconfig.json --noEmit
(no output, exit 0)
```

## 5. Prettier formatting

```sh
$ node_modules/.bin/prettier --check packages/core/src/agents/runtime/agent-core.ts \
    packages/core/src/agents/runtime/agent-headless.ts \
    packages/cli/src/utils/warningHandler.ts \
    packages/cli/src/utils/warningHandler.test.ts \
    packages/core/src/utils/abortController.ts \
    packages/core/src/utils/abortController.test.ts
Checking formatting...
All matched files use Prettier code style!
```

## 6. Build + binary smoke test

```sh
$ npm run build:packages
(succeeds for all 5 workspace packages)

$ NODE_OPTIONS=--trace-warnings node packages/cli/dist/index.js --version
0.15.11
EXIT=0

$ node packages/cli/dist/index.js --help
Usage: qwen [options] [command]
...
```

No warnings emitted during boot with `--trace-warnings`.

## 7. Codex independent review

Two full passes via the `codex:codex-rescue` agent (independent context each
time). First pass surfaced 3 issues — all addressed in subsequent commits:

1. **Throw between controller creation and explicit abort leaks listener** in
   `agent-core.ts`'s per-iteration body and `agent-headless.ts`'s
   pre-try-block setup. Fixed by wrapping each in `try { ... } finally {
abortController.abort(); }`.
2. **Warning suppressor regex `EventTarget` too broad**. Tightened to match
   only `AbortSignal` (any shape Node ≥20 produces).
3. **`process.removeAllListeners('warning')` strips third-party listeners**.
   Removed — rely on Node's "no listeners → default printer fires" semantics
   so adding our handler implicitly disables the default print path while
   keeping third-party telemetry listeners intact.

Second pass confirmed all fixes correct, no further blockers.

## What remains for interactive verification

The scenarios in `README.md` numbered 00–09 require a real interactive
session against the model API (long mixed-tool conversations, Ctrl-C
mid-stream, subagent cancellation, heap snapshots). Those are documented
for human execution and the transcripts should be attached to the PR body
when run.
