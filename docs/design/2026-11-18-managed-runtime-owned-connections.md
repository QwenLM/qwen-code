# Managed Runtime-Owned MCP/Hook Connection Lifecycle (Phase 2)

[English](2026-11-18-managed-runtime-owned-connections.md) | [简体中文](2026-11-18-managed-runtime-owned-connections.zh-CN.md)

Status: investigation + detailed design proposal, not implemented. Date: 2026-11-18. This is the pre-implementation design for Phase 2 of the [Stateless Hosted Harness design](2026-11-16-managed-stateless-harness.md) (#17527), verified line-by-line against the merged Phase 1 PR #17690 (merge `7150c58a01`, verification head `5dd947afe5d`). The parent design's Phase 2 "defines the boundary only; a separate design precedes implementation"; this document carries that boundary forward into a proposal, cost model, Phase 1 interaction, measurement plan, and feasibility conclusion. The cost share in the conclusion is a **code-level analytical estimate, not yet measured**; measurement is an implementation gate (parent design: "its share must be measured").

## 1. Problem and current state

Phase 1 suspends idle Sessions: teardown step 2 non-terminally closes Hook/MCP owners, and a cold open reinstalls them. For a Session with MCP configured, this means every suspend/reopen **physically disconnects and reconnects each MCP connection and rediscoveres its catalog**. This section verifies where that cost lives and who holds it.

### 1.1 Physical connections already live in the Runtime; the lifecycle is bound to the Harness attach

Three-layer ownership (consistent with the [MCP runtime design](2026-09-28-managed-mcp-runtime.md)):

- **Tool Runtime (worker process)** holds the physical transports. `ManagedMcpRuntime` in `packages/cli/src/serve/managed-mcp-runtime.ts` keeps `connections`/`operations`/`pendingStarts` keyed by `runtimeSessionId`; stdio child processes and HTTP/SSE connections live here. Quotas: `MANAGED_MCP_MAX_CONNECTIONS = 16` (`packages/core/src/managed-runtime/managed-mcp-protocol.ts`), `MAX_INFLIGHT = 32`, connection/discovery cap `TIMEOUT_MS = 25_000`.
- **Runtime Broker (Java)** resolves the Session and original Runtime, checks the Workspace owner, and forwards MCP control under the original identity. `RuntimeBrokerService.acquire/release/releaseMount` (`packages/managed-agent-server/runtime-broker/.../RuntimeBrokerService.java`).
- **Hosted Harness** holds the orchestration object `HostedMcpSession` (`packages/cli/src/serve/hosted-mcp-session.ts`) and the HTTP client `HostedWorkspaceBroker` (`hosted-workspace-broker.ts`); it commits intent/configuration records, dispatches control, and accepts receipts.

Key fact: **the worker process survives across attaches.** A local-process provider + workspace capability + `isolationClass = workspace` binding is workspace-shared (`HarnessOwnership.sharesRuntimeSessions`); one worker hosts several Runtime Sessions of that workspace. `WorkspaceRuntimeTransport.releaseMount` (`control-plane/.../WorkspaceRuntimeTransport.java`) states: "Only the execution mount … **The worker keeps the installation a re-drive reuses**" — handing back the mount does not stop the worker; only a full `release` runs `activateWorkspace(..., false)`. `JdbcRuntimeRetention` only cleans "unreferenced retired" generations; it does not stop live workers by idleness.

So "connections owned by the Runtime" **already holds physically**; what is bound to the attach is three things:

1. **The drain obligation**: on suspend/detach the Harness must dispatch `mcp-release` so the worker physically closes the connections.
2. **The mount hold**: the MCP owner holds the workspace's exclusive execution mount; suspension hands it back.
3. **Reinstall**: the next load re-commits configuration, reconnects, and rediscoveres.

### 1.2 Owner identity and the reconnect/reuse paths

- **Durable owner id**: `hostedDurableMcpOwnerId(sessionKey, configurationIdsDigest)` = `mcp-` + sha256, recomputed on every load from the non-released configuration rows (`hosted-mcp-session.ts`). Hooks use a config-scoped owner (`hosted-hook-session.ts`, `isHostedConfigScopedOwner`). A non-terminal close leaves no RELEASED tombstone; the owner stays re-acquirable.
- **Establish (cold open or first prompt)**: before declaring tools, the tool turn calls `mcp.refresh(signal)` (`hosted-workspace-tool-turn.ts`) → `ensureReady()` (memoized) → `initialize()` → **per-server sequential** `install()`:
  1. If the previous row is `drained`/`released`: commit drained→released first, then open a fresh active row under the **same owner** (commit);
  2. `acquireOwner()`: `broker.acquire()` (HTTP) + a grant-renewal commit for each non-released configuration with a catalogRef (`commitConfiguration(record, renew=true)` advances the durable revision);
  3. Commit `dispatch_started`; dispatch `mcp-configure` (worker: spawn stdio / connect HTTP + initialize + tools/resources/prompts list, ≤25s);
  4. Publish the catalog resource + commit settled + advance same-owner sibling drained rows to released.
- **Per turn**: `refresh()` → `ensureReady` (already memoized) + `acquireOwner` + an `mcp-discover` dispatch per catalog (a cheap status check on the live connection; reconfigure only if the catalog digest changed). **Both resident and cold turns pay this.**
- **Suspend teardown step 2** (`hosted-harness-session.ts` `attemptSuspend`): `hooks.close({terminal:false})` + `mcp.close({terminal:false})`. `mcp.close` = `reconcileEffects()` (settle all pending operations/configurations) + `closeResources()`: per-configuration `drainConfigurations` (commit releasing → dispatch `mcp-release` → worker physical close → commit drained) + `broker.releaseMount()` (hand back the mount; the owner stays re-acquirable).
- **The reuse path already exists**: when `install()` meets a `previous.releaseState === 'active'` settled row, it **only reads the saved catalog and verifies the digest, dispatching no mcp-configure**; `acquireOwner` reclaims the mount + renews the grant. Today this path serves crash reload (rows still active). **Phase 2 makes suspension also leave active rows, so it takes this reuse path.**

### 1.3 Hook current state

Hooks have no persistent transport — they are per-event dispatches into the worker, sharing the broker/mount with MCP (`HostedHookSession`). A non-terminal `close()` (`hosted-hook-session.ts`) = `drain()` (settle pending executions) + `releaseEarlierOwners` (release superseded old config-scoped owners) + recover recovered brokers + retry fenced owners, and finally for the current deterministic owner **only hands back the mount** (no terminal release). So a Hook's "connection cost" is mostly owner identity/mount sharing, not persistent connections; Phase 2 changes little for Hooks.

## 2. Goals and scope

**Goal**: suspend/reopen no longer drains, reconnects, or rediscoveres MCP connections. The Runtime retains connections across attaches and reclaims them on its own idle timer; the Harness re-acquires them via the durable owner identity + a grant issued to the new writer.

**Scope (this proposal, first increment)**:

- Suspension places the MCP owner in **parked** state (connections alive, mount held, grant expires naturally) instead of draining.
- Reopen takes the existing active-row reuse path; detects connections reclaimed by the Runtime and reinstalls.
- The Runtime adds **idle reclamation**: parked connections are physically closed after an idle duration, leaving a durable reclamation receipt.
- Recovery-view contract wording update + parked-owner observability.
- Minor parked-semantics adjustment for Hooks sharing the MCP mount.

**Out of scope (later increments)**:

- **Decoupling connection lifetime from storage ownership** (H1's open problem): allowing the mount to be handed back while parked connections stay alive. Requires fencing stdio servers' workspace writes; a larger safety project, not done here (see §5.4).
- Journal recovery cost (the part that grows with history) — the parent design states Phase 2 does not eliminate it.
- Phases 3/4 (wake scheduling, approval docking).

## 3. Cost model (analytical estimate, not measured)

### 3.1 Baseline restated

WP3 measurement (`.qwen/investigations/2026-11-18-wp3-suspension-cost-measurement.md`): cold-open overhead **~91 statements, flat** (1/40/200 turns), marginal idle saving 46/min/session, break-even ~2min. **That measurement used pure-text Turns, no Runtime workers, no MCP.** So ~91 is the **MCP-free floor**; MCP reconnect cost sits entirely on top of it, not "a small part of ~91". This reframes the handoff's challenge: the question is not "how much of ~91 is MCP" but "how much does MCP add on top of ~91".

### 3.2 MCP delta per suspend/reopen cycle (K = server count)

Counting commits per §1.2 (each `commitExtensionRecord` ≈ journal event + resource + `ma_session_record` projection + head revision update):

| Stage                        | Operation                                                                                                                               | Magnitude                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Suspend drain                | Per config: releasing commit + `mcp-release` dispatch + drained commit                                                                  | ~2K commits + K worker physical closes |
| Cold-open reinstall          | Per server: released commit + active-row commit + dispatch_started commit + catalog publish + settled commit + sibling drained→released | ~5K commits + K resource publishes     |
| Cold-open acquireOwner       | 1 broker.acquire + per-config grant-renewal commit                                                                                      | ~K commits + 1 HTTP                    |
| Cold-open physical reconnect | Per server **sequential** `mcp-configure`: spawn/connect + initialize + 3 lists                                                         | K reconnects+discoveries (each ≤25s)   |

Total cold-open MCP delta ≈ **6K–7K journal commits + K resource publishes + K sequential physical reconnects/discoveries**, plus ~2K commits + K physical closes on the suspend side.

**Latency is dominated by the sequential physical reconnect**: `initialize()` is `for...of` + `await`, reconnecting K servers in order. Local stdio ~100–500ms/server; remote/slow servers up to the 25s cap each. At K=16 the cold-open latency can add seconds to tens of seconds. This is the user-perceived wake latency and Phase 2's largest benefit.

### 3.3 What Phase 2 eliminates

After parked reuse, the reopen MCP path degrades to: `acquireOwner` (1 broker HTTP + ~K grant-renewal commits) + the per-turn refresh discover (already paid resident). **Eliminated**: suspend drain (~2K commits + K closes) + cold-open reinstall (~5K commits + K publishes + **K sequential reconnects/discoveries**). The cold-open MCP delta drops from ~7K commits + K reconnects to ~K commits + 1 acquire.

The benefit scales with K and reconnect latency; at K=1 fast local stdio the SQL benefit is modest (tens of statements), but the latency benefit remains.

### 3.4 Reconnect witness (the most easily observed measurement)

The IT fixture `hosted-mcp-fault-process.mjs` records `mcp.start` on each process start and `mcp.exit` on exit. Phase 1 adds +K `mcp.start` per cold open; Phase 2 parked reuse should add 0 (until idle reclamation). This is a direct reconnect witness independent of the SQL digest window.

## 4. Proposal

### 4.1 The parked owner state

Introduce a **parked** owner semantics: connections alive, mount held, journal configuration rows stay `active` + `run.state = settled`, grant expires naturally (`leaseDurationMs = 300_000`). Parked is not a new journal `releaseState` — the row stays `active`, and the reuse path recognizes it as such. Parked is a **Broker/worker-side** state ("no Harness holds this; start the idle countdown").

**Why no new journal state is needed**: `ManagedExtensionProjection.runtimeState` (`contracts/.../ManagedExtensionProjection.java`) derives from `run.state` — `settled` is TERMINAL → `runtime_state = null`, **independent of `releaseState`**. So a parked (active+settled) configuration row already satisfies the recovery view's "no live Runtime execution" criterion (§6.3). A new journal state would break the existing projection/recovery proof for no benefit.

### 4.2 Suspend path change

Teardown step 2 changes from drain to park for MCP:

1. **Still call `reconcileEffects()`**: settle all pending operations/configurations. Unsettled side effects still block suspension (as today; the eligibility predicate independently blocks `mcpBusy`/`mcpRecovering`). Parked connections are all settled with no unknown outcomes, so there is no unknown-outcome quota hold during park.
2. **Do not drain, do not hand back the mount**: skip `drainConfigurations` and `releaseMount`. Connections stay in the worker; the mount stays held.
3. **Park notification**: Harness → Broker a park verb (proposed `mcp-park` control kind or a session-level park); Broker → worker starts the idle timer for that owner's connections. A failed notification is revertible before seal (rearm), same shape as today's drain failure (§6.2).

Hook step 2: keep `drain()` + `releaseEarlierOwners` (superseded old owners), but the current deterministic owner **skips the mount handback** (kept held, shared with MCP).

Teardown step 3 `releaseLeaseNow` is unchanged: it already returns false for MCP-owned leases ("MCP configurations own their Runtime until their own drain completes" — after park the MCP owner still holds it).

### 4.3 Reopen reuse path

A cold open constructs `HostedMcpSession` (same durable owner) → the first prompt's `install()` sees an active+settled row → **reads the saved catalog, no reconnect**; `acquireOwner` reclaims the mount (no-op if already held) + renews the grant. This path exists today (crash reload); Phase 2 makes it the normal suspend/reopen path.

**Reclamation detection**: if the worker has idle-reclaimed the connection (or the worker restarted and the generation changed), reuse must detect and reinstall rather than recovery-block:

- `acquireOwner` today throws `HostedMcpRecoveryRequiredError` on a generation mismatch. Phase 2 distinguishes two cases:
  - **Worker generation changed** (restart): still recovery-required (the original Runtime is lost; reconcile via existing crash recovery).
  - **Same generation, connection reclaimed**: the worker reports the connectionGeneration retired + a durable reclamation receipt in the acquire/status reply. `install()` uses it to advance the active row to released (the receipt is the drain proof) → opens a fresh row and reinstalls (reconnect). This reuses the existing drained→released→reinstall machinery, only the trigger changes from Harness drain to Runtime reclamation.

### 4.4 Runtime idle reclamation

The worker adds a per-owner idle timer (started by the park notification, reset by grant renewal/any control). On expiry:

1. Physically close the owner's connections (same `closeConnection` as `drainSession`, but no pending work — reconciled before park).
2. Record a **durable reclamation receipt** (connectionGeneration retired + time), persisted via the Broker (queryable even after a Broker restart).
3. Free quota and the mount (handing back the mount lets other Sessions acquire the workspace).
4. The journal rows **do not change** (the Harness is suspended and cannot write); the next load's Harness reconciles against the receipt (§4.3).

**Who reclaims, and when** (the parent design's interface-to-define): the Runtime (worker) reclaims on its own idle timer, the Broker persists the receipt, and the successor Harness writer reconciles the journal. The idle duration is a release constant chosen by measurement (§7).

### 4.5 Quota

Parked connections count against the worker's shared 16-connection quota (across Sessions). Needed:

- **A parked budget**: a per-owner or global parked-connection cap, so many suspended Sessions cannot exhaust a shared worker's quota. Over the cap, suspension falls back to drain (graceful degradation to Phase 1 behavior).
- Idle reclamation frees quota, bounding the hold duration.
- Unknown-outcome holds: `reconcileEffects` settles before park, so parked has no unknown holds; if settlement fails, do not park (fall back to drain or stay resident).

## 5. Design decisions and rationale

### 5.1 Explicit park verb vs implicit grant expiry

Choose the **explicit park notification** (§4.2). Rationale: the parent design explicitly asks for "the distinction between 'park owner' and 'release owner' on the Broker"; an explicit verb makes the idle start deterministic, observable, and revertible before seal. The implicit form (the worker derives idleness from last-grant-renewal) couples idle to the grant lease (300s), has a fuzzy start, and needs extra worker tracking; it is a later optimization candidate.

### 5.2 No new journal releaseState

Parked rows stay `active`+`settled` (§4.1). Rationale: the reuse path recognizes `active`; the projection's `runtime_state` derives from `run.state` and is already null; a new state would break the recovery-view proof and the existing drained/released state machine for no benefit.

### 5.3 Reclamation receipt persisted at the Broker

Rationale: the Harness cannot write the journal while suspended; worker receipts are generation-local (H1: "Runtime generation-local receipts cannot be durably retained across physical Runtime loss"). Persisting the reclamation receipt at the Broker lets the successor load (even after a Broker restart) reconcile. This is the same shape as H1's release-receipt persistence.

### 5.4 Mount stays held (first increment); decoupling deferred

The mount stays held during park. Rationale: H1 states "releasing the lease early while a stdio server can still access the Workspace would allow concurrent writes; decoupling connection lifetime from storage ownership is follow-up work before production enablement". Holding the mount avoids concurrent writes and is consistent with H1's "one attached MCP owner per tenant/storage lease" restriction.

**Cost**: a suspended MCP Session continues to hold the workspace storage mount exclusively during park, blocking other Sessions on the same storage until idle reclamation. Acceptable for idle Sessions (the suspension target) — their workspace is rarely contended, and idle reclamation bounds the duration. **This is an explicit product trade-off that must be reviewed.** Decoupling (allow mount handback during park + fence stdio writes) is a later increment, done if workspace contention during park becomes a problem.

### 5.5 Suspension still frees Harness resources

The mount is a Broker-side claim, not a Harness resource. Holding it during park does not prevent the Harness from sealing the writer, releasing the activation, dropping the resident, and stopping renewal — all of Phase 1's core benefits (memory/ports/renewal SQL) are retained. Park only affects other Sessions' access to the same workspace.

## 6. Interaction with Phase 1

### 6.1 Eligibility predicate

`suspensionLiveWork` (`hosted-harness-session.ts`) blocks on `mcpBusy`/`hooksBusy`/`mcpRecovering > 0`, `heldRuntimeTurns`, live monitor loops, unsettled child/monitor runs, `clientFiles`, `streams`, and public-shell MCP without lifecycle v2. It **does not block** a private `hosted-workspace-mcp/1` Session merely for having MCP. Phase 2 keeps these: pending work still blocks suspension; parked idle connections are not "live work". Added: parked budget over cap → fall back to drain (§4.5).

### 6.2 Teardown ordering and the #8 bounded-recovery proof

Teardown order: wake → owners (step 2) → lease (step 3) → publishers → writer seal (step 5) → stopLocal. Phase 2 changes step 2 from drain to park (reconcile + notification), still at the revertible boundary before seal. A failed park notification → rearm (same shape as today's drain failure).

**The #8 proof holds** (`.qwen/investigations/2026-11-18-open-question-8-bounded-recovery-proof.md`): it relies on **writer fencing** (lease expiry → any acquire generation+1), **not on SEALED ⟹ resources released**. Resource obligations are reconciled by the successor cold open via the existing takeover/cleanup path. Park leaves resources under Runtime care; the successor cold open reuses or reinstalls — exactly the "same shape as existing crash recovery" branch the proof already declares. The proof structure is unchanged; it only needs parked-owner reconciliation to ride the existing takeover/cleanup path.

### 6.3 Recovery view

The recovery view ([supplement](2026-11-18-managed-suspension-recovery-view.md)) `ready` criterion requires `ma_session_record.runtime_state` to be empty. Verified: the `mcp_configuration` projection's `runtimeState` derives from `run.state`, settled → null, **independent of releaseState**. So a parked (active+settled) configuration row **already satisfies** the criterion; no projection change is needed. Required:

- Contract wording: "reinstall the owner" → "reuse or reinstall the parked owner".
- "No unsettled work" must still hold (no pending `mcp_operation`) — guaranteed by reconcile before park.
- A reclaimed-but-journal-active connection: the view may stay ready; the load reconciles (§4.3).
- Optional: parked-owner count in observability.

### 6.4 Cleanup debt

`hasHostedCleanupDebt` (`hosted-turn-cleanup.ts`) tracks `hosted.cleanup` owed events (turn-scoped Runtime leases). Does a parked MCP owner introduce a new debt class? If park is "reconcile + keep + notify", the only failure is reconcile failing to settle a pending operation — which already blocks suspension (recovery-required), as today. A failed park notification reverts before seal; after seal the successor reconciles. So **no new durable cleanup-debt class is introduced**; parked-owner reconciliation rides the §4.3 load path rather than the cleanup-debt scanner. This must be verified during implementation (§8).

## 7. Measurement plan (implementation gate)

Parent design: "its share must be measured". §3 is an analytical estimate; **measurement is an enablement gate**. Two paths:

### 7.1 Extend the WP3 rig (TS, recommended)

rig = `.qwen/scripts/measure-suspension-cost.ts` (MySQL8.4 + Spring exec jar + hosted-harness bundle + fake model, performance_schema digest-window method). Extend for MCP:

1. **MCP fixture server**: reuse `packages/managed-agent-server/verification/src/test/resources/hosted-mcp-fault-process.mjs` (self-contained stdio MCP, records `mcp.start`/`mcp.exit`).
2. **Manifest + worker wrapper**: write `mcp.json` (stdio, command=node, args=[fixture,'mcp',evidence,'1'], definitionDigest matching the session pin) + `worker.mjs` (sets `QWEN_MANAGED_MCP_CONFIG` then imports dist/cli.js, mirroring the IT). Spring sets `QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY` to the wrapper.
3. **Profile + workspace**: Spring sets `QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES=hosted-workspace-mcp/1`. The workspace needs IT-style registration (`ma_workspace` with `WorkspaceExecutionProfile.CONFIG_REF` + `ma_workspace_access` + storage guard register) so the broker scope capabilityDigest = `WORKSPACE_CAPABILITY_DIGEST` (accepted by the TS broker `readRuntime`). **Note**: the IT builds the stack with Java beans (`guard.register`, `store.insertWorkspaceSessionCommand`); the TS rig needs HTTP/SQL equivalents — the main engineering difficulty.
4. **Agent definition + session**: POST `/v1/agents` (`tools:[{type:hosted_profile,profile:hosted-workspace-mcp/1}]` + `mcp_servers` pin + `permission_policy:{approval_mode:yolo}`), then POST `/v1/agents/sessions`.
5. **Measure**: as the rig (resident-turn baseline → wait for suspension → cold-open turn), digest window for the SQL delta; additionally count `mcp.start` events in the evidence file (reconnect witness). Compare K=1/4/16.

### 7.2 New Java IT (alternative)

Add an IT in the verification module, building the stack like `HostedMcpRestartFaultGatesIT` (real Harness + worker + MySQL) but measuring suspend/reopen SQL + timing + `mcp.start` count. Needs the Maven isolated repo + sibling SDK install (see memory managed-agent-maven-isolated-verify) + the `mysql.url` system property. Pro: the stack-build steps are already solved by the IT; con: the Maven verification chain is heavy.

### 7.3 Measurement outputs

- Cold-open MCP delta statements (K=1/4/16) vs the §3.2 estimate.
- Cold-open MCP delta wall-clock (sequential reconnect latency).
- Suspend drain delta statements.
- `mcp.start` reconnect count (Phase 1 +K/cold open).
- Use these to choose the idle-duration release constant and parked budget, and confirm the benefit is worth it (§9).

## 8. Constraints and risks

- **Extended mount exclusivity** (§5.4): a parked Session keeps exclusive workspace storage until idle reclamation. Needs product review; idle reclamation bounds the duration.
- **Reclamation reconciliation correctness**: a reclaimed connection's journal row is still active; the load must reinstall against the durable receipt rather than wrongly reuse the old catalog. Implementation must verify the two paths — worker restart (generation changed) vs connection reclamation (same generation) — are each correct (recovery-required vs reinstall).
- **Quota exhaustion**: many suspended Sessions' parked connections exhaust a shared worker's 16 quota → new Session configuration fails (`managed_mcp_connection_quota`). Parked budget + idle reclamation + over-cap drain fallback mitigate.
- **Park notification racing seal**: a failed notification must revert before seal; a notification lost after seal is reconciled by the successor load (if the worker never saw the park notification the connection stays alive and reuse proceeds normally; if the idle timer never started the connection lives forever — needs a worker-side grant-expiry idle fallback so a lost notification does not prevent reclamation).
- **Long-lived stdio process resources**: a parked stdio server is a long-lived process in the worker, holding memory/FDs. Idle reclamation bounds it; H1's deployment constraints ("stdio HOME/USERPROFILE is the Workspace", etc.) carry over.
- **Coupling with the detach path**: suspension reuses part of detach's close path; Phase 2's park change must pin every line of the "close-path review" with tests (a parent-design risk item).
- **Measurement not done**: §3 is an estimate; the benefit conclusion awaits §7 measurement.

## 9. Validation and acceptance

- **Reuse witness**: after a parked Session reopens, the `mcp.start` count does not increase (no reconnect); catalog and connectionGeneration pins unchanged; grant renewed to the new writer.
- **Reclamation reconciliation**: after idle reclamation the load reinstalls against the receipt; original operations are not resent; a worker restart takes recovery-required rather than wrong reuse.
- **Suspension correctness**: after park the writer is sealed, activation released, resident dropped, renewal stopped; the recovery view reports ready; the #8 bounded-recovery proof still holds.
- **Pending-work blocking**: a Session with a pending MCP operation does not park (reconcile fails → no suspension or drain fallback).
- **Quota**: parked budget over cap falls back to drain; idle reclamation frees quota.
- **Mount semantics**: the mount stays held during park; after idle reclamation hands it back, other Sessions can acquire.
- **Real-process/MySQL IT**: mirroring Phase 1 acceptance, run the real Harness+worker+MySQL park/reuse/reclaim/fault matrix at the required CI tier; skipping the Hosted/MySQL gate is not acceptance.
- **Measurement**: §7 measurement proves the release constants reasonable and the benefit worth it.
- **Regression**: Phase 1's existing tests unchanged (a Session never idle for a full idle duration behaves identically); the non-MCP Session suspension path unchanged.

## 10. Open questions

1. Park verb shape: `mcp-park` control kind vs session-level park; relationship to the existing `managed-runtime-provider/1` control endpoint.
2. The idle-duration release constant and parked-budget cap (chosen by measurement).
3. Worker-side fallback for a lost park notification: grant-expiry-derived idle vs explicit heartbeat (§8).
4. The Broker persistence shape of the reclamation receipt and schema impact (same shape as H1 release receipts; avoid schema changes where possible).
5. Product acceptance of extended mount exclusivity; whether storage-ownership decoupling needs to be pulled forward (§5.4 later increment).
6. The park-semantics boundary for Hooks sharing the MCP mount (Hooks have no persistent connection; is keeping the owner re-acquirable sufficient).
7. Cross-workspace impact of a parked mount when several workspaces share storage (H1 restriction carries over).

## 11. Feasibility conclusion

**Worth doing, with prerequisites; measurement is an implementation gate.**

- **The benefit is real and primarily latency**: Phase 2 eliminates K **sequential** physical reconnects/discoveries (each ≤25s) + ~7K journal commits + K resource publishes on the cold-open side, and ~2K commits + K physical closes on the suspend side. For MCP-configured Sessions the wake-latency benefit is significant (especially large K or slow servers); the SQL benefit scales with K. ~91 is the MCP-free floor; MCP cost sits entirely on top (§3.1).
- **Most infrastructure is already in place**: the worker survives attaches, the durable owner is re-acquirable, the active-row reuse path exists, and the projection's runtime_state already accommodates parked. The additions are mainly: park semantics, Runtime idle reclamation + durable receipt, load reclamation reconciliation, and quota budget.
- **Prerequisites**: product review of the mount-held trade-off (§5.4); correctness proof of Runtime idle reclamation and reclamation reconciliation; quota budget. Storage-ownership decoupling is deferred (does not block the first increment).
- **Compatible with Phase 1**: the eligibility predicate, the #8 bounded-recovery proof, and the recovery-view criterion all hold (§6); no new journal state, no new cleanup-debt class.
- **Gate**: §7 measurement confirms the benefit share and release constants; real-process/MySQL fault acceptance. An estimate cannot replace measurement (the parent design explicitly requires it).

**Suggested slicing**: (1) measurement rig extension + measurement (gate); (2) park semantics + reuse path + recovery-view wording (minimal observable increment, without idle reclamation at first — parked connections live long but reuse correctness is verified); (3) Runtime idle reclamation + durable receipt + load reconciliation + quota budget; (4) real-process/MySQL fault matrix + release-constant selection. Storage-ownership decoupling as a separate follow-up design.
