# Auto-memory failed extraction write recovery and window suspension

[English](auto-memory-failed-extraction.md) | [简体中文](auto-memory-failed-extraction.zh-CN.md)

Status: implemented write recovery and an opt-in failed-window attempt bound for #13158 R1-3; full cost and backlog acceptance remain open.

## Problem and scope

A fork can write a valid memory file before failing or being cancelled. Its result retains successful `filesWritten`, but the extraction planner throws before mapping them to memory topics and scopes. The document remains on disk without a rebuilt index, and the manager does not record user-memory mutation. A successful fork followed by an index or cursor-write error similarly loses its known write scope.

Recover reported writes without advancing a failed extraction's cursor. Apply the same durability rule to the default and experimental window paths. Keep existing window selection, per-fork budgets, cooldown, queue and drain behavior. With the existing cooldown experiment enabled, suspend the same selected window after three consecutive failed extraction attempts, including trailing queued requests.

An established cursor keeps selecting the oldest pending window after failure. Growing history can therefore repeatedly pay for the same failed selection. A fresh cursor without an attested history identity can instead select a newer real user turn; a whole-session failure cap would block that existing recovery.

## Decision

Use a typed Error carrying the existing mapped execution result. Reuse the current memory-root classifier and successful-write accounting; reads and denied writes are not mutations. Extract rebuilds affected indices and refreshes the live memory instruction before rejecting a failed fork. It does not record successful extraction metadata or write the cursor for that failure.

Reuse the existing project-index error propagation and best-effort user-index policy. Preserve the execution result through post-fork failures. When recovery itself fails, retain both the fork failure and recovery failure with `AggregateError`. The manager records actual user-memory mutation and touched topics while keeping the task and telemetry status failed. User-mutation bookkeeping retains its existing best-effort behavior.

Reuse the selector's pre-await start and end history hashes as the window identity. The manager supplies one window-eligibility callback through the shared extraction entry and captures that identity for failure accounting. A process-local project/session counter permits three consecutive failures of an unchanged selection. The fourth request returns `failure_limit` with the persisted cursor and no planner call; it does not write a cursor or mark successful extraction. Skips preserve the streak, a changed selection remains eligible, and non-skipped success or a default-off operation clears that tuple. Other project/session results cannot clear it. The existing Error and write-result contracts remain unchanged, including throws without write evidence.

## Constraints and risks

Only reported successful writes can be attributed to the fork. A thrown fork without a result carries no write evidence. Indexing uses the existing document validation; a malformed partial file does not become valid merely because the fork reported it. User-index rebuild failure remains best-effort and does not prove user recall availability. Live memory instruction refresh also remains best-effort: its existing helper catches and warns on underlying refresh errors, so those errors do not reach the typed failure context. Index recovery does not prove live prompt refresh succeeded. The original failed cursor is retained, so the same history can be retried.

The attempt bound applies to one unchanged selection within one manager while the experiment is enabled. Restarting or switching off the experiment permits retries; a changed window starts its own consecutive streak. It is not a limit on total session calls, tokens or provider billing. Existing configurable per-fork budgets remain in effect. A suspended oldest window can still leave later facts pending: neither this bound nor write recovery moves past that window, schedules remaining history, replays discarded history across sessions, or establishes model quality or token savings. Those requirements remain open. Skipping a failed window on the assumption that no file was written is unsafe.

## Validation and acceptance

Verify mapped project/user writes on a failed fork, read-only exclusions, affected index rebuilds and instruction refresh, unchanged cursor and successful-extraction metadata, preserved failure causes and scope when recovery fails, and manager user-mutation bookkeeping with failed status. Retain the existing success, default/opt-in, user-index isolation, cursor holdback and queue/drain regressions.

Verify three same-window failures followed by a skipped fourth request, including one genuinely queued before the third fails. Check unchanged cursor bytes, explicit skipped task/telemetry, fresh-bootstrap eligibility for a new user window, successful reset, project/session isolation and default-off retries. A matched controlled compiled case first reads its owned index to establish a native cursor, then reproduces four failed forks before the fix and three after it. Retain a later raw user fact beyond the window without claiming it was extracted. This observes attempt counts, not real model cost.

Build, bundle, typecheck and run affected tests. The completed controlled write-recovery case actually wrote valid files in owned project and user roots, failed, and showed regenerated indices and user mutation without cursor advancement. Do not rerun it merely to relabel the source. Provider execution, representative memory quality, total retry cost and later-history reachability require separate acceptance.
