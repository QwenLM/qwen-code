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
  queue state, and Goal ownership decide whether it is delivered. Among peers
  queued at a mid-turn boundary it does decide order — the boundary drain
  skips a `next` to take a later `now` — while the idle drain stays
  arrival-order.
- A receipt distinguishing a granted steer from a deferred one: `delivered`
  keeps meaning "queued for the model", and the wire must not leak receiver
  policy to the sender.

## Proposed solution

Two new settings, both tighten-only for workspaces:
`agents.crossSessionMidTurn` (boolean, default `false`) and
`agents.crossSessionMidTurnBudget` (integer ≥ 0, default `3`, read through
`peerMidTurnBudgetOf`, which floors a finite number, clamps a negative to
`0`, and maps anything else — not a finite number — to the default; `0` is
off, so a hand-edited `-1` fails closed, not open).

At each tool-round boundary in `use-llm-stream.ts`, after steer and teammate
drains, the boundary calls the peer drain with no batch size and takes at most
one envelope — one per boundary is the drain's own rule, not a number the
caller chooses. The envelope passes the same recipient re-check as the idle
drain
(`drainQueuedFrame`, which settles stale pins with a `misaddressed` receipt)
and joins the tool-result submission, so `function_response` blocks still
lead the user content. Four gates exclude it — null drain (off, or no inbox),
Goal turn owning the session, detached continuation, cancelled continuation —
and every exclusion leaves the envelope queued, never dropped.

Ordering is governed by one barrier rule — user text queued behind a waiting
envelope never overtakes it — applied at each path's own strength. On the idle
path, where every waiting envelope drains, `popNextSubmission` stops at the
first peer entry. At the boundary, `drainQueue` stops only at the envelope the
mid-turn drain could take right here: the first `"now"` that this boundary's
own steer drain leaves at the head, with an allowance left to pay for it and a
recipient pin this boundary can satisfy. That
drain runs first, and its removals are what promote an envelope, so the scan
passes over entries it takes and stops at any entry it cannot — such an entry
is a wall the pop breaks on, and nothing behind it is this boundary's to
deliver. Judging the barrier against the queue as it stands, rather than as the
pop will find it, releases user text that then overtakes the envelope inside
the same submission. An envelope this boundary cannot deliver is not a
barrier (a stale-pinned `"now"` is the concrete case: the pop still consumes
it and settles it with a `misaddressed` receipt, but it delivers nothing
here), because the alternative would hold the user's
own input for the rest of the turn to preserve the place of a delivery that is
not going to happen. Peer text never enters the raw-string steer channel: it
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
  consent covers any accepted `"now"` frame: another session of this
  session's own review class (what the mode-parity default delivers without
  review), a trusted controller, a process this session started with its
  child token, and a same-user process that claims this session's own review
  class — a claim nothing authenticates. An operator-set
  `agents.crossSessionInbound` — `accept`, `hold`, `refuse`, or an unreadable
  value, which holds — outranks these four classes: `accept` short-circuits
  the sender classes entirely, so under it any same-user process that can
  reach the session's socket is delivered — and with it steerable mid-turn —
  whatever class it claims, or none; `hold` and `refuse` park or refuse even
  own-process and controller frames.
- **One envelope per boundary.** A chatty peer may slow a turn, never own it:
  at most one peer message per tool round regardless of the budget.
- **Budget 3 per 5-minute window.** Deliberately far below the 50-envelope
  hold ceiling: a held message costs storage the session already spends,
  while a steered one costs real model work even when handled well. Constants
  live in `peerMessaging/mid-turn-constants.ts`, a dependency-free leaf
  module, so the settings schema can use the default without a runtime edge
  from the config graph into core (three CLI suites partially mock that
  graph; a direct import broke them at collection).
- **Unreadable budget = default, not unlimited.** The ceiling exists because
  peers spend this session's model work, so nothing that fails to parse may
  mean "no ceiling"; `0` is the explicit off and is documented as such on
  every surface. A negative value is readable and clamps to `0` — the
  fail-closed direction — and a fractional value floors.
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
  from the leaf. Both directions are enforced by `eslint.config.js`: a
  `@typescript-eslint/no-restricted-imports` override for
  `peerMessaging/mid-turn-constants.ts` bans the leaf's runtime imports
  (type-only allowed), and one for `packages/cli/src/config/**` bans the
  config modules from the peer runtime, exempting the leaf constant.
- `boundaryEnvelopeTexts` must stay in push order: the combined strip removes
  an exact trailing suffix, and per-batch strips silently no-op when the
  other batch is the tail.
- `drainQueue`'s rest computation is identity-based, because the barrier
  leaves drainable entries in the queue; a predicate-based filter would
  drop them.
- The generated `packages/vscode-ide-companion/schemas/settings.schema.json`
  is regenerated and diffed by CI; schema edits ship with their regeneration.
- Workspace overrides of both settings are tighten-only
  (`WORKSPACE_TIGHTEN_ONLY_SETTINGS`).

## Risks

- **Turn capture by a chatty peer** — bounded by the per-boundary single
  envelope plus the budget; the notice makes the bound visible.
- **Prompt-injected steering** — peer (and own-process, controller) frames can
  steer a running turn once opted in; they keep the envelope and authority
  notice, and Goal turns are excluded. Peer frames keep the inbound review
  gate; own-process frames under mode parity and controller frames on a
  granted token are delivered without per-message review (see the next
  bullet and `commands.md` §6).
- **Own-process injections are review-free and now steer running turns** —
  deliberate (the build-hook use case): the gate accepts this session's own
  processes and controller-granted programs without any sender-class or
  parity check — but still below an operator-set `hold` or `refuse` (an
  unreadable value holds too); parity governs only ordinary peer sessions.
  Documented on the setting, in `settings.md`, and in `commands.md` §6.

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

- With `agents.crossSessionMidTurn` off (default), envelopes wait for Idle.
  Three idle-path changes apply regardless of the setting, none gated by it:
  the batching barrier (`popNextSubmission`'s user batch stops at the first
  waiting peer envelope, where the pre-feature filter skipped envelopes and
  let later user text batch past them); peer-marker rendering on the idle
  path (`display: { peer: true }` and the `PeerMessage` glyph instead of the
  pre-feature `InfoMessage`), with its `/resume` re-derivation from recorded
  parts; and identity-based receipt settlement (a consumed or misaddressed
  frame no longer also collects a close-time corrective receipt, and
  `settleUnconsumed` corrects the whole set by identity rather than a
  positional tail).
- On, an accepted `"now"` envelope can reach the model at a tool-round
  boundary, once per boundary, ≤3 per five-minute window — a budget of `0`
  keeps it off entirely (the drain is null) — after the receiver's queued
  user input, never during a Goal turn.
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
