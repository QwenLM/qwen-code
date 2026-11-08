# Hosted continuation after an interrupted background wake

[English](2026-10-19-hosted-wake-continuation.md) | [简体中文](2026-10-19-hosted-wake-continuation.zh-CN.md)

Status: implementation in this change; verification results belong in the PR.
Tracks [#14047](https://github.com/QwenLM/qwen-code/issues/14047).

## Problem and scope

A replacement Harness can recover a committed tool answer and settle the
interrupted child-result or monitor notification. The wake pump then has no
input left. The model never reads the answer until another input arrives.
Automatic Session loading from #14116 does not supply that next model turn.

Continue these notifications after their crash aftermath. Keep channel
settlement, Automation failed/unknown outcomes, Session-message stop policy,
foreground takeover, and individual tools' recovery decisions unchanged.
This does not migrate notifications already settled by an older release.

## Durable handoff

After answering committed calls and settling existing Runtime obligations,
the Harness admits an internal input **before** settling the interrupted
turn. Its ID is `wake-recovery:<sha256(interruptedTurnId)>`; the admission
command uses that same stable ID. Existing committed admission is reused.
The input retains the original `monitor`, `child_agent`, or `workflow`
source, so the existing wake discovery, writer fence, pump, and lifecycle
settlement own it. No schema, public endpoint, or new source is needed.

The small input resource contains an instruction, `interruptedTurnId`, and
`notificationTurnId`. The latter always identifies the root notification.
Its original resource supplies the notification text when the pump reads
the continuation; the payload is not copied or recursively wrapped.
Resource read failures follow the pump's transient-read retry. Invalid
identity or source fails closed.

If admission fails, the old input stays pending and recovery stays blocked.
If the process dies after admission but before settlement, the next owner
reuses that admission and finishes the aftermath. If it dies after the
settlement, the pending continuation itself supplies the next wake.

## Model execution and idempotency

The old turn is never executed again. The continuation runs a fresh turn
with committed history, recovered tool answers, and the original
notification. It tells the model to inspect durable state before retrying
unknown effects. Recovery does not dispatch tools or infer success from
an unknown outcome. Tool approval, Workspace access, and turn budgets
still use the normal execution path.

The continuation writes the existing `turn_attempt` system record instead
of another user record. This both preserves the one-user-record guarantee
and proves a started continuation after another crash. Every interrupted
continuation has one deterministic successor, still referencing the root
notification. Ordinary model errors/cancellation do not create successors.
Continuation call keys are bounded like other wake-call keys, so a resumed
leader can launch or continue a member without growing lineage IDs.

A completed continuation consumes the original child's acceptance; an
errored, cancelled, or blocked one does not claim delivery. A queued
continuation closes model-free through its existing source. The settlement
log names the durable continuation to distinguish recovery from a permanent
block. Scheduling does not depend on the number of recovered answers:
an interrupted `send_message` with no reconstructable answer still needs
a model decision.

## Validation and acceptance

- Reproduce the silence on current main with real Spring/MySQL and a
  replacement Harness. Attempt the globally installed CLI first and record
  any build limitation separately.
- Verify admission-before-settlement, retries after failed admission,
  reopening in that gap, repeated interruption, bounded original context,
  source exclusions, queued close, and child consumption with focused tests.
- On the fixed bundle, observe a model request reading recovered answers
  without external input, with one original user record and one committed
  effect. Restart again and verify no additional request or effect.
- Probe an interrupted member continuation while another member is running;
  require one `continueChildRun`, independent of later notifications. Keep
  scripted fault-state injection distinct from live mid-tool fault injection.
- Run the root build/typecheck, affected package tests, and independent E2E
  verification. Report unavailable platforms and disabled `team_plan` probes
  explicitly; a monitor witness alone is not full P3a/P3W acceptance.
