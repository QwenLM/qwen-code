# Headless memory task ownership

[English](headless-memory-task-ownership.md) | [简体中文](headless-memory-task-ownership.zh-CN.md)

Status: implemented in PR #13885; maintainer review required.

## Problem and scope

A headless turn must stop waiting promptly when cancelled, without losing the shared tracking of unfinished extraction, dreaming, or skill-review tasks. Destructively consuming the list before an interrupt discards that tracking. A later turn or normal stdin EOF then cannot await the work.

This change emits the headless terminal `result` in JSON and stream-JSON output before waiting for tracked memory tasks. One-shot invocation completion and reusable stream-JSON turns while stdin remains open still wait for those tasks. Normal stream-JSON stdin EOF starts a shared 5000 ms grace period for memory waiting. Cancellation and budget outcomes and the existing TUI `memory_saved` delivery are preserved. It adds no task cancellation API. Metadata migration remains outside this list.

The emitted `usage` in both JSON formats and `stats` in successful JSON output are snapshots taken before the drain. They omit memory usage recorded during that wait, and completing the memory tasks does not update the emitted result. These totals therefore do not guarantee complete invocation accounting; see [Managed Memory Completion](../users/features/headless.md#managed-memory-completion).

## Ownership and settlement

`LlmClient.getPendingMemoryTaskPromises()` returns a copy without transferring ownership. `removePendingMemoryTaskPromises()` removes only the supplied promise identities from the current queue. Newly appended tasks survive removal of an older snapshot.

The shared headless waiter immediately attaches fulfillment and rejection observers to every snapshot entry. These observers record settlement without emitting events. The waiter races all observed tasks against its caller's abort signal and, for reusable stream-JSON sessions, a separate memory-wait deadline signal. It removes its signal listeners in `finally`.

When the snapshot settles, all its entries are removed. On interruption or deadline expiry, only entries observed as settled are removed; unfinished entries remain in the client queue. There is no requeue operation, so a waiter cannot restore completed work or reinsert tasks consumed by another owner. Deadline expiry returns normally and reports that waiting stopped; it does not report that all tasks settled. A real cancellation or budget abort retains its existing outcome, including when it coincides with deadline expiry.

`consumePendingMemoryTaskPromises()` retains its existing destructive behavior for the TUI. It transfers the count promises to the TUI notification handlers once. A later headless removal is idempotent and cannot duplicate a `memory_saved` event. Tasks are not automatically removed on settlement, because the TUI still needs their resolved counts.

## Session shutdown

Normal EOF releases the session's memory-wait deadline signal immediately: a wait already holding `processingPromise` open stops waiting, and every memory wait that begins in the remaining turns returns without waiting, keeping the unfinished task identities. The queued turns and control requests then complete without a memory bound — the window bounds memory waiting, not foreground work. When that work settles, the final retained-memory wait opens one fresh 5000 ms window. There is deliberately no absolute deadline measured from EOF: a window armed at EOF would be spent by the foreground work itself, and every wait beginning after it would enter the signal already released and wait nothing.

Expiry stops memory waiting without aborting foreground turns, cancelling tasks, changing the result, or selecting a cancellation exit code. If the window expires before a foreground turn emits its result, that turn still completes normally and its later memory wait returns without a new delay. The final wait uses the session abort signal rather than an interrupted turn's signal. A signal during this wait still ends it and runs shutdown cleanup. An already-aborted session or error-driven shutdown does not start a new memory wait.

The final window's timer is cleared on completion, cancellation, or error, including errors while awaiting pending work. Signal listeners are removed, and normal settlement, window expiry, or cancellation during the wait each reaches shutdown cleanup once. Existing error recovery remains unchanged. One-shot invocations have no session EOF moment. Their failure and cancellation terminals each arm a 5000 ms window; the success terminal instead waits for the memory writes its own turn started, bounded only by the run's abort signal — the base behavior, so no wait deadline is introduced on the success path. Sessions whose stdin remains open wait within their turns under the session's deadline signal.

The 5000 ms value is a best-effort shutdown policy, not a guarantee that memory updates finish within that time. It bounds each memory-wait window, not the complete interval from EOF to process exit: initialization, control requests, foreground model work, recording, output flushing, disposal, and exit cleanup can still take longer.

Each wait operates on one client snapshot. New entries remain available to a subsequent waiter while the process is alive; separately queued extraction successors are not necessarily represented by that snapshot. Snapshot settlement does not prove that the memory manager is idle or that every write succeeded. Retained promise identities are in-memory tracking, not a durable queue or a promise to resume work in a later process. Process exit can abandon unfinished memory updates, including writes still in progress.

## Validation and acceptance

- Two real runner invocations share the actual queue methods: the first returns 130 while memory remains pending, and the second cannot finish until that same task settles. Cover interruption before and during the wait, rejected/completed entries, and newly appended work.
- Queue tests verify snapshot copies, removal by identity, preservation of new work, and one-time TUI count consumption after another waiter removes stale identities.
- Session tests and built CLI replays verify EOF both during an active turn's memory wait and with only retained work, including foreground work that outlasts any absolute deadline: the released in-turn waits keep their task identities, and the final window's expiry releases the retained path without a replacement result or foreground cancellation. Cover expiry before terminal output, real abort/window races, partial settlement, newly appended work, and late rejection. Timers and signal listeners must be cleaned up, shutdown must run once, and results and notification counts must not duplicate.
- Preserve one-shot and open-stdin waiting, SIGINT and budget outcomes, output-failure behavior, and the pre-drain accounting contract. A one-shot run must settle with its original error outcome once a drain window expires, the unfinished task staying tracked. A delayed-memory built CLI replay must distinguish early result delivery from bounded memory waiting.
- Mutations that remove unfinished tracking, skip the EOF wait, remove its deadline, or omit the active-turn deadline connection must fail. Run affected suites, build/bundle, types, formatting, lint, and independent review. Keep historical full-suite failures and external-replay limits disclosed.

Two preservation regression scenarios adapt ideas from [TYY-2005's PR #13886](https://github.com/QwenLM/qwen-code/pull/13886): terminal-output failure after normal model completion must still wait for memory and preserve the original output error; missing structured output with fulfilled and rejected memory tasks must emit one error result and return 1. The tests also check distinct retry errors and a one-time output-flush failure.

The new cross-package queue API and invocation-lifetime contract require maintainer agreement before merge.
