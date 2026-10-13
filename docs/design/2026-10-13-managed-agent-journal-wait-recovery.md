# Managed Agent Journal-Wait Recovery

[English](2026-10-13-managed-agent-journal-wait-recovery.md) | [简体中文](2026-10-13-managed-agent-journal-wait-recovery.zh-CN.md)

Status: Implemented by the change that accompanies this document.

## Problem

A Hosted tool round can contain only control-plane calls: a background Agent or Workflow launch, a Session message, or a lead-side team/task operation. These calls write durable domain records but create no Runtime binding. The Harness therefore skips `commitAwaitRuntimeBatch`, while background launches also skip the foreground `await_agent` checkpoint. If the Harness exits after one domain write and before the next checkpoint, replacement recovery sees `model_start` or `unresolved_after_settle`, declines the Turn, and leaves the lead Session permanently blocked. The durable answer helpers cannot run because takeover is rejected first.

## Goals

- Make a zero-Runtime control-plane batch recoverable before its first domain write.
- Answer committed calls from durable records and unreached calls as never run without repeating side effects.
- Preserve the same behavior for default and yolo approval modes, Hooks Sessions, team/task calls, and unnamed or named background launches.
- Keep foreground child waits, member command waits, and Runtime-backed batches on their existing specialized checkpoints.

## Design

The Harness checkpoint schema adds `await_journal` and a `journalWait` group. The group records each protected function call's `functionCallId` and `toolName`; it carries no mutable business result. A zero-Runtime batch whose calls do not require the existing foreground Agent or member-command wait commits this group with `HARNESS_DURABLE_WAIT_BOUNDARY` before the first call can write a child, team, task, workflow, or message record.

When the live batch has committed all tool results and completed its PostTool Hooks, it resolves the journal wait to `model_output_committed`. The resolved checkpoint continues to carry the group. This makes a second crash after resolution recognizable and lets a replacement activation adopt the Turn before starting the next model round.

Recovery reports `await_journal` without acquiring a Runtime lease. Each recorded call is a known journal execution: `executing` while the wait is open and `settled` after it resolves. The continue path calls the existing `answerResumedTurnCalls` helper, which derives the truthful response from child/team/task/message journals, fills unreached calls with the existing never-run response, and skips already journaled tool results. It then resolves or re-adopts the journal wait and resumes the model from the completed tool-result round. Cancellation uses the same journal-derived answers, resolves the wait, and writes the cancelled terminal record.

Hooks Sessions may use the same continue and cancel routes only when the pinned checkpoint is a journal wait. Recovery restores the existing Hook owner and reuses the current occurrence identities, so PostToolUse and PostToolUseFailure remain idempotent. The journal wait is resolved only after those Hooks complete.

Runtime-backed batches keep `await_runtime`; foreground Agent and Workflow calls keep `await_agent`; member commands keep `await_command`. The generic journal wait is not created for a batch containing one of those specialized waits, avoiding competing durable boundaries.

## Failure Semantics

- An identical journal-wait commit is replay-safe; a different call set conflicts.
- The checkpoint precedes all protected domain writes. The remaining admission-to-checkpoint window of the specialized foreground waits is unchanged.
- A transient checkpoint read or journal write failure remains retryable and never becomes a fabricated terminal result.
- An unknown phase, malformed group, mismatched Turn, or unsupported Hook state remains blocked.
- Recovery never replays a committed child/team/task/message operation. Durable records decide its response.

## Validation

- Unit-test checkpoint parsing, phase invariants, replay, resolution, carried-group adoption, and conflicts.
- Re-run the controlled background-child crash reproduction and assert takeover continues, the original Turn settles, a later load succeeds, and the child result is accepted once.
- Cover named member join before and after the crash, lead `task_create`/`task_update`, Hooks, yolo, cancellation, and the resolve-then-crash window.
- Run focused TypeScript build/typecheck/tests and Java client/coordinator tests, then one native Hosted/MySQL crash arm when the host provides Java and Docker.

## Acceptance Criteria

After a Harness crash anywhere after the journal wait commits, a replacement can continue or cancel the same Turn. Committed calls receive their original durable answer, unreached calls receive a never-run answer, no domain operation is duplicated, the lead Session accepts later Turns, and a completed child can attach and deliver its result.
