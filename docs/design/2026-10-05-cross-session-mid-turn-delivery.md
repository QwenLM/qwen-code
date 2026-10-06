---
title: 'Cross-Session Mid-Turn Delivery'
date: '2026-10-05'
status: 'implemented'
---

# Cross-Session Mid-Turn Delivery

[English](2026-10-05-cross-session-mid-turn-delivery.md) | [简体中文](2026-10-05-cross-session-mid-turn-delivery.zh-CN.md)

## Problem

Base cross-session messaging delivers an accepted peer message only when the
receiving session reaches Idle. A long agentic task — back-to-back tool rounds
that never return to Idle — therefore holds every incoming steer, including a
"stop and re-check the lease", until the whole task ends. The wire already
carried `priority` ("now" / "next") but the receiver ignored it; the protocol
doc described it as reserved for a future interrupt path.

Loosening delivery mid-turn is dangerous in a specific way: a peer carries
none of this session's user authority, so an unattended mechanism would let
another session — or a script a prompt-injected tool output convinced the
model to run — steer a running turn while the user is not watching.

## Goals

- Let a sender that marked `"now"` steer the receiver's running turn at a
  tool-round boundary, only when the receiver's operator opted in.
- Keep the user in the loop structurally: delivery lands between tool rounds
  (never mid-request), never overtakes the receiver's own queued input, and
  never interrupts a Goal turn.
- Bound the cost a peer can impose: a ceiling on envelopes steered per window,
  and no silent throttling — the user sees one pause line per window.
- Lose nothing: an envelope not delivered now is delivered at the turn
  boundary; a batch whose submission failed goes back to the queue intact.

## Non-goals

- Interrupting an in-flight model request (no cancellation mid-stream).
- Sender-controlled urgency: `"now"` is a request; the receiver's settings,
  queue state, and Goal ownership decide.
- A receipt distinguishing a granted steer from a deferred one: `delivered`
  keeps meaning "queued for the model", and the wire must not leak receiver
  policy to the sender.

## Proposed solution

Two new settings, both tighten-only for workspaces:
`agents.crossSessionMidTurn` (boolean, default `false`) and
`agents.crossSessionMidTurnBudget` (integer ≥ 0, default `3`, read through
`peerMidTurnBudgetOf`, which maps anything unreadable to the default and `0`
to off).

At each tool-round boundary in `use-llm-stream.ts`, after steer and teammate
drains, the peer drain takes at most one envelope (`drainPeers(1)`). The
envelope passes the same recipient re-check as the idle drain
(`drainQueuedFrame`, which settles stale pins with a `misaddressed` receipt)
and joins the tool-result submission, so `function_response` blocks still
lead the user content. Four gates exclude it — null drain (off, or no inbox),
Goal turn owning the session, detached continuation, cancelled continuation —
and every exclusion leaves the envelope queued, never dropped.

Ordering is governed by one barrier rule, mirrored on both paths: user text
queued behind a waiting envelope never overtakes it. On the idle path
`popNextSubmission` implements it as a first-peer prefix scan; the boundary
`drainQueue` uses the same scan, and the mid-turn peer drain stops at the
first non-peer entry. Peer text never enters the raw-string steer channel: it
would lose attribution and reach user preprocessing.

Delivery is journaled like the idle path — `recordNotification` with the
projection, plus retry debt so a round that dies after acceptance does not
lose the envelope with the orphan the Retry path pops. Settlement runs
exactly once through a carrier whose restore requeues both drained batches;
the peer batch is requeued before the steer batch because both restores
prepend and the last one run owns the head. Restored entries keep `peer: true`
(and, on resume, the `display.peer` marker is re-derived from the recorded
raw parts, which hold the envelope while the stored field holds the
projection).

Throttling lives in `PeerMidTurnBudget`: a rolling five-minute window,
`tryConsume` per delivered envelope, `refund` when a settlement never reached
the model, and a read-only `hasAllowance` peek so a spent window short-circuits
before the pop instead of running a pop → stale-pin → restore round trip every
boundary. The once-per-window pause notice survives the short-circuit, but
only while an envelope actually waits. The budget is scoped to the session id:
`/clear` swaps the id in place, so the window and the notice throttle are
dropped on change.

## Design decisions and rationale

- **Off by default, consent per receiver.** Mid-turn steering moves the
  delivery point from a watched boundary to an unattended one; the operator's
  yes belongs to the receiving session, not the sender. The documented
  consent covers any accepted `"now"` frame: another session, a trusted
  controller, and a process this session started with its child token.
- **One envelope per boundary.** A chatty peer may slow a turn, never own it:
  at most one peer message per tool round regardless of the budget.
- **Budget 3 per 5-minute window.** Symmetric with the hold ceiling; a peer
  costs real model work even when handled well. Constants live in
  `peerMessaging/mid-turn-constants.ts`, a dependency-free leaf module, so
  the settings schema can use the default without a runtime edge from the
  config graph into core (three CLI suites partially mock that graph; a direct
  import broke them at collection).
- **Unreadable budget = default, not unlimited.** The ceiling exists because
  peers spend this session's model work, so nothing that fails to parse may
  mean "no ceiling"; `0` is the explicit off and is documented as such on
  every surface.
- **Notice, once per window, only when something waits.** Silent throttling
  was the original symptom; an always-on notice would let an idle-but-throttled
  session print lines that throttle nothing.
- **Refund on failed settlement.** A restored batch is delivered later by the
  idle drain; charging it anyway would let repeated cancellations starve the
  budget while nothing reached the model.
- **Same receipt either way.** Telling the sender its steer was deferred would
  leak receiver policy and invite urgency-flooding.

## Constraints

- `packages/cli/src/config/settingsSchema.ts` and `settingsUtils.ts` must not
  import the `peerMessaging` module at runtime; the mid-turn constants come
  from the leaf.
- `boundaryEnvelopeTexts` must stay in push order: the combined strip removes
  an exact trailing suffix, and per-batch strips silently no-op when the
  other batch is the tail.
- `drainQueue`'s rest computation is identity-based, because the barrier
  leaves drainable entries in the queue.
- The generated `packages/vscode-ide-companion/schemas/settings.schema.json`
  is regenerated and diffed by CI; schema edits ship with their regeneration.
- Workspace overrides of both settings are tighten-only
  (`WORKSPACE_TIGHTEN_ONLY_SETTINGS`).

## Risks

- **Turn capture by a chatty peer** — bounded by the per-boundary single
  envelope plus the budget; the notice makes the bound visible.
- **Prompt-injected steering** — peer (and own-process, controller) frames can
  steer a running turn once opted in; they keep the envelope and authority
  notice, inbound review policy still gates them before this point, and Goal
  turns are excluded.
- **Own-process injections are review-free under mode parity and now
  steer-running-turns** — deliberate (the build-hook use case), documented on
  the setting, in `settings.md`, and in `commands.md` §6.

## Validation plan

Unit suites, each fix additionally mutation-checked (the test fails when the
fix is reverted): the drain hook and call-site gating in
`AppContainer.test.tsx`; boundary settlement, restore order, and exclusion
gates in `use-llm-stream.test.tsx`; barrier and mid-turn drains in
`useMessageQueue.test.ts`; budget window/refund and `peerMidTurnBudgetOf` in
`peer-messaging.test.ts`; the resume peer-marker pin in
`resumeHistoryUtils.test.ts`. The three partially-mocking suites
(`workspace-service/__tests__/facade`, `acp-integration/acpAgent.worktree`,
`startInteractiveUI`) must collect cleanly.

## Acceptance criteria

- With `agents.crossSessionMidTurn` off (default), boundary behavior is
  byte-for-byte the pre-feature behavior: envelopes wait for Idle.
- On, an accepted `"now"` envelope can reach the model at a tool-round
  boundary, once per boundary, ≤3 per five-minute window, after the receiver's
  queued user input, never during a Goal turn.
- No path loses or double-delivers an envelope: exactly-once settlement with
  refund on restore; a restored entry re-enters tagged `peer` and its
  notification renders with the peer marker after `/resume`.
- `settings.schema.json` unchanged under regeneration; all suites green.

## Open questions

- Should the budget be per-sender rather than per receiving session? Left
  global: attributing the window fairly needs sender identity the queue does
  not carry today.
- A future receipt distinguishing a granted steer is deliberately out of
  scope; nothing in the wire format yet prevents adding it.
