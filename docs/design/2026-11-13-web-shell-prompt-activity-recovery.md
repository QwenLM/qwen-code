# Web Shell prompt activity recovery

[English](2026-11-13-web-shell-prompt-activity-recovery.md) | [简体中文](2026-11-13-web-shell-prompt-activity-recovery.zh-CN.md)

## Problem

An observer can attach before another client starts a prompt, so its initial
`hasActivePrompt` snapshot is false. Live events and a matching activity poll
then establish that the prompt is running. If activity coverage disappears,
the existing backstop settles the observer immediately. An unrelated owner
can also overwrite the cached activity and let a later SSE close settle it.
A subsequent active poll deliberately does not revive an idle prompt, leaving
the provider idle during a silent task. This is the reproduced part of #17005;
it does not establish the cause of the original hosted incident.

## Scope

Repair observer activity recovery in Web Shell. Keep the existing daemon
protocol, normal Last-Event-ID resume, local prompt ownership, terminal
handling, and silence heuristic for hosts that never supplied live activity.
Gateway limits, runtime deployment, epoch-reset behavior, and reconnect
observability are separate work.

## Decision

Ignore activity samples for an unrelated owner while the current connection
still belongs to its attached session. Continue accepting a target's sample
while a session switch is loading that target.

When a running observer loses previously matching active authority, use the
existing same-session load operation to reconcile it. Keep the prompt status
and visible transcript while that load is pending. Mark this internal load as
activity reconciliation so non-terminal SSE settlement also preserves it.
The replacement load snapshot becomes authoritative for activity, including
when it reports no active prompt. A later live poll does not independently
revive a completed prompt.

An inactive live observation received while recovery is pending ends the
indicator immediately and outranks the older load or active poll response.

Reuse the existing load identity, ownership checks, request deadline, and
watchdog. If the current recovery fails, surface the normal load error and
release its running indicator. A superseding session switch or newly
submitted local prompt must not be settled by that old failure. No new public
option, daemon route, retry loop, or persistent state is needed.

## Constraints and risks

Activity coverage loss now causes one full session load instead of immediate
idle settlement. Normal successful polling and SSE cursor resume remain
unchanged. The load must preserve the transcript and use the resolved session
context, including standalone sessions. Cached live activity must not override
the replacement snapshot. Old samples and failed loads must not affect a new
owner or revive an already finished turn.

## Validation and acceptance

- Before the fix, the observer regression must fail on premature idle.
- A running observer remains busy while recovery is pending and after a fresh
  active snapshot, without requiring another business event.
- A fresh inactive snapshot ends the indicator even if an older active poll
  arrived while the snapshot was loading.
- Inactive live state received during recovery also wins over a delayed active
  snapshot and poll.
- Mismatched workspace/session samples do not erase the current authority.
- Failed or timed-out recovery ends with a visible load error, while a
  superseding owner or new local prompt remains unaffected.
- Existing local/restored prompt, terminal, stale-poll, and legacy-silence
  tests continue to pass. Build, typecheck, and focused suites must pass.
- Browser verification uses the real App and activity bridge where possible;
  a mocked daemon is disclosed and is not production incident verification.
