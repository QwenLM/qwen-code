# Managed GitHub PR Watch + Bound-Session Proactive Delivery

[English](2026-11-17-managed-github-pr-watch-bound-session.md) | [简体中文](2026-11-17-managed-github-pr-watch-bound-session.zh-CN.md)

Status: merged in #17665 (squash commit `8a96777248`); deferred review follow-ups
tracked in #17792. Builds on the merged managed GitHub adapter (#17511, `2c23f72bef`).
Verification ledger (merged tree, all green): github adapter 1040 tests, core parity +
record-sink 59, cli pr-watch funnel / channel client / capability-parity and
hosted-harness 854, Java pr-watch + surface suites, and a 36-check real-process E2E.

Confirmed decisions (2026-11-17): first slice = private-only bound injection (public
reply, role templates, Web Shell UI deferred); **D1 = new `pr_event` input source**;
**D3 = adapter-side detection**. D2 (dedicated PR-watch binding table) adopted as
recommended below. **D5 resolved to the internal channel-adapter surface** (tenant
header + trusted adapter + enablement gate, `RuleClass.INTERNAL_CHANNEL_ADAPTER`),
the same trust boundary as the merged channel register/inbound routes — not an
OPERATOR public route and not a per-request writer credential. See the Binding
routes contract below; the earlier OPERATOR/Session-owner wording is superseded.

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
   - wake to the **bound** Session (target forced from the binding, never
     caller-chosen), reusing `submitInput`. The event carries a durable envelope
     (PR identity, transition, head SHA, evidence) pinned before commit, and a derived
     idempotent `inputId` so a crash replays to the same admission.

### Key design decisions (settled)

All five are settled; D5 was resolved after the first draft and is recorded in full
below. The alternatives are kept as the record of what each decision rejected.

- **D1 — Injection source (settled: a new `pr_event` source).** A new `pr_event`
  input source was chosen over reusing an existing whitelisted one (`automation` via
  the reserved webhook slot, or `channel`): reusing `automation` couples PR events to
  the automation domain gates, and the clean source is the honest fit. It is added to
  BOTH the TS `isWakeInputSource` and Java `JdbcWakeRecoveryStore.SOURCES` whitelists
  and their pin tests, and admitted beside the sibling wake sources during history
  maintenance.
- **D2 — Binding storage (settled: a dedicated PR-watch binding).** A new dedicated
  PR-watch binding table was chosen over extending `ma_channel_binding` or
  route-rebind. Route-rebind is contract-ready but rebinds the whole channel route
  (affects @mention delivery too), which is wrong for a per-PR watch target; the
  channel route stays untouched.
- **D3 — Detection ownership (settled: adapter-side detection).** The adapter holds
  the token and the poll loop, so it observes; the control plane owns binding +
  injection + authorization. Managed and daemon `sessionPrWatch` scopes stay disjoint
  rather than reconciled in slice 1.
- **D4 — Private-only first slice (settled).** Watch events inject into the bound
  Session and do not auto-post a public reply. The public-reply delivery producer is a
  follow-up. This matches the Legacy decision and avoids the delivery-producer work in
  slice 1.
- **D5 — Authorization role (settled).** All four routes (`pr-watch:create`,
  `pr-watch:list`, `pr-watch:retire`, `pr-watch:inject`) ride the existing internal
  channel-adapter surface: tenant header + trusted adapter + enablement gate,
  registered in the `SurfaceRegistry` as `RuleClass.INTERNAL_CHANNEL_ADAPTER`. There
  is no per-request actor or writer credential; the trust boundary is the internal
  listener, exactly as for the merged channel register/inbound routes. Injection
  forces the bound Session as target (never caller-chosen). An OPERATOR public route
  was considered and rejected for slice 1: it would add a second credential system
  beside the adapter's token for no gain while the surface stays internal.

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
gmt_create)`, unique `(tenant_id, channel_id, owner, repo, pr_number)`. No
  session-scoped index ships: slice 1 has no session-scoped read (retire is by PR
  business key), so a reader-less index is omitted rather than carried. `events_json`
  is the enabled transition set. The binding write path validates the target Session
  exists and is ACTIVE in the instance's Workspace, and authorizes per D5.
- **Binding routes.** Under the existing internal channel prefix
  `/internal/managed-channels/v1/channels/{channelId}`: `pr-watch:create`,
  `pr-watch:list`, `pr-watch:retire`. Authenticated like the channel adapter internal
  surface (tenant header + trusted adapter + enablement gate); all four `pr-watch:*`
  routes — including the `pr-watch:list` read and the `pr-watch:inject` write below —
  are registered in the `SurfaceRegistry`.
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
  - transition + headSha before commit.
- **Envelope.** A `managed-input` resource carrying the flat record `{ owner, repo,
prNumber, transition, headSha, evidence, text }`; `text` holds the XML-wrapped prompt
  that the wake pump reads. Private-only: no `channel_delivery` is planned from a
  `pr_event` input.
- **Detection (D3).** Adapter-side watch pass reusing the daemon transition semantics
  (once-per-head CI fire, edge-triggered conflict, head change). Minimal event set:
  `ci_failure`, `merge_conflict`, `head_change` (`state_change` deferred). The adapter
  learns bound PRs via `pr-watch:list`. Watch state (baseline + fired-ring + pending)
  lives in a new `managed-state.ts` segment.

## Review hardening (#17665 round 1)

The first review round closed these gaps; each is pinned by a test that turns red
when the guard is removed:

- **Rotating observation window.** The per-tick observation cap truncates a
  stably-ordered binding list; a durable `sweepStart` offset rotates the window so
  every binding is observed across successive ticks, not only the first cap.
- **Episode watermark survives prune/rebind.** The admission ledger is permanent and
  keyed without a binding discriminant, so the per-PR occurrence counter lives in a
  durable `episodes` map carried across baseline prune; a rebind resumes the counter
  instead of re-deriving an already-admitted input id. The map is bounded separately
  from the prunable baselines (oldest watermark evicted past the cap).
- **Terminal PRs.** A merged/closed PR is terminal: it drives no transition and its
  binding is retired (idempotent, re-driven while terminal), freeing the observation
  slot and allowing rebind.
- **Ownership-move guard counts both binding classes.** Channel re-registration
  refuses an actor/Workspace/cwd move while retained bindings exist; the pre-check
  and the in-statement guard now count `ma_pr_watch_binding` beside
  `ma_channel_binding`, and `inject` re-validates the bound Session's Workspace on
  every call (failing closed, lazily retiring a binding whose Session is gone).
- **Wake pump is an admission precondition.** `submit_pr_event_input` is refused
  (409) when the Session has no in-process wake pump (e.g. the external-files
  profile), so an input is never acknowledged into a Session that cannot run it. A
  resident opened for recovery cleanup registers before its pump exists, and the next
  full load replaces it with one that has both; that one window answers a retryable
  503, so the adapter neither retires the binding nor records a false fired.
- **Ingress bounds the wrapped envelope.** The route refuses a payload whose wrapped
  prompt exceeds the Harness char/byte caps before staging, so an accepted request is
  an admittable one (no permanently-staged un-injectable row). The wire limits stay
  `text ≤ 32000`, `evidence ≤ 4000`.
- **Per-entry drain isolation.** A transient injection failure isolates to that PR's
  queue; one unhealthy Session does not starve the other bindings. A ring-suppressed
  `ci_failure` still pins the head so the CI read is not re-issued every tick.
- **Committed real-process witness.** The adapter↔control-plane E2E is a permanent
  script, `scripts/run-managed-pr-watch-e2e.mjs` (`npm run test:e2e:managed-pr-watch`),
  wired into the Hosted failover E2E job and pinned by
  `scripts/tests/hosted-process-ci.test.js`. It runs the bundled CLI + real Octokit
  against a mutable fake GitHub and a recording fake control plane that derives ids
  with the real core `prWatchInputId`; its private-only, per-ref CI, and
  once-per-head checks read recorded counters so they can fail.

Round 2 additionally closed: a CLOSED bound Session is now lazily retired (not only
DELETED/foreign); the cold-load file-history exemption covers `pr_event` parked tool
turns; the close path settles pending `pr_event` inputs; the watch pass runs after the
reply lane and persists only on change; the terminal retire is ownership-guarded; a
pump-less binding is retired on the first `pr_event_wake_unavailable`; the failed-check
list carries an incompleteness marker; the parity fixture is two-directional (a TS test
reads it) and pins the envelope limits; and the `channels.enabled` description names the
four `pr-watch:*` routes.

Round 3 additionally closed: a merely staged injection row owned by a previous binding
is released and re-staged on rebind (only an admitted row reserves the identity), so a
transient Harness failure cannot block the PR forever; the strict integer wire binding
is scoped to the three `pr-watch:*` request records instead of the whole MVC surface;
the E2E rig runs beside the failover arms under their prerequisites bound and its path
is visible to the Managed Agent gate; and the private-only delivery check counts claims
so it witnesses the lane ran and served nothing.

## Open questions

1. ~~D1–D5~~ confirmed (see status); D5 resolved to the internal channel-adapter
   surface (no further role decision pending).
2. Double-watch with daemon `sessionPrWatch`: slice 1 keeps managed-watch scoped to
   managed-bound PRs only; reconciliation beyond disjointness is deferred.
3. `state_change` and role/action templates are deferred beyond slice 1.
