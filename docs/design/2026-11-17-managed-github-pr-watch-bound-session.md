# Managed GitHub PR Watch + Bound-Session Proactive Delivery

[English](2026-11-17-managed-github-pr-watch-bound-session.md) | [简体中文](2026-11-17-managed-github-pr-watch-bound-session.zh-CN.md)

Status: confirmed scope, in implementation. Builds on the merged managed GitHub
adapter (#17511, `2c23f72bef`).

Confirmed decisions (2026-11-17): first slice = private-only bound injection (public
reply, role templates, Web Shell UI deferred); **D1 = new `pr_event` input source**;
**D3 = adapter-side detection**. D2 (dedicated PR-watch binding table) and D5
(OPERATOR binding write surface / writer-binding injection route) adopted as
recommended below.

## Problem

The managed GitHub channel today is **@mention-inbound / reply-only**: a comment
that mentions the bot admits an input into the channel route's own Session, and the
settled reply is posted back to the thread. Two capabilities are explicitly deferred
by the adapter's scope boundaries and are the subject of this design:

1. **PR watch events** — CI failure, merge conflict, head change, state change on a
   pull request should be able to trigger work, not only an explicit @mention.
2. **Bound-session proactive delivery** — such an event should reach an **existing
   managed Session that is bound to the PR** (the Session an operator is already
   using to work on that PR), not the channel's own route Session, and without
   requiring an inbound channel message.

The desired outcome: an operator binds a PR to a managed Session; when the watched
PR's CI goes red / it becomes conflicted / its head moves, a prompt describing the
transition is injected into that bound Session (waking it if dormant), so the agent
can react. The first slice is **private-only**: the event injects into the Session;
it does not auto-post a public comment (matching the Legacy maintainer decision,
`2026-11-02-github-channel-bound-session-events.md` Key decision 8).

## Current state (verified at `c6913d17ac`)

### What exists and is reusable

- **Input + wake, one transaction, Session-generic.**
  `packages/core/src/managed-runtime/managed-session-authority.ts` `submitInput`
  (~L958) persists `input.accepted` + `wake.requested` in one commit (`inputEvents`
  ~L4587). `commitExtensionRecord` (~L1836) can commit a domain-record revision and
  an input in the same transaction. Nothing here restricts the target to a Session
  the funnel created.
- **Dormant wake needs no new mechanism.** Three consumed paths plus
  operation-attachment already wake a dormant Session once an input lands in its
  journal with a whitelisted source: the in-process wake pump
  (`hosted-harness-session.ts` `isWakeInputSource` ~L1575), event-driven
  `TransportWakeActivator`, and the SQL scan `JdbcWakeRecoveryStore` (Java `SOURCES`
  ~L29). A channel/automation submit operation itself attaches a dormant Session.
- **Route rebind to another Session is already contract-legal.**
  `managed-channel-record.ts` `REBIND_KEYS` (~L124) includes `sessionId`;
  `isChannelRouteSuccessor` (~L421) permits a rebind that bumps `routeRevision` and
  swaps `sessionId`. **There is no producer that does this today.**
- **The delivery record/state machine is source-agnostic.** `ChannelDelivery`
  requires `sourceTurnId` to be a stable id, not specifically a channel turn
  (`managed-channel-record.ts`; Java `ManagedChannelRecords.requireDelivery`). The
  reply-only constraint lives in the **producer** (`hosted-channel-session.ts`
  `planReplyUnserialized` ~L454 only plans from `source==='channel'` settled turns;
  `channelDeliveryId(inputId)=`${inputId}:reply``), not in the contract. The whole
  claim/receipt/resend/lease chain is reusable if a new producer is added.
- **A reserved event slot.** `managed-automation-record.ts` `occurrenceKey` (~L100)
  reserves `webhook:<eventId>` "until the webhook ingress slice lands"; the validator
  currently refuses it (accepts only `schedule:`/`manual:`). PR events are a natural
  future tenant of that slot.
- **Binding storage shape.** `ma_channel_binding` (V1 ~L1194) is
  `(tenant, channel, route) → session`, created only by `bindRoute`
  (`ManagedChannelService.java` ~L700) which always creates its own Session.
  `ma_delivery` already carries `source_session_id`/`target_session_id` for
  `SESSION_MESSAGE`/`CHILD_RESULT` — a "deliver to another Session" SQL shape exists.
- **Authorization template for "target is the bound Session".**
  `ManagedAutomationSessionService.java` (~L44) forces the bound Session as target,
  authenticates via writer-token `authorizeOrdinary`, and acts as the Session's
  creator actor. This is the model to copy for an internal proactive-injection route.

### What is absent (must be new)

- **PR → existing-Session binding**: no storage entry or write path binds an external
  PR to a caller-chosen existing Session. `bindRoute` only creates its own Session.
- **A control-plane producer route that submits input to a bound existing Session**
  (channel `submitInbound` always targets `binding.sessionId()` of its own route).
- **A delivery producer not tied to an inbound channel turn** (only needed if the
  result must be posted back to GitHub; deferred by the private-only first slice).
- **Authorization for the binding write surface** (a new route family; must be added
  to the `SurfaceRegistry`, and a role chosen per the actor-roles matrix).
- **PR-state detection in the managed adapter**: `ManagedGithubClient` has no
  `pulls.get`/checks/combined-status; `managed-state.ts` has no watch baseline /
  fired-ring / pending.

### The architectural tension to resolve

The Legacy world **just retired channel-side PR watch and consolidated detection into
the daemon** (`serve.sessionPrWatch`, #17214, 2026-11-14;
`2026-11-04-daemon-pr-state-transitions.md`), precisely to avoid "one PR polled by two
pollers, two credentials, two CI definitions". Re-introducing detection in the managed
channel must not recreate that duplication:

- Managed Sessions are **not** in the daemon sidecar system, and the managed adapter
  authenticates with a **token**, not `gh`; the daemon's `sessionPrWatch` cannot cover
  managed Sessions as-is. So managed needs its own detection path or an explicit
  bridge — it is not literally "rebuilding what was migrated", but the
  one-source-of-truth concern still applies to any PR watched by both worlds.
- The design must (a) reuse the daemon's **transition semantics** (once-per-head CI
  fire, edge-triggered conflict, private-only) rather than invent a second CI
  definition, and (b) keep managed-watch and daemon-watch scopes disjoint or
  reconciled so a PR is not double-watched with divergent CI aggregation.

## Proposed architecture

Three layers, mirroring the Legacy bound-session-events design but on the managed
control plane:

1. **Binding layer (control plane).** A PR-watch binding records
   `(tenant, channelInstance, owner/repo#pr) → targetSessionId + event filter +
   role/action template`. New record body + table (or an extension of
   `ma_channel_binding` with an externally-specified `session_id` write path). A
   register/list/retire route family, authenticated like the automation-session
   internal surface (writer binding + creator actor) or as an OPERATOR public route.
2. **Detection layer (managed adapter).** A PR-watch pass in the adapter tick reusing
   the existing Octokit deps, rate-limit classification, and poll-floor. It observes
   the bound PRs (`pulls.get` head/mergeable/state + conditional checks/status),
   derives transitions with the daemon's semantics, and persists a durable
   pending + fired-ring in a new watch state segment. It does **not** post publicly.
3. **Injection layer (control plane).** A new internal route submits a PR-event input
   + wake to the **bound** Session (target forced from the binding, never
   caller-chosen), reusing `submitInput`. The event carries a durable envelope
   (PR identity, transition, head SHA, evidence) pinned before commit, and a derived
   idempotent `inputId` so a crash replays to the same admission.

### Key design decisions (for confirmation)

- **D1 — Injection source.** Either (a) a new `pr_event` input source (clean
  semantics; requires adding it to BOTH the TS `isWakeInputSource` and Java
  `JdbcWakeRecoveryStore.SOURCES` whitelists and their pin tests), or (b) reuse an
  existing whitelisted source (`automation` via the reserved webhook slot, or
  `channel`) to avoid whitelist changes but inherit that domain's gates. Recommendation
  pending the wake/domain-gate analysis: a new `pr_event` source is the most honest
  fit; reusing `automation` couples PR events to the automation domain gates.
- **D2 — Binding storage.** New dedicated PR-watch binding table vs extending
  `ma_channel_binding` vs route-rebind. Route-rebind is contract-ready but rebinds the
  whole channel route (affects @mention delivery too), which is likely wrong for a
  per-PR watch target. Recommendation: a dedicated PR-watch binding, leaving the
  channel route untouched.
- **D3 — Detection ownership.** Adapter-side watch (adapter holds the token) calling a
  control-plane injection route, vs control-plane-side watch. Recommendation:
  adapter-side detection (it owns the credential and the poll loop), control-plane
  owns binding + injection + authorization. Must reconcile with daemon `sessionPrWatch`
  scope to avoid double-watch.
- **D4 — Private-only first slice.** Watch events inject into the bound Session and do
  not auto-post a public reply. The public-reply delivery producer is a follow-up. This
  matches the Legacy decision and avoids the delivery-producer work in slice 1.
- **D5 — Authorization role.** Binding register/retire is a new write surface; choose
  OPERATOR (turn-submit family) or Session-owner, and register the routes in the
  `SurfaceRegistry`. Injection internal route uses writer-binding + creator actor.

## Bounded first slice (proposed)

Deliver "bind a PR to a managed Session; CI failure / merge conflict / head change
injects a private prompt into that Session, waking it if dormant":

- PR-watch binding record + table + register/list/retire routes (auth per D5).
- Internal PR-event injection route (target forced from binding; input+wake; derived
  idempotent inputId; durable envelope).
- Managed adapter PR-watch pass (detection, daemon transition semantics, durable
  pending + fired-ring) + client `pulls.get`/checks extension.
- Wake-source handling per D1.
- Tests: contract fixtures (TS/Java parity), binding auth, injection idempotency /
  crash-replay, watch transition edge-cases, dormant wake, private-only (no public post).

Deferred beyond slice 1: public-reply delivery producer; `state_change`/role-action
templates if not in the minimal event set; per_run targets; reconciling daemon/managed
watch scope beyond keeping them disjoint; Web Shell binding UI.

## Files affected (by layer, indicative)

- Core: `managed-session-authority.ts` (input source), `managed-session-records.ts`
  (wake/source pins, enablement), new PR-watch binding record + fixtures;
  `managed-channel-record.ts` unchanged if D2 = dedicated binding.
- Java: new binding table (V1 schema), binding repository/service, injection route +
  controller, `SurfaceRegistry`, `JdbcWakeRecoveryStore.SOURCES` (if D1 = new source),
  contract mirrors + fixtures.
- CLI/Harness: `hosted-harness-session.ts` wake whitelist (if D1), a PR-event input
  funnel (analogous to `hosted-channel-session.ts`), input envelope.
- Adapter: `managed-github-adapter.ts` (watch pass), `managed-github-deps.ts`
  (`pulls.get`/checks), `managed-state.ts` (watch segment + validator).
- Design docs EN/zh; E2E test plan.

## Concrete contract (slice 1, coordination target)

- **Input source.** `PR_EVENT_INPUT_SOURCE = 'pr_event'`, defined in a new core module
  `managed-pr-watch-operations.ts` (pattern of `managed-channel-operations.ts`). Added
  to the TS wake whitelist `isWakeInputSource` (`hosted-harness-session.ts`) and the
  Java `JdbcWakeRecoveryStore.SOURCES`, with their pin tests updated. The
  `input.accepted` event schema already accepts any text `source`, so no core event
  schema change is needed.
- **Workspace lifecycle is deliberately fail-safe for `pr_event`.** The v2 source
  whitelist in `JdbcWorkspaceLifecycleStore` (`monitor`, `child_agent`, `automation`,
  `session_message`, `channel`, `loop`) is NOT extended with `pr_event`. An accepted
  `pr_event` input therefore lands in the lifecycle scan's `pending` set and blocks
  Workspace close/delete until its `turn.settled` removes it. This is the conservative
  choice: a `pr_event` input drives a real model turn in the bound Session, so lifecycle
  must wait for it to settle rather than treat it as a non-blocking background input.
  No code change is needed there; the omission is intentional.
- **Binding storage (D2).** A plain SQL table `ma_pr_watch_binding` (like
  `ma_channel_binding`, not an extension-record domain):
  `(tenant_id, channel_id, binding_id, owner, repo, pr_number, session_id, events_json,
  gmt_create)`, unique `(tenant_id, channel_id, owner, repo, pr_number)`, index on
  `(tenant_id, session_id)`. `events_json` is the enabled transition set. The binding
  write path validates the target Session exists and is ACTIVE in the instance's
  Workspace, and authorizes per D5.
- **Binding routes.** Under the existing internal channel prefix
  `/internal/managed-channels/v1/channels/{channelId}`: `pr-watch:create`,
  `pr-watch:list`, `pr-watch:retire`. Authenticated like the channel adapter internal
  surface (tenant header + trusted adapter + enablement gate); the create/retire write
  surface is registered in the `SurfaceRegistry`.
- **Injection route.** `pr-watch:inject` on the same prefix. The target Session is
  forced from the binding (never caller-chosen), mirroring
  `ManagedAutomationSessionService`. It submits `input.accepted` + `wake.requested`
  (source `pr_event`) via the existing `submitInput` primitive through the Harness
  `POST /session/:id/channels/operations` (a new operation kind `submit_pr_event_input`).
- **Idempotent identity.** `inputId = "prw-" + sha256(tenant ∥ channelId ∥ owner ∥ repo ∥
  prNumber ∥ transition ∥ headSha ∥ episode) + ":input"`; `turnId = inputId`. `episode`
  is the adapter's durable per-PR occurrence counter, persisted with each pending entry:
  a legitimate recurrence (merge_conflict dirty→clean→dirty on the same head, or
  head_change A→B→A) is a NEW episode and derives a NEW input id, while a redelivery of
  the SAME pending entry reuses the episode and derives the same id. Without the episode
  the control plane would dedupe a legitimate recurrence into the first admission. A crash
  between Harness commit and SQL ledger replays to the same admission (derived id),
  following the channel crash-safe discipline. The durable envelope pins the binding + PR
  + transition + headSha before commit.
- **Envelope.** A `managed-input` resource carrying `{ text, prWatch: { owner, repo,
  prNumber, transition, headSha, evidence } }`; the wake pump reads `text` for the
  prompt. Private-only: no `channel_delivery` is planned from a `pr_event` input.
- **Detection (D3).** Adapter-side watch pass reusing the daemon transition semantics
  (once-per-head CI fire, edge-triggered conflict, head change). Minimal event set:
  `ci_failure`, `merge_conflict`, `head_change` (`state_change` deferred). The adapter
  learns bound PRs via `pr-watch:list`. Watch state (baseline + fired-ring + pending)
  lives in a new `managed-state.ts` segment.

## Open questions

1. ~~D1–D5~~ confirmed (see status). Remaining: binding-write authorization role
   (OPERATOR vs Session-owner) to finalize in the Java implementation.
2. Double-watch with daemon `sessionPrWatch`: slice 1 keeps managed-watch scoped to
   managed-bound PRs only; reconciliation beyond disjointness is deferred.
3. `state_change` and role/action templates are deferred beyond slice 1.