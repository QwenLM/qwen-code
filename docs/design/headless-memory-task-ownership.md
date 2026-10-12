# Headless memory task ownership

[English](headless-memory-task-ownership.md) | [简体中文](headless-memory-task-ownership.zh-CN.md)

Status: implemented in PR #13885; maintainer review required.

## Problem and scope

A headless turn must stop waiting promptly when cancelled, without losing the shared tracking of unfinished extraction, dreaming, or skill-review tasks. Destructively consuming the list before an interrupt discards that tracking. A later turn or normal stdin EOF then cannot await the work.

This change preserves result timing, cancellation and budget outcomes, and the existing TUI `memory_saved` delivery. It adds neither a task cancellation API nor a drain timeout. Metadata migration remains outside this list.

## Ownership and settlement

`LlmClient.getPendingMemoryTaskPromises()` returns a copy without transferring ownership. `removePendingMemoryTaskPromises()` removes only the supplied promise identities from the current queue. Newly appended tasks survive removal of an older snapshot.

The shared headless waiter immediately attaches fulfillment and rejection observers to every snapshot entry. These observers record settlement without emitting events. The waiter races all observed tasks against its caller's abort signal, and removes its listener in `finally`.

On normal completion, all snapshot entries are settled and removed. On interruption, only entries observed as settled are removed; unfinished entries remain in the client queue. There is no requeue operation, so an interrupted waiter cannot restore completed work or reinsert tasks consumed by another owner.

`consumePendingMemoryTaskPromises()` retains its existing destructive behavior for the TUI. It transfers the count promises to the TUI notification handlers once. A later headless removal is idempotent and cannot duplicate a `memory_saved` event. Tasks are not automatically removed on settlement, because the TUI still needs their resolved counts.

## Session shutdown

Normal EOF first waits for queued turns and control requests, then uses the same waiter for retained memory work before finishing shutdown. It uses the session abort signal rather than an interrupted turn's signal. A signal during this EOF wait ends the wait and still runs shutdown cleanup. An already-aborted session or error-driven shutdown does not start a new memory wait.

Each wait operates on one snapshot. Turn processing supplies the tracked tasks before normal EOF starts its final wait; promises nested by extraction or dreaming remain part of their original tracked promise. New entries added during a wait remain available to a subsequent waiter.

## Validation and acceptance

- Two real runner invocations share the actual queue methods: the first returns 130 while memory remains pending, and the second cannot finish until that same task settles. Cover interruption before and during the wait, rejected/completed entries, and newly appended work.
- Queue tests verify snapshot copies, removal by identity, preservation of new work, and one-time TUI count consumption after another waiter removes stale identities.
- Session tests and a built CLI control-interrupt replay verify normal EOF waits for retained work and remains cancellable. Results and notification counts must not duplicate; rejection observers and abort listeners must not leak.
- Mutations that remove unfinished tracking or skip the EOF wait must fail. Run affected suites, build/bundle, types, formatting, lint, and independent review. Keep historical full-suite failures and external-replay limits disclosed.

The new cross-package queue API and invocation-lifetime contract require maintainer agreement before merge.
