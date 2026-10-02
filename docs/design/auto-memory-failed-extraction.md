# Auto-memory failed extraction write recovery

[English](auto-memory-failed-extraction.md) | [简体中文](auto-memory-failed-extraction.zh-CN.md)

Status: implemented correctness fix for #13158 R1-3; failure cost and backlog acceptance remain open.

## Problem and scope

A fork can write a valid memory file before failing or being cancelled. Its result retains successful `filesWritten`, but the extraction planner throws before mapping them to memory topics and scopes. The document remains on disk without a rebuilt index, and the manager does not record user-memory mutation. A successful fork followed by an index or cursor-write error similarly loses its known write scope.

Recover reported writes without advancing a failed extraction's cursor. Apply the same durability rule to the default and experimental window paths. Keep existing window selection, budgets, cooldown, queue and drain behavior.

## Decision

Use a typed Error carrying the existing mapped execution result. Reuse the current memory-root classifier and successful-write accounting; reads and denied writes are not mutations. Extract rebuilds affected indices and refreshes the live memory instruction before rejecting a failed fork. It does not record successful extraction metadata or write the cursor for that failure.

Reuse the existing project-index error propagation and best-effort user-index policy. Preserve the execution result through post-fork failures. When recovery itself fails, retain both the fork failure and recovery failure with `AggregateError`. The manager records actual user-memory mutation and touched topics while keeping the task and telemetry status failed. User-mutation bookkeeping retains its existing best-effort behavior.

## Constraints and risks

Only reported successful writes can be attributed to the fork. A thrown fork without a result carries no write evidence. Indexing uses the existing document validation; a malformed partial file does not become valid merely because the fork reported it. User-index rebuild failure remains best-effort and does not prove user recall availability. Live memory instruction refresh also remains best-effort: its existing helper catches and warns on underlying refresh errors, so those errors do not reach the typed failure context. Index recovery does not prove live prompt refresh succeeded. The original failed cursor is retained, so the same history can be retried.

This correction does not bound repeated failures, move beyond a failing window, schedule remaining history, replay discarded history across sessions, or establish model quality or token savings. Those requirements remain open. Skipping a failed window on the assumption that no file was written is unsafe.

## Validation and acceptance

Verify mapped project/user writes on a failed fork, read-only exclusions, affected index rebuilds and instruction refresh, unchanged cursor and successful-extraction metadata, preserved failure causes and scope when recovery fails, and manager user-mutation bookkeeping with failed status. Retain the existing success, default/opt-in, user-index isolation, cursor holdback and queue/drain regressions.

Build, bundle, typecheck and run affected tests. A controlled compiled-runtime case must actually write valid files in owned project and user roots, fail, and show regenerated indices and user mutation without cursor advancement. This proves write recovery only; provider execution, representative memory quality, bounded retry cost and later-history reachability require separate acceptance.
