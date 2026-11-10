# Managed Agent scheduling: built-in and external schedulers

[English](2026-11-10-managed-external-scheduling.md) | [简体中文](2026-11-10-managed-external-scheduling.zh-CN.md)

Status: proposal, not implemented. This design makes Managed Agent's
scheduling pluggable: the built-in H6 automation scheduler stays the
default, and external schedulers — Alibaba Cloud DataWorks first, then
Airflow, DolphinScheduler, and others — drive runs through one generic
external-trigger contract. It consumes the
[H6 automation design](2026-10-04-managed-automation.md) and its
[runtime](2026-10-07-managed-automation-runtime.md), the
[Managed MCP runtime](2026-09-28-managed-mcp-runtime.md), and the
channel adapter packaging precedent (`packages/channels/base`); it
redesigns none of them. The self-paced and fixed-interval `/loop`
[designs](2026-11-10-managed-loop-schedule.md) ride the built-in arm.

## Problem

Managed Agent today has exactly one timing owner: the H6 control-plane
scanner, which derives cron slots from definitions and fires them into
bound Sessions. Enterprises already run schedulers — DataWorks, Airflow,
DolphinScheduler — whose calendars, dependencies, retries, and alerting
they will not rebuild inside an agent platform. They need the agent to
be a task their scheduler can trigger, with the agent's execution
guarantees (exactly-once runs, a durable ledger, recovery) intact, and
they need the agent to operate their scheduler in return (query, trigger,
and manage nodes).

The architecture must therefore answer three questions without naming a
product in the control plane: how an external scheduler's trigger
becomes a run with a stable identity; how retries and backfills from any
scheduler stay exactly-once; and where product-specific code lives. The
module boundary is already fixed: `managed-agent-server` keeps no
DataWorks or other product dependency, so the control plane may expose
only a generic surface.

## Current state

The facts below are from this repository at `41ffb223448`.

- **The built-in arm is complete for persistent targets.** H6 owns
  definitions (append-only revisions), the single-claim scanner
  (lease + fence + watermark), the run ledger, overlap and catch-up
  policies, the gate probe, and the persistent fire that commits a run's
  input and wake in one transaction. `per_run` child Sessions (H4) and
  channel delivery (H5) remain refused until their slices land.
- **External triggers are reserved, not built.** The run record's
  occurrence identity is a closed union: `schedule:<slot>`,
  `manual:<commandId>`, and `webhook:<eventId>` — the third is registered
  and refused at admission until the webhook ingress slice lands
  (`managed-automation-record.ts`, pinned by the `webhook-reserved`
  fixture). The H6 design names verified-event-ID webhook ingress as the
  later slice that owns it. Run triggers today are `scheduled`, `manual`,
  and `catch_up` (`AUTOMATION_RUN_TRIGGERS`).
- **A push path works today.** `POST /v1/agent-automations/{id}/runs`
  fires a manual run keyed by its `Idempotency-Key`; the occurrence is
  `manual:<commandId>`, replay-safe, with the same overlap admission and
  ledger as a scheduled fire. An external scheduler can drive this now,
  with its instance identity as the key.
- **Results are readable, not pushable.** The public runs API pages a
  definition's occurrences with their run/execution states; the H5
  `channel_delivery` outbox that would push a settled result is not
  landed.
- **Managed Sessions run MCP servers.** The Managed MCP runtime admits
  stdio and HTTP servers into a Session's catalog with discovery pins and
  budgets — the outbound tool surface an external-scheduler MCP server
  would ride.
- **Channel adapters are the packaging precedent, with a different
  bridge.** `packages/channels/*` (dws, github, gitlab, …) are
  product adapters outside the control plane, built on `channel-base`
  (a published package). Their bridges target the daemon/ACP
  (`AcpBridge`, `DaemonChannelBridge`), not the control plane; a Managed
  adapter needs a control-plane API client instead.

## Goals

- One execution path and one run ledger for both timing owners: the
  built-in scanner and any external scheduler.
- A generic, product-agnostic external-trigger contract with stable
  occurrence identity, so DataWorks, Airflow, and DolphinScheduler
  adapters differ only in translation, never in execution semantics.
- Exactly-once runs under external retries and backfills, inheriting the
  H6 dedup, lease, and fence machinery.
- Bidirectional integration: external schedulers trigger runs (inbound),
  and the agent operates external schedulers through admitted tools
  (outbound).
- Product code outside `managed-agent-server`, in the open-source repo,
  following the channel adapter precedent.

## Non-goals

- **Rebuilding external schedulers.** Calendars, DAG dependencies,
  backfill orchestration, and alerting stay with the external product;
  Managed Agent executes what arrives and reports what happened.
- **A second execution path.** External triggers create the same
  `automation_run` records through the same funnel; no parallel runner.
- **Product APIs in the control plane.** The ingress contract names no
  DataWorks, Airflow, or DolphinScheduler field; adapters translate.
- **H4/H5 redesign.** `per_run` Sessions and delivery callbacks are
  consumed when their slices land, not specified here.
- **Concrete product API contracts.** This design fixes the properties
  an adapter must preserve; the actual DataWorks/Airflow/DolphinScheduler
  event, auth, and OpenAPI shapes are inputs from the product teams.

## Decisions

1. **Two timing owners, one ledger.** The built-in H6 scanner owns
   cron-derived timing; an external scheduler owns its own timing and
   pushes triggers. Both produce `automation_run` records in the target
   Session's journal through the same funnel, with the same run block,
   overlap admission, and settle path. Nothing about execution,
   recovery, or observability forks by timing owner.
2. **The built-in arm keeps its policies.** H6 definitions, the gate
   probe, and the `/loop` designs ride as they are. This design adds no
   cron capability; the only built-in change is the scanner's discovery
   filter (decision 11) — its firing, recovery, and settle policies are
   untouched.
3. **External triggers are first-class occurrences.** The webhook ingress
   slice activates the reserved `webhook:<eventId>` identity. The
   `eventId` is the external scheduler's verified, stable instance
   identity — the property every named scheduler has (a DataWorks
   schedule instance, an Airflow DAG run / task instance, a
   DolphinScheduler process / task instance). The ingress composes the
   `eventId` from the verified source and the raw instance identity
   (`<source>:<instanceId>`), so two products reporting the same raw id
   never collide on one occurrence; the control plane never parses the
   raw identity. A run records its trigger kind so the ledger
   distinguishes an external fire from a manual or scheduled one.
4. **The zero-change path is manual run, honestly labeled.** Until the
   ingress slice lands, an adapter drives
   `POST /v1/agent-automations/{id}/runs` with the external instance
   identity as the `Idempotency-Key`. The adapter maps the product
   identity deterministically into the key's 1–128 visible-ASCII bound
   (`^[\x21-\x7e]{1,128}$`, a stable digest when it does not fit), so
   retries of one instance derive one key. The definition the adapter
   targets is created `enabled: false`: the manual-run route consults
   only the live state, while the scanner's `findArmed` filters
   `is_enabled = TRUE`, so the built-in scanner never also fires it
   (decision 11's transitional mechanism). This is exactly-once and
   durable today, but the ledger records it as `manual` — adapters and
   operators must not read that as "a human ran it". The ingress slice
   upgrades the same flow to a `webhook` trigger; to keep dedup across
   the cutover, the ingress first admits on the committed
   `manual:<eventId>` key and mints `webhook:<eventId>` only for unseen
   events (decision 8), so a retry of an already-admitted instance never
   runs twice.
5. **The ingress contract is generic, authenticated, and scoped.** A push
   carries: a stable event identity (the `eventId`), a target (the
   definition or Session the run belongs to), an input payload (the
   prompt/context the run executes), and an authentication proof the
   ingress verifies before admission. Verification is the ingress's job
   — signature or token scheme is a slice decision — and an unverified
   event never reaches the funnel. The ingress resolves `target` strictly
   inside the verified source's tenant/Workspace binding and refuses
   anything else; the source's credential is tenant-scoped, so a
   correctly signed event naming another tenant's definition is refused
   before the funnel. The input payload is published as a durable
   per-occurrence `managed-input` resource before the claim, and the fire
   carries its reference: dispatch and replay read that resource, not the
   definition's prompt, so two events with different context execute
   different text and a crash after the claim preserves the original
   input. The contract is transport-agnostic (HTTP push first; a polling
   adapter may call the same admission path).
6. **Adapters live outside the control plane, in the open-source repo.**
   `packages/channels/dataworks` is the first adapter; Airflow and
   DolphinScheduler follow the same shape. An adapter translates product
   events into the generic ingress and product credentials into
   control-plane credentials; it owns the product's retry/backfill
   semantics at the edge. Its runtime is a control-plane API client, not
   the daemon channel bus — the channel packaging is the precedent, the
   bridge differs. `channel-base` primitives may be reused but its
   published export shape must not change for this work.
7. **Outbound orchestration is an admitted MCP tool surface.** Operating
   an external scheduler (query nodes, trigger runs, manage schedules)
   rides a per-product MCP server admitted through the Managed MCP
   runtime — DataWorks OpenAPI first. Side-effectful operations obey the
   Session's permission rules like any other tool; the agent is an
   orchestrator under the same approval model, not a privileged bypass.
   The concrete operation set is an input from the product team, bounded
   by what its OpenAPI exposes.
8. **Exactly-once is inherited, not reimplemented.** An external retry or
   backfill that repeats an event identity meets the committed occurrence
   and replays it — the same structural dedup a repeated manual key gets.
   Because the run identity hashes the full occurrence key, the
   `manual:` → `webhook:` cutover would otherwise re-run a lost-response
   instance under a new key; the ingress therefore admits a retry on its
   original committed `manual:<eventId>` occurrence and only mints
   `webhook:<eventId>` for an event never admitted on either entrance.
   Catch-up for missed external events belongs to the external scheduler:
   the ingress executes what arrives, deduplicated, and never synthesizes
   a missed external slot. Overlap admission applies as it does for any
   fire; a busy target queues or skips per the definition's policy.
9. **Result consumption stays open.** Polling the runs API works today
   and is the baseline. A push callback (the agent's settled result
   driving a downstream node) rides H5 when it lands; this design does
   not bake a callback shape into the ingress contract, so the decision
   can be made per product without a contract change.
10. **Session model and tenancy are adapter-mapped.** A trigger targets a
    persistent bound Session today; `per_run` isolation per external
    instance arrives with H4 and is the natural model for schedulers that
    expect independent task runs. The adapter maps product
    tenant/project/workspace identity onto control-plane
    tenant/Workspace/Session under the platform's authorization; no
    product secret enters the journal (credentials ride the existing
    credential handling, payloads carry references).
11. **Externally-driven definitions are excluded from cron derivation,
    not from recovery.** A definition created for external triggering
    must not also derive cron slots — otherwise the two timing owners
    double-fire one definition. The exclusion is narrow: the scanner's
    armed-definition query (`findArmed`) skips it, but its pending-fire
    recovery (`findFiringSchedules` / redrive) still completes a durably
    claimed external occurrence whose Harness relay was lost, exactly as
    it does for a disabled definition's manual run. The timing source is
    a discriminated property of the definition record — built-in
    `cron` + `timezone` xor an external trigger source — added in the same
    schema revision that lifts the `webhook` refusal (the `Schedule` body
    is a closed key set with a mandatory `cron`, so this is a contract
    change, not a decorative field). Until that marker lands, the
    transitional mechanism is `enabled: false` (decision 4), which
    `findArmed` already filters and the manual-run route already ignores.

## The pipeline, step by step

| Step | Where                        | Commit                                                                                                                                                                                                          |
| ---- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | external scheduler           | its own calendar/dependency fires an instance (outside Managed Agent)                                                                                                                                           |
| 2    | adapter (edge)               | translates the product event into the generic ingress: eventId, target, payload, auth proof; product retries stay at the edge                                                                                   |
| 3    | ingress (control plane)      | verifies the auth proof; binds target to the source's tenant/Workspace; composes `<source>:<instanceId>`; publishes the payload resource; dedups by eventId (manual key first) against the committed occurrence |
| 4    | Harness funnel               | the per-occurrence input resource is published before the claim; the claim commits, then dispatch reads that resource; run + input + wake commit in one transaction (the existing persistent fire)              |
| 5    | wake pump                    | the run's turn executes; `turn.settled` settles the run                                                                                                                                                         |
| 6    | result consumption           | polling the runs API today; an H5 callback later, per product decision                                                                                                                                          |
| 7    | outbound (agent → scheduler) | the agent calls the product MCP server's admitted tools under the Session's permission rules                                                                                                                    |

## Contract touchpoints

- `packages/core/src/managed-runtime/managed-automation-record.ts`: the
  `webhook` occurrence refusal lifts in the ingress slice; the `Schedule`
  body gains the discriminated timing source (decision 11) in the same
  schema revision, replayed by both hosts' fixtures.
- `packages/core/src/managed-runtime/managed-automation-operations.ts`:
  `AUTOMATION_RUN_TRIGGERS` and its envelope trigger check gain the
  external kind, plus the Harness-side trigger validator — the new kind
  must reach all three, not only the record file.
- `AutomationScanner` (control plane): `findArmed` skips externally-driven
  definitions; `findFiringSchedules` / redrive still recover them
  (decision 11).
- The ingress surface (new): admission, verification, target binding,
  payload publication, and the generic event shape, with `SurfaceRegistry`
  entries, the OpenAPI contract, `ManagedAgentApiContractTest`, and
  `SurfaceRegistryGateTest`.
- `ManagedAutomationService` / the Harness funnel: the fire carries the
  per-occurrence input reference and dispatch reads it; the claim/dispatch
  ordering is unchanged.
- `packages/channels/dataworks` (new): the first inbound adapter and the
  DataWorks OpenAPI MCP server (outbound); Airflow/DolphinScheduler
  adapters follow the shape.
- The Managed MCP runtime: unchanged; the product MCP servers are
  admitted through it.
- `channel-base`: reused, not reshaped (published package).

## Validation plan

- Fixture parity: the activated `webhook` occurrence and the new trigger
  kind replay identically on both hosts; the `webhook-reserved` fixture
  flips in the same change that admits it.
- Identity dedup: a repeated event identity replays the committed run and
  never creates a second; two adapters repeating one instance converge on
  one run. Two sources reporting the same raw instance id produce two
  runs (the `<source>:` namespace).
- Cutover dedup: a run committed through the manual bridge whose response
  was lost, then retried through the ingress, yields exactly one run — the
  ingress admits on the committed `manual:<eventId>` key.
- Verification and scoping: an unverified or wrongly-signed event is
  refused before the funnel; a correctly signed event naming another
  tenant's definition is refused; a verified, in-scope event admits.
- Per-occurrence input: two events with different context execute
  different text; a crash after the claim preserves the original input on
  redrive.
- Manual-path honesty: the zero-change path records `manual`, is
  exactly-once under the instance key, and targets an `enabled: false`
  definition the scanner never fires; the ingress path records the
  external trigger kind.
- Overlap and busy-target: an external fire meets the definition's
  overlap policy exactly as a scheduled fire does.
- Cron-derivation exclusion with recovery: an externally-driven definition
  derives zero `schedule:*` occurrences, yet a lost-relay claim is
  completed by `findFiringSchedules` / redrive after a restart; a built-in
  definition is never fired by the ingress.
- Outbound admission: the product MCP server's side-effectful tools obey
  the Session's permission rules; a denied operation does not execute.
- Adapter isolation: a product credential never appears in the journal;
  the control plane parses no product field.
- Mutation checks: each guard disabled in turn fails a test (the dedup,
  the verification, the trigger-kind record, the permission admission).

## Acceptance criteria

- An external scheduler instance triggers exactly one run, and a retry of
  the same instance replays it rather than creating a second — including
  a retry that crosses the manual-to-webhook cutover after a lost
  response.
- The ledger distinguishes an external trigger from a manual or scheduled
  run.
- An externally-driven definition derives no cron occurrence and is never
  double-fired by the built-in scanner, while a lost-relay claim still
  recovers.
- A correctly signed event naming another tenant's definition is refused
  before the funnel.
- The control plane contains no product-specific field or dependency; a
  second scheduler adapter reuses the same ingress without a control-plane
  change.
- The agent operates the external scheduler through admitted MCP tools
  under the Session's permission rules.
- Results are readable through the runs API; a callback, if chosen, rides
  H5 without an ingress contract change.

## Open questions

1. **Result consumption.** Polling is the baseline; whether DataWorks
   (and later products) need a push callback to drive downstream nodes
   decides H5's priority. Undecided by the product team.
2. **Per-instance Session model.** Whether external instances want
   `per_run` isolation (H4) or a persistent bound Session is a product
   decision; the ingress targets either without a contract change.
3. **Ingress authentication scheme.** Signature vs token, and how product
   credentials map to control-plane credentials, is settled in the
   ingress slice with the platform's auth model.
4. **Outbound operation scope.** The concrete DataWorks OpenAPI operation
   set (and later Airflow/DolphinScheduler) is an input from the product
   teams, bounded by what their APIs expose and the permission model
   admits.

## Inputs needed from the product teams

- The stable instance identity each scheduler exposes (DataWorks schedule
  instance; Airflow DAG run / task instance; DolphinScheduler process /
  task instance) and its retry/backfill semantics.
- The event/auth contract for push (or the polling API) and the credential
  model.
- The OpenAPI surface for outbound orchestration and its permission
  expectations.
