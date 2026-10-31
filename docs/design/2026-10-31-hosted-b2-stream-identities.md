# Hosted B2 — attempt/stream identities and the live SSE view across two replacements

[English](2026-10-31-hosted-b2-stream-identities.md) | [简体中文](2026-10-31-hosted-b2-stream-identities.zh-CN.md)

Status: proposed, 2026-10-31. Part of [#14481][issue] (G3 Step 3 recovery-matrix
acceptance, tracks #12380). Extends the packaged `hosted-failover-e2e` arms described
in [G3 Step 3 recovery](2026-10-09-hosted-g3-step3-recovery.md). This slice completes
matrix row **B2 ("streamed prefix and two replacements")**: the existing model-round
arm already packages the reissue, retraction ordering and admission observations, but
not the **new attempt/stream identities** nor the **live SSE view** — the runner's own
reload helper documents that "the live SSE view is not read".

## Problem

Matrix row B2 reads: _"New attempt/stream identities; durable retraction before new
deltas; live view, reload and replay expose only the surviving answer and one
terminal."_ The model-round arm crashes two successive owners inside the first model
round, each after publishing a held prefix, and asserts the surviving answer, one
terminal, retraction-before-new-deltas ordering, deep-equal saved-request reissue,
distinct boot ids and advancing writer heads. Three observations are missing:

1. **Attempt identity.** Nothing asserts that each replacement opens a _new_ model
   attempt. A recovery that reuses the dead generation's `attemptId` would pass.
2. **Stream identity.** Nothing asserts that each generation's public deltas carry a
   _new_ item/part identity, or that the retracted prefixes are blanked (empty text,
   no `item_id`/`content_part_id`) as the public API contract promises. A live view
   that keeps serving the dead generation's prefix under its original identity would
   pass.
3. **Live SSE view.** Every current assertion reads the REST reload view
   (`publicTranscript`). The live SSE stream — the view a connected browser actually
   watches across the crashes — is never observed, so a control plane that delivers
   orphaned prefixes live, drops the retraction announcement, or double-projects the
   terminal would pass.

## Current state (verified on `main` at `bc8ad53f95`)

- **Choreography already exists.** `--model-round-failover --harness-only` runs three
  Harness generations over one no-tool Turn: the fake model returns a held prefix per
  generation (`modelRoundPartials` = PARTIAL_ONE / PARTIAL_TWO, `holdUntil` per
  generation), the runner crashes each owner at its hold, scrashes its disk, and
  `advanceModelRound()` releases the hold only after the owner is dead so the reissue
  lands on the next generation. The third generation completes with
  `modelRoundResponse`. No serve hook is involved.
- **Existing assertions** (model-round audit): one `turn.completed` terminal;
  surviving text equals `modelRoundResponse`; `retractedBeforeNewDeltas` for both
  transitions via `reconciledBetween`; `terminalRows()=1`; streaming round requests =
  partials+1, all deep-equal; zero tool executions; one Turn; one admission journal
  transaction and one admission resource (B1); three distinct boot ids; writer
  generation / journal revision / committed sequence strictly advance.
- **Attempt identity.** `beginMainAttempt` mints
  `attemptId = ${turnId}:main:${randomUUID()}`
  (`managed-hook-activation.ts`), journaled on every `model.attempt` event
  (started / output_committed / abandoned) with the attempt's route/usage refs. The
  runner already parses journal HEX rows (`b3RoundAndBudget` pattern).
- **Stream identity.** The CLI binds each attempt's pre-assigned messageId into
  `HostedTextDeltaStream.bindMessageId` (`hosted-text-deltas.ts`); deltas publish under
  it and `retractOriginal(messageId, …)` blanks the dead attempt's deltas and journals
  `message.retracted`. Spring projects the public events with top-level `item_id` /
  `content_part_id` (nullable). The identity model (`EventIdentity`, projection v1,
  verified on the real stack): `item_id` is the Turn's ONE assistant item
  (`item_<turnId>_assistant`) and stays stable across the repair; a text delta
  **continues the previous delta's content Part** only while that delta keeps its
  identity, otherwise it starts a new Part (`part_<turnId>_output_text_<sequence>`).
  Retraction blanks the dead deltas' text AND identity, so the next generation's first
  delta cannot continue and must open a new Part — the pairwise distinct Parts are the
  witness that the continuation broke at every replacement. The public API contract
  states a `stream.reconciled` event means earlier deltas "now have empty text and no
  item_id or content_part_id, and … later deltas may name other Parts"
  (`managed-agent-public-api.openapi.json`, PublicEvent schema).
- **Live SSE.** `GET /v1/agents/sessions/{id}/events` serves SSE when `stream=true` or
  `Accept: text/event-stream` (`PublicAgentController.events`); `Last-Event-ID` takes
  precedence over `after`; a cursor below `replay_floor_sequence` gets 409
  `cursor_expired` (JSON) or one `agent.session.resync_required` SSE frame then close.
  The stream is served by the control plane, so it survives Harness crashes — which is
  exactly what the live-view assertion needs.

## Goals and scope

**In scope.** Extend the existing model-round arm (harness-only variant) with:

1. **Attempt identities**: the three streaming attempts carry three distinct
   `attemptId`s, one new attempt per generation (journal `model.attempt`).
2. **Stream identities**: the two dead prefixes (live capture) and the surviving
   answer (reload) carry pairwise distinct content Parts — the continuation broke at
   every retraction — while all three share the Turn's single assistant `item_id`;
   after each retraction the dead prefix's deltas have empty text and null
   `item_id`/`content_part_id` in both the reload and the replay views.
3. **Live SSE view**: a runner SSE client connects before the first prefix and stays
   connected across both crashes; it observes PARTIAL_ONE live, the retraction
   announcement, PARTIAL_TWO under a new identity, the second retraction, the surviving
   answer and exactly one terminal. The public `stream.reconciled` frame carries no
   payload — the contract is that a client seeing one reloads (the store already
   blanked the retracted deltas in place) — so the converged live view is the deltas
   after the LAST retraction, and the raw capture's pre-retraction frames supply the
   dead generations' identities. The converged live view equals the REST reload and
   the `Last-Event-ID: 0` replay. Per-phase liveness guards make each observation
   non-vacuous (the frames must actually arrive).
4. The existing retraction-ordering, parity, admission, boot and head assertions stay.

**Out of scope.** Projection-rebuild cursor semantics (`cursor_expired` /
`resync_required` floor handling) — a separate concern with its own fixtures;
frozen-control-plane variant of the new assertions (the Q2 arm keeps its current
scope); both-owner restart; real-provider acceptance.

**No production behavior change.** All additions are runner assertions and one SSE
client helper; no new serve hook, no CLI/Java source edit.

## Proposed solution

### Identity readers

- `b2AttemptIdentities(port, sessionFilter)`: parse journal HEX rows for
  `model.attempt` events of the original prompt, collect `payload.attemptId` with the
  event `state`/sequence; return the ordered distinct attempt ids. Reuses the
  `b3RoundAndBudget` journal-reading pattern (HEX + decode, never `--batch` text).
- Extend `PublicEvent` with optional `item_id` / `content_part_id` and read them in
  `publicTranscript` (they are already on the wire). A `b2StreamIdentities` helper
  groups delta events by the prefix text they carry and returns each group's identity
  set plus the retracted (empty-text, null-identity) delta sequences.

### Live SSE client

A top-level `readPublicSse(springUrl, tenant, sessionId, { after, lastEventId, until,
signal })` helper: `fetch` with `Accept: text/event-stream`, parse `id:` / `event:` /
`data:` frames across chunk boundaries, resolve when `until(events)` holds or the
budget expires, and return the collected frames plus the last seen id. The arm opens
one live connection before the first prefix (after=0), keeps it across both crashes,
and asserts the observed frame sequence; a second connection with `Last-Event-ID: 0`
after the terminal is the replay witness. The helper gets behavioural tests on
injected chunk streams (split frames, multi-frame chunks, terminal detection).

### Assertion placement

All new checks live in the existing model-round audit block, after the current
assertions, gated on `modelRoundFailover && harnessOnly` so the frozen-control-plane
variant is unchanged. Error messages are B2-specific (`B2 attempt identities …`,
`B2 stream identities …`, `B2 live SSE …`) so a regression names the missing
observation, not the generic audit string.

## Design decisions and rationale

- **Extend the model-round arm, not a new arm** — the two-replacement streamed-prefix
  choreography already exists and is CI-proven; B2's gap is purely observational. No
  new CI step, no ceiling change.
- **Live view is control-plane-owned** — the SSE connection surviving both Harness
  crashes is the property under test, not an inconvenience; the client must not
  reconnect per generation (that would silently become a reload poll).
- **Identities from the wire and the journal, not the fixture** — attempt ids come
  from `model.attempt` journal events; stream ids from the public events'
  `item_id`/`content_part_id`. The fixture only supplies the prefix texts.
- **Liveness guards per phase** — each live observation asserts frames actually
  arrived (prefix delta, retraction, new-identity delta, terminal); an SSE client that
  silently reads nothing reds instead of passing vacuously.

## Constraints and risks

- **SSE parsing robustness.** Frame boundaries split across TCP chunks; the parser is
  a named helper with behavioural tests on injected chunkings, and the real-stack run
  is the integration witness.
- **Shared-arm regression.** The frozen-control-plane variant and every other arm must
  stay byte-for-byte unchanged in behavior; the new checks are gated and the contract
  suite pins the gate.
- **Retraction is in-place.** Reload/replay identity checks read the blanked deltas
  after the fact (the contract's promise); the live client additionally sees the
  retraction announcement frame. Both are asserted; neither alone is sufficient.

## Validation plan

- **.75 real stack**: model-round harness-only arm green with the new assertions —
  three distinct attempt ids; three distinct stream identities; blanked retracted
  prefixes; live SSE observes both prefixes, both retractions and one terminal;
  live == reload == replay.
- **Demonstrated mutation reds**: M1 `attemptId` made deterministic → attempt-identity
  red (checked before the shared audit: the reused id collides the journal command
  ids and dedups the later generations' attempts, so the identity check is the root-
  cause diagnosis); M2 `retractOriginal` early return → red at the shared audit's
  `retractedBeforeNewDeltas` — the B2 retraction-ordering observation — with the
  live-SSE, Part-continuation, blanking and replay checks jointly witnessed (they
  observe the same retraction mechanism at different views; a mutation breaking only
  the live stream would live in the Java SSE projection, out of this slice's CLI-only
  scope); M3 `messageId` pinned to a constant → red at an UPSTREAM barrier (gen2's
  stream publication never becomes ready): the cross-generation messageId collision
  breaks streaming before the retraction idempotency guard can manifest — recorded as
  an upstream-guard observation, not a B2-specific witness. Each restored after. The
  Part-continuation, blanking and replay checks are jointly witnessed by M2 (their
  mechanism IS the retraction) plus the head-green positive evidence.
- Contract suite + behavioural tests (SSE parser, identity readers) green;
  `npm run build && npm run typecheck && npm run bundle`.

## Acceptance criteria

- The packaged model-round arm asserts new attempt/stream identities, blanked
  retracted prefixes, and a live SSE view that converges to the surviving answer and
  one terminal, equal to reload and replay.
- Each new signal has a demonstrated named mutation red (M1–M3); the live client's
  non-vacuity is guarded per phase.
- Bilingual design docs aligned; CI green; no production behavior change.

## Open questions

- Whether the frozen-control-plane variant should later inherit the identity
  assertions (deferred; Q2's scope is the stale-claim fence).
- Projection-rebuild cursor/resync semantics as a separate slice (out of scope here).

[issue]: https://github.com/QwenLM/qwen-code/issues/14481
