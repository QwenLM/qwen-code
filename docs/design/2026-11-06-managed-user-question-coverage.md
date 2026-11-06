# Managed child questions and releasing execution membership while waiting

[English](2026-11-06-managed-user-question-coverage.md) | [简体中文](2026-11-06-managed-user-question-coverage.zh-CN.md)

Status: accepted implementation design, not runtime acceptance evidence. Investigated at `ee1a9b1e`; implementation starts from `478c2f87ab61c12f0548041af1e65e054bea549d`. Extends the [existing question protocol](2026-11-06-managed-user-questions.md).

## Problem and scope

Ordinary local Workspaces already admit multiple execution members. Sharing a directory does not inherently serialize siblings. The gaps are public-child question admission, the single automatically selected WebShell Action, and unnecessary execution membership during human waits.

Support ordinary local files/Shell roots and built-in depth-1 public children. Multiple questions may wait concurrently and users may answer any first. Running background commands do not prohibit questions; retain their real occupancy rather than stopping them. SSH, resident, MCP, Hooks, Team members, workflows, snapshots, extension-defined and deeper children remain excluded.

Keep one question per tool batch, profile allowlists, absolute expiry/Turn deadlines, depth 1, four active children and 64 lifetime launches. Waiting children count as active. Root Plan remains within existing admission. Questions, answers and results belong to the originating Session; the parent aggregates them and cannot answer through its model.

## Execution and recovery

Acquire normally, verify actual `local-process` binding, and require known preceding outcomes and settled Session-local file-history operations. Persist original input, native continuation and final cleanup debt, including Shell. Commit the question Action before releasing membership with the captured mount claim.

Handback leaves the Runtime READY with its installation, identity and renewal. Busy background/control operations retain real occupancy while the question remains answerable. Lost replies remain uncertain and retry the same claim. Reuse 1/3/5/10/30/60-second backoff capped at 60 seconds and a two-second initial wait bound. Answer, cancellation, expiry, writer loss and close stop retries. Late replies can update memory only while their captured claim remains current.

After a durable answer, expected acquire revalidates binding, Runtime generation, Workspace generation and provider before producing the original result and continuing. Refresh Workspace instructions without resetting file-history fingerprints or overwriting sibling edits. Reacquire supersedes old claims.

New qualified cold questions recover the original owner/claim before waiting and attempt handback. Reuse that Broker in ToolTurn and skip ordinary warm, which could provision another binding. Follow the latest checkpoint, reusing durable answers/results without replaying previous tools or obsolete model attempts. Changed/missing owners or unproven writers remain blocked. Cancellation/expiry does not reacquire solely to terminate.

## Contracts and compatibility

Internal warm/acquire responses expose actual binding `runtime.provisionerKind`. Store it separately from the Broker's three-field runtime identity and explicitly assemble durable records; capability digest and foregroundOnly cannot identify provider.

New qualified single-question native continuations may include `runtime.provisionerKind: "local-process"`. TS and Java strict readers validate it and reject other calls or unsupported combinations. Records without it retain old wait/recovery ordering. Keep schema version 1, question options v4, answer v2, public HTTP APIs and database tables unchanged.

Deploy readers before writers; rollback after new writes must retain compatible readers. The pin grants no ownership: expected acquire still validates actual identity. Declaration and execution share persisted public-child v1, depth-1, built-in identity and provider qualification; depth alone is insufficient.

## Cleanup and background holds

Membership handback does not discharge final cleanup. Preserve durable owed-to-confirmed semantics. Reconciliation additionally classifies a legitimate background hold only after exact `409 runtime_session_held` from routine release of the saved owner and matching durable Shell/Monitor evidence. Keep debt owed and transfer responsibility to Session-level background management; only actual release writes confirmed.

Match cleanup descriptor, binding/generation and Runtime Session through the execution's durable tool-input envelope, not command arguments alone. Unknown/blocked records remain blocking. Pure status revalidates scoped classification and committed sequence without release/acquire. Historical active-holds inventory restores drain responsibility only. Cold load obtains fresh classification through cleanup reconciliation.

Consume classification in ordinary cleanup, retries, original-owner recovery and held-runtime release; register held responsibility after cleanup. Close can advance to drain for proven holds but must reconcile actual release before completion.

## WebShell interaction

Show all pending questions and permissions in a compact list above one form, with root/child source, title, type and expiry. Default to oldest pending, tie-breaking by Session/Action. New arrivals and polling never steal selection; advance only when the selected item ends.

Submit full target Session/Action identity and current revisions. Scope drafts, in-flight state and errors by page owner, target and revisions. Switching preserves drafts; terminal/revision/owner changes clear them. Keep drafts in page memory only. Refresh restores pending questions and accepted answers, not unsent text. A's failure must not disable B.

The parent selector is the sole answer entry; child transcripts stay read-only. Preserve per-child authorization and distinguish answer acceptance from resumed execution.

## Validation and delivery

Test real concurrent A/B questions, B answered first, sibling file tools, member counts, retained background work, lost/late handback, cancellation/expiry races, Harness/Java restart cuts, answer-before-result crashes, changed-owner refusal and file-fingerprint conflicts. UI tests cover stable selection, independent drafts/errors, pagination, compound targets and account/root changes. Retain negative admission and child limits. Synthetic Actions prove UI/routing only.

Implement compatible contracts/readers and cleanup classification, runtime admission/handback/recovery, then UI and real-process verification. Run affected package tests and root build/typecheck/bundle. The shared Java budget started this increment at 539.576 of 600 seconds used, with 60.424 seconds remaining. The E2E evidence records subsequent consumption; new commits and review rounds do not reset it. Full Maven/SpotBugs/MySQL/Hosted/fault gates remain CI responsibilities. Report gaps and complete two clean self-audit passes. E2E evidence is recorded in `.qwen/e2e-tests/managed-user-question-coverage.md`. SSH/resident and MCP/Hooks require separate qualification.
