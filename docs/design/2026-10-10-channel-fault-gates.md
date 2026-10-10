# Channel fault gates (FG7)

[English](2026-10-10-channel-fault-gates.md) | [简体中文](2026-10-10-channel-fault-gates.zh-CN.md)

## Problem and scope

Issue #13802 is the next Stage F slice of #12380: FG6-style multi-process
fault gates for the **channel domains**, which #13572 enabled for submission
(`channel_route`, `channel_delivery` in `MANAGED_SESSION_ENABLED_DOMAINS` at
`managed-session-records.ts:137-138`, verified at HEAD `c3968ace2f`, schema
at Flyway V57 — the channel tables are V47 and V55). Nothing proves those
records stay honest when a reply is lost, a process dies mid-send, or the
provider's answer is ambiguous — and a channel side effect leaves the
process: a re-send is a user-visible duplicate, and a silent `accepted`
without a receipt is a lie the record cannot retract.

This slice adds the gates, following the FG6 shape: real packaged binaries,
a fault-injecting proxy, a real MySQL/MariaDB, and a named mutation check
per gate. It touches **no production code**. It stays channel-scoped: the
`schedule`/`automation_run` gap that #13598 opened is a separate tracker
(the triage comment on #13802), and H5d's multi-segment plans are out (see
decision 2).

## Current state

- The full multi-process channel chain exists only in production wiring:
  adapter (`ManagedEmailAdapter`) → internal adapter surface
  (`ManagedChannelAdapterController`, no HTTP coverage today) →
  `ManagedChannelService` → `QwenHostedHarnessConnector.runChannelOperation`
  → packaged Harness (`POST /session/:id/channels/operations` →
  `HostedChannelSession`) → journal → Session Store. Existing tests stop one
  hop up on both sides: Java uses an in-process `RecordingHarness`
  (`ManagedChannelServiceTest`, H2); TS uses a local JSONL store
  (`hosted-channel-session.test.ts`) or a fake control plane
  (`managed-email-adapter.test.ts`).
- The Hosted lane machinery FG7 reuses: `HostedWorkspaceToolTurnIT` carries
  FG6a/b/d/e/f in one class — FG6a/b/d/f take per-letter case selectors
  (`-Dqwen.fg6a.case` etc.), FG6e is a single case and has none;
  `HostedProcessCrashIT` + `HostedProcessCrashFixtureMain` run Spring in a
  killable child JVM for FG6c;
  `integration-tests/helpers/hosted-harness-process.ts` boots the packaged
  `dist/cli.js serve`; `integration-tests/fake-openai-server.ts` supplies
  the deterministic model; each fault class has a parametric TS driver
  with an embedded reverse proxy; SQL triggers inject store failures
  (`FG6B_*` markers asserted in the Spring log).
  `check-failsafe-reports.js hosted` forces every `Hosted*IT` to run in
  the `hosted-harness-mysql` CI job and nowhere else.
- Relevant production guards under gate: the V47 route-row redelivery
  answer and the funnel's `inputId` replay (`ManagedChannelService:206-232`,
  `hosted-channel-session.ts` submit replay); claim idempotency
  (`claimOne` + funnel `claim` on `sending`); receipt idempotency by
  `providerMessageId` (funnel `receipt`); record-first-then-ledger ordering
  with reconciler convergence (`reconcileClaim`'s pre-settle converge);
  adapter outbound persistence before send and outcome persistence before
  report (`managed-email-adapter.ts` `send`, `reportOrphanedOutbound`);
  ambiguous-SMTP → `unknown` classification (5xx → `rejected`, everything
  else `unknown`); the 10-minute claim lease sweep; the funnel's `cancel`
  (planned → `cancelled`; sending → `cancelRequested` flag only); the
  dense-ordinal refusal (`ManagedChannelRecords.java:124`,
  `HostedChannelSession.receipt`); the `unknown → delivered` honest
  recovery step (`ManagedExtensionRecords.TRANSITIONS`).

## Scope decisions

1. **FG7e is re-scoped; there is no SSE surface to gate.** Channels publish
   no events at all (`ManagedChannelService` appends to no stream);
   deliveries are exposed read-only over a cursor-paginated REST ledger
   (`GET /v1/agent-channels/{id}/deliveries`, Base64 `createdAt:id`
   cursor). "Disconnect the event stream, resume with `Last-Event-ID`,
   assert no duplicates and no gaps" cannot be written today (the triage
   comment's option B). FG7e therefore gates **read-ledger continuity**:
   cursor-stable, duplicate-free, gap-free pagination across a client abort
   and across delivery progress — the assertion SSE-resume would have made,
   targeted at the surface that actually exists. It is deliberately not
   filed under an SSE name.

2. **FG7f gates the `unknown` family; `partial` has no v1 producer.** The
   email plan is one segment (`planChannelSegments` returns exactly one,
   `managed-channel-operations.ts:556`), and `partial` requires
   `settled > 0 && settled < segments.length` — unreachable with one
   segment. The successor-rule witness for `partial` exists at contract
   level (`managed-channel-record.ts:458`); a multi-process `partial` gate
   needs H5d's multi-segment plans and belongs to that slice. What this
   gate proves at full stack is the honest half of the delivery line that
   v1 can reach: ambiguous provider answer → `unknown`, a receipt that
   never arrives → lease-settled `unknown` (never auto-resent), an
   out-of-plan ordinal → refused without advancing the delivery, recovery
   re-reading the original identity (never re-sending), and the explicit
   resend chain carrying only unsent segments with its duplicate warning.

3. **FG7d drives cancellation through the production connector relay.**
   The adapter surface has no cancel verb (correctly — no Java caller);
   the funnel's `cancel` is reachable over the Harness operations route,
   which authenticates by the Harness-issued `X-Qwen-Client-Id`. The IT
   calls `spring.getBean(HarnessConnector.class).runChannelOperation(tenant,
sessionId, {kind:"cancel_delivery", ...})` directly — the same generic
   relay `ManagedChannelService` uses, no probe bean — so the gate drives
   the exact production path with correct auth and adds no production
   surface.

4. **Two IT classes, like FG6.** Reply/store/cancel/read/unknown gates run
   against an in-JVM Spring (`HostedChannelFaultGatesIT`,
   `-Dqwen.fg7X.case` selectors); crash gates need a killable control
   plane, so they run Spring in a child JVM
   (`HostedChannelProcessCrashIT` + `HostedChannelCrashFixtureMain`). Both
   names place them in the `hosted-harness-mysql` lane automatically; the
   `mysql-integration` lane excludes `Hosted*IT`. Harness-kill is not in
   this slice: Session-level Harness restart is already gated by the
   `test:e2e:managed-harness-restart-*` lanes, and the channel-specific
   settlement on reopen (`reconcileReplies`) is unit-gated at the funnel.

## The gate ledger

`one send` always means the fake SMTP observed exactly one physical send
for the delivery's segments; Java-side ground truth is JDBC over
`qwen_managed_channel_{instance,binding,claim,route,delivery}`, the Session
Store journal, and the captured Spring log; every case asserts its fault
actually fired (proxy drop counter, `FG7B_<case>` SQLException marker, or
the crash fixture's injection count).

### FG7a — lost adapter ⇄ control-plane replies

The driver embeds a reverse proxy in front of the internal listener; a
lose-once fault forwards the request, consumes the committed upstream
response, then destroys the reply. The adapter re-drives from its
persisted state. The claim arm fires on the first answer that **carries**
a delivery: the outbox scans ahead of the plan always answer
`deliveries: []` and must not count.

One semantics note, discovered by the gate: a lost `deliveries:claim`
answer strands the delivery `sending` — discovery serves `planned` and
`partial` only, so no second dispatch is possible (the at-most-once the
issue asks for) and the honest terminal is the lease reconciler's
`unknown`, never a silent advance. If a later slice adds claim replay
keyed by the claim row, `claim-reply`'s expectation upgrades from
`unknown` to `delivered`; the gate pins today's surface deliberately.

| Case            | Injection                                                            | Expect                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbound-reply` | Drop one POST `/inbound` answer after commit                         | The adapter's pending event re-drives by identity: one V47 row (`admitted`, one `inputId`), one journal input, one model call, one delivery planned, one final send |
| `claim-reply`   | Drop the first carrying `deliveries:claim` answer after it committed | Nothing sends (the segments were never learnt); retries never mint a second claim row; the lease settles the strand `unknown`; a cold adapter never auto-resends    |
| `receipt-reply` | Drop one `…:receipt` answer after record+ledger committed            | The persisted outbound receipt re-drives idempotently by `providerMessageId`: one send, ledger `delivered` with the original receipt                                |

### FG7b — store failures

Test-only SQL triggers, tenant- and table-scoped, installed and dropped per
class like FG6b. Reply-loss here means the adapter restarts behind a commit
whose answer it never saw.

| Case                   | Injection                                                                                        | Expect                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `route-admit`          | One-shot trigger fails the V47 route-row `admitted` UPDATE after the Harness committed the input | Re-drive answers the committed admission by `inputId` (no second input, no second model call); the retry succeeds after the trigger is spent                                                                             |
| `delivery-commit`      | One-shot trigger fails the delivery-ledger UPDATE during `receipt`                               | The record is already `delivered`; the delivery is not re-sent; recovery (receipt re-drive or the reconciler's converge step) lands the ledger at `delivered` with the original provider receipt — never a duplicate row |
| `commit-reply-restart` | `receipt` answer destroyed, then the adapter process restarts                                    | Cold `reportOrphanedOutbound` replays the persisted accepted receipt; exactly one send, one ledger row, `delivered`                                                                                                      |

### FG7c — process crashes (`HostedChannelProcessCrashIT`, POSIX-only)

Spring runs in a child JVM killed by the IT; the adapter driver is a
killable/stoppable process. The lease machinery is deterministic, not
wall-clocked: the production sweep stays inert
(`claim-lease=30m`, `scan-delay=30s`), the claim row is back-dated by
SQL, and one reconcile pass is driven explicitly (the bean in-JVM; the
`/control/expire` + `/control/reconcile` endpoints of the fixture JVM).

| Case                   | Injection                                                                                                | Expect                                                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spring-kill-dispatch` | Relay the carrying claim answer, destroy it, then SIGKILL Spring; bounce it behind the adapter's retries | Nothing sends; one claim row; the strand settles `unknown` by lease; cold start never auto-resends                                                                                                                                                                                          |
| `spring-kill-receipt`  | Relay the receipt answer, then SIGKILL Spring                                                            | Restart; the receipt re-drive settles idempotently: one send, one `delivered`                                                                                                                                                                                                               |
| `adapter-kill`         | SIGKILL the adapter after the fake SMTP accepts, before the receipt persists                             | Lease sweep settles `unknown` (the provider may hold the message); the cold adapter settles its orphaned outbound `unknown`; nothing auto-re-sends; an explicit `:resend` opens `<id>:r1` carrying only the unsent segment, warns `possibleDuplicate`, and delivers with its own Message-ID |
| `adapter-stop`         | SIGSTOP the adapter after accept; let the lease settle `unknown`; SIGCONT                                | The re-driven persisted receipt lands the legal `unknown → delivered` step with the original receipt; one send throughout                                                                                                                                                                   |

### FG7d — cancellation (production-relay-driven `cancel_delivery`)

| Case               | Injection                                                                                 | Expect                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-planned`   | Cancel after the journal holds `planned`, before any pull                                 | The record settles `cancelled`; the outbox never returns it; zero sends; no claim or delivery-ledger row exists                                                               |
| `cancel-sending`   | Claim with the fake SMTP parked, cancel, then release the send                            | `cancelRequested` is recorded while `sending`; only the physical settlement terminates: the send completes once, the receipt commits `delivered`, the record carries the flag |
| `cancel-replay`    | Cancel a `planned` delivery, then re-drive the identical cancel as if its answer was lost | The second cancel answers the committed `cancelled` unchanged; one terminal record; zero sends                                                                                |
| `cancel-unsettled` | Cancel while sending, then the adapter dies before the receipt; lease expiry              | The terminal is the physical `unknown`, carrying `cancelRequested=true` visibly; no fabricated `cancelled`; one send                                                          |

### FG7e — read-ledger continuity (re-scoped, decision 1)

| Case                      | Injection                                                                                                                                           | Expect                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delivery-page-resume`    | Create two deliveries (two turns over one claim), read with `limit=1`, abort one page fetch mid-body, resume by cursor while the states keep moving | The union is duplicate-free and gap-free in stable newest-first order; a from-scratch re-read returns the same identities with honestly advanced states |
| `delivery-state-progress` | Interleave the reads of one delivery across `planned → sending → delivered`                                                                         | Every page state is a state the ledger actually held; no read ever reports `delivered` before the receipt commit                                        |

### FG7f — partial and unknown delivery (decision 2)

| Case                    | Injection                                                                                                        | Expect                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider-ambiguous`    | Fake SMTP accepts the bytes, then fails the answer without a 5xx code (timeout)                                  | The adapter classifies `unknown` and posts it; one send, no retry of the send; the next delivery is unaffected                                                                                                      |
| `receipt-never-arrived` | Fake SMTP accepts; the adapter stops cold before reporting (driver halts the loop, does not restart its receipt) | The lease sweep settles `unknown`; a later adapter (fresh cold start) does not auto-re-send; explicit resend carries only the unsent segment and delivers                                                           |
| `out-of-plan-ordinal`   | The driver posts a receipt for ordinal 1 on the one-segment delivery, while the claiming adapter is parked       | Refused deterministically: the funnel's `has no segment` lands as 409 `channel_operation_conflict`; the delivery neither advances nor is re-sent; the correct ordinal 0 receipt then settles `delivered` — one send |

## Fixture design

**Java.** `HostedChannelFaultGatesIT` starts one
`ManagedAgentServerApplication` in-JVM per letter the way
`HostedWorkspaceToolTurnIT` does (workspace mounts, registry/access rows
seeded by JDBC, MySQL properties mandatory — absence fails), plus
`qwen.managed-agent.channels.enabled=true` and
`qwen.managed-agent.internal-server.port` on a probed free port (the
`BrokerSecurity`/ `Issue13180InternalPortTest` pattern — first boot of
the adapter surface in any test), and the session-store base-url pinned
to that internal port (`BrokerSecurity` requires it).
`session-store.workspace-id`, `harness.workspace-files-enabled`, and a
`durable-local-process=false`/`trusted-local-reboot-recovery=false`
pair keep the workspace chain honest on macOS. Cancellation drives
straight through
`spring.getBean(HarnessConnector.class).runChannelOperation(...)` with
`kind: cancel_delivery` — the production relay, no probe bean. Triggers
copy the FG6b DDL shape with `SIGNAL SQLSTATE` text `FG7B_<case>`,
scoped to the case tenant, asserted in the captured Spring output.
`HostedChannelProcessCrashIT` +
`HostedChannelCrashFixtureMain` mirror `HostedProcessCrashIT`: child JVM,
`FG7C_*` env, atomic `ready.json` carrying `internalUrl`/`controlUrl`,
a per-case kill before the next boot, and the
`/control/expire` + `/control/reconcile` endpoints for the lease.

**Driver.** `integration-tests/helpers/hosted-channel-fault-driver.ts`,
launched per step as `node --import tsx … <driver.json>` like every FG6
driver. It owns: the embedded fault proxy (lose-once per named verb,
header relay via `hosted-relay-headers.ts`, the fault arm content-aware:
a claim loss fires only on an answer that carries ≥1 delivery); the real
`ManagedEmailAdapter` (from `@qwen-code/channel-email`'s build output)
with test deps — a scripted FakeImap (one mailbox whose scripted message
carries a deterministic `(channel, uid)` Message-ID, so a re-driven event
never mints routes by content, and an open-time empty cursor so the
message is admitted, not skipped as history), a scriptable FakeSmtp
whose `sendMail` records every send and can park behind a release file
(`smtpMode: park`), hold after accept (`holdAfterSendFile`), or timeout
without a code (`accept-timeout`), a noop lock, the real `mailparser`,
and a recording control-plane client wrapping the production
`HttpManagedChannelControlPlane` — the wire shape is identical to
production, the evidence recorded beside each call; no client timeout
(a claim over cold Sessions legitimately takes its time).
`pollLoop: false`: the phases drive `tick()` or the
inbound-only `poll()` as separate steps — the `pull-terminate` phase
parks at its kill marker instead — so the IT sequences around
cancellations and kills, with `expectedSends` for multi-delivery pulls
and `holdAfterDrop` for the zero-send fault windows. State lives in a
per-case directory so a restart genuinely cold-loads it. Per-step stdout
markers (`FG7_READY`, `FG7_DROPPED <verb>`, `FG7_CLAIMED`, `FG7_SEND_DONE`,
`FG7_CLAIM_PARKED`, `FG7_HELD`, `FG7_AWAIT_KILL`, `FG7_PROBE_REFUSED`,
`FG7_RESEND`, `FG7_<phase>_OK`) sequence the IT; `results-<phase>.json`
carries the per-case evidence (send count and Message-IDs, admission
identity, relay attempts with drop flags, receipt outcomes, probe
status). For `adapter-kill`/`adapter-stop` the IT kills the driver
itself at the marker and relaunches with the same state dir.

**Harness and model.** The IT boots `dist/cli.js serve --profile
hosted-harness` on a pinned port with the broker URL of the embedded
broker (like FG6), and a canned OpenAI-compatible model answers every
channel wake turn with a short fixed reply per case, so one turn yields
one `<inputId>:reply` delivery with one small segment. The harness's
Workspace sessions need `hosted-workspace-files/1`; the harness therefore
starts with `--managed-runtime-broker-url` and the broker runs embedded
on a method-scoped pinned port (a pinned harness port resolves the
base-url/broker-url bootstrap cycle). The IT waits for journal facts via
JDBC instead of sleeping; pacing predicates name the driver's markers
(parked before reads), never row counts alone.

**Case states.** The Legacy-derived adapter state store keys on the
user-global qwen directory, so the IT gives every case its own `HOME`
(child of the per-case directory) — without it, a case re-runs against a
previous run's cursor and test state leaks into the real `~/.qwen`.
Persisted evidence (`results-*.json`, `driver-*.log`) lives under
`target/fg7-cases/`, rebuilt per method, because `@TempDir` is cleaned
on test completion.

**CI.** Both classes are picked up by `hosted-harness-mysql` (`Hosted*IT`
include; `check-failsafe-reports.js hosted` enforces it). Measured on
macOS (M3, JDK 21, Node 22, MariaDB 10.11): the fault class runs in
34.4 s for its five letters, the crash class in 25.1 s — ~60 s of test
time added, ~150 s of wall-clock on the shared fork; the budgets go
900 s → 1200 s (fork), 25 → 35 min (Verify step), and the
job 148 → 160 min, with `hosted-process-ci.test.js` pinning all three,
and a `hosted-channel-gates` focused profile for local runs. Local
database: a system `mysqld` with a throw-away datadir — MariaDB
initializes with `mariadb-install-db
--auth-root-authentication-method=normal`; MySQL 8 initializes with
`mysqld --initialize-insecure` as in
`scripts/run-managed-agent-server-e2e.ts` — trigger privileges required,
same as FG6b.

## Mutation checks

Each mutation is applied, shown to turn exactly its gate red, then
reverted (adapter mutations rebuild `packages/channels/email`, funnel
mutations re-bundle `dist/cli.js`, Java mutations recompile), following
the FG6 documented manual procedure:

1. FG7a — the service-side ingress identity derivation bypassed (`inputId`
   fresh per attempt instead of `chin-<routeKey>`): the second attempt
   mints a second route-row admission, a second input event and a second
   physical send (`inbound-reply` red — the duplicate-send class the
   gate exists to pin).
2. FG7a/b — the adapter mints a fresh `providerMessageId` on the receipt
   re-drive (the persisted outcome no longer proves identity): the funnel
   refuses `409` and the ledger never converges (`commit-reply-restart`,
   `receipt-reply` red).
3. FG7b — the funnel's receipt idempotency by `providerMessageId`
   refactored to a refusal: the re-drive dies `409`, the ledger never
   converges (`receipt-reply`, `commit-reply-restart`, `delivery-commit`
   red).
4. FG7b — `ManagedChannelService.receipt` drops its ledger step: the
   record and the ledger diverge permanently (`delivery-commit` red at
   the delivered-ledger assertion).
5. FG7c — the lease reconciler skips its `unknown` settlement: the strand
   hangs `sending` (`adapter-kill`, `claim-reply`, `spring-kill-dispatch`,
   `adapter-stop`, `cancel-unsettled`, `receipt-never-arrived` red).
6. FG7c — the funnel's `receipt` treats `unknown` as terminal: the late
   honest receipt can never land (`adapter-stop` red).
7. FG7d — the funnel's `cancel` settles a `sending` delivery `cancelled`
   immediately: `cancel-sending` red (terminal fabricated without physical
   settlement; the subsequent receipt fails).
8. FG7d — `pendingDeliveries()` returns `cancelled` deliveries:
   `cancel-planned` red (one send happens).
9. FG7e — the cursor tiebreak weakened to include the cursor row:
   `delivery-page-resume` red (duplicate at page boundary).
10. FG7f — ambiguous SMTP failure classified `accepted`:
    `provider-ambiguous` red (the record claims `delivered` without a
    proven receipt; the record/ledger stay `unknown` in the sane shape).

Two designed mutations are provably indistinguishable in v1 and are
**not** executed: making the funnel `claim` refuse `sending` (the
duplicate claim answer is invisible to an adapter whose first answer
died, because it only ever holds one copy), and making `resend` carry
all segments instead of the unsent-only set (the v1 email plan is one
segment, so the filtered and unfiltered resends are identical). Both
need the multi-segment plans of H5d, the same witness `partial` waits
for (decision 2).

## Validation and acceptance

- `npm run build && npm run typecheck`, ESLint clean on the driver,
  Checkstyle and SpotBugs on both new Java classes, and the module's
  surefire suite green (1606 tests at the first-verification baseline).
- Both new classes green on MariaDB 10.11 locally (the CI lane is MySQL
  8.4): 19 cases firing their declared faults — every drop counter,
  `FG7B_*` trigger marker and kill marker observed — per-case selectors
  working, happy-path channel flow green without any injection.
- Every mutation above individually red; source restored; the full gate
  green again.
- `hosted-process-ci.test.js` green with the new budgets, and
  `check-failsafe-reports.js hosted` satisfied after a full lane run.
- Two consecutive clean open-ended and reverse audit rounds per AGENTS.md;
  after round five only Critical fixes.
- This design lands in both languages and the delivery ledger gains the
  FG7 rows; a comment on #13802 records the FG7e re-scope and the FG7f
  `partial` deferral (H5d) so the tracker reflects the settled shape.

## Open questions

1. Whether the WebShell mirror routes a later slice adds should inherit
   the FG7e continuity assertions — left to that slice, noted here so the
   re-scope is recorded once.
2. Whether a `deliveries:claim` replay keyed by the claim row should be
   a later slice's work: today a lost carrying answer resolves by lease
   to `unknown` (decision recorded in FG7a); when that replay lands, the
   `claim-reply` gate's expectation upgrades to `delivered`.
