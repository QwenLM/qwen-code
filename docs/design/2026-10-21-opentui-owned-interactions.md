# OpenTUI owned interaction lifecycle

[中文](2026-10-21-opentui-owned-interactions.zh-CN.md)

## Scope

This batch migrates command/shell recall, cancellation ownership, queued structured input, prepared Retry, countdown skip and natural quit/exit presentation. Resume/replay/rewind and checkpoint creation/restoration remain separate dependent batches.

## Ownership

A command acquires its cancellation controller before awaiting durable recall. After that await it verifies session/controller ownership; cancelled or superseded work must not execute. Recursive confirmations do not log a second invocation. Bare quit aliases do not replace the latest recalled prompt. Shell controllers remain cancellable until their own settlement; late completion must not clear a successor. Local shell keys yield to model turns, dialogs and approvals.

Model turns retain their generation, prepared payload and structured queued input. Accepted steering and cancellation log rollback stay in the same owner. Retry reuses prepared media/file content, does not log or echo another user input, skips only one active countdown and cannot run through an owned shell/command lane. Existing per-attempt prompt-ID policy differences remain observational scope; this batch does not change core ID allocation.

Quit cancels pending work and commits the supplied summary before normal exit. Its private closing snapshot is separate from transcript/canonical checkpoint restoration.

## Acceptance

Verify the actual combined candidate with normal build/typecheck, complete affected CLI files, native input ownership and real NodeInk/BunInk/strict cancellation/Retry/held-shell/quit contracts. Bind each result to its source and bundle; retain first failures, platform skips and unexecuted gates in the PR E2E report. Historical combined-tree results do not qualify a newly extracted candidate. Final installed/runtime/platform rollout remains a separate migration acceptance gate.
