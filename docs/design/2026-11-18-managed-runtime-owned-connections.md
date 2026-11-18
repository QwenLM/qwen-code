# Managed Runtime-Owned MCP/Hook Connection Lifecycle (Phase 2)

[English](2026-11-18-managed-runtime-owned-connections.md) | [简体中文](2026-11-18-managed-runtime-owned-connections.zh-CN.md)

Status: investigation + detailed design proposal, not implemented. Date: 2026-11-18. This is the pre-implementation design for Phase 2 of the [Stateless Hosted Harness design](2026-11-16-managed-stateless-harness.md) (#17527), checked against `main` at `5381294538`, which contains the merged Phase 1 PR #17690 (merge `7150c58a01`). The parent design's Phase 2 "defines the boundary only; a separate design precedes implementation"; this document carries that boundary forward into a proposal, cost model, Phase 1 interaction, measurement plan, and feasibility conclusion. The cost share in the conclusion is a **code-level analytical estimate, not yet measured**; measurement is an implementation gate (parent design: "its share must be measured").

## 1. Problem and current state

Phase 1 suspends idle Sessions: teardown step 2 non-terminally closes Hook/MCP owners, and a cold open reinstalls them. For a Session with MCP configured, this means every suspend/reopen **physically disconnects and reconnects each MCP connection and rediscovers its catalog**. This section verifies where that cost lives and who holds it.

### 1.1 Physical connections already live in the Runtime; the lifecycle is bound to the Harness attach

Three-layer ownership (consistent with the [MCP runtime design](2026-09-28-managed-mcp-runtime.md)):

- **Tool Runtime (worker process)** holds the physical transports. `ManagedMcpRuntime` in `packages/cli/src/serve/managed-mcp-runtime.ts` keeps `connections`/`operations`/`pendingStarts` keyed by `runtimeSessionId`; stdio child processes and HTTP/SSE connections live here. Quotas: `MANAGED_MCP_MAX_CONNECTIONS = 16` (`packages/core/src/managed-runtime/managed-mcp-protocol.ts`), `MAX_INFLIGHT = 32`, connection/discovery cap `TIMEOUT_MS = 25_000`.
- **Runtime Broker (Java)** resolves the Session and original Runtime, checks the Workspace owner, and forwards MCP control under the original identity. `RuntimeBrokerService.acquire/release/releaseMount` (`packages/managed-agent-server/runtime-broker/.../RuntimeBrokerService.java`).
- **Hosted Harness** holds the orchestration object `HostedMcpSession` (`packages/cli/src/serve/hosted-mcp-session.ts`) and the HTTP client `HostedWorkspaceBroker` (`hosted-workspace-broker.ts`); it commits intent/configuration records, dispatches control, and accepts receipts.

Key fact: **the worker process survives across attaches.** A local-process provider + workspace capability + `isolationClass = workspace` binding is workspace-shared (`HarnessOwnership.sharesRuntimeSessions`); one worker hosts several Runtime Sessions of that workspace. `WorkspaceRuntimeTransport.releaseMount` (`control-plane/.../WorkspaceRuntimeTransport.java`) states: "Only the execution mount … **The worker keeps the installation a re-drive reuses**" — handing back the mount does not stop the worker; only a full `release` runs `activateWorkspace(..., false)`. `JdbcRuntimeRetention` only cleans "unreferenced retired" generations; it does not stop live workers by idleness.

So "connections owned by the Runtime" **already holds physically**; what is bound to the attach is three things:

1. **The drain obligation**: on suspend/detach the Harness must dispatch `mcp-release` so the worker physically closes the connections.
2. **The mount membership**: the MCP owner is an execution member of the workspace storage (§1.4); suspension hands that membership back.
3. **Reinstall**: the next load re-commits configuration, reconnects, and rediscovers.

### 1.2 Owner identity and the reconnect/reuse paths

- **Durable owner id**: `hostedDurableMcpOwnerId(sessionKey, configurationIdsDigest)` = `mcp-` + sha256, recomputed on every load from the non-released configuration rows (`hosted-mcp-session.ts`). Hooks use a config-scoped owner (`hosted-hook-session.ts`, `isHostedConfigScopedOwner`). A non-terminal close leaves no RELEASED tombstone; the owner stays re-acquirable.
- **Establish (cold open or first prompt)**: before declaring tools, the tool turn calls `mcp.refresh(signal)` (`hosted-workspace-tool-turn.ts`) → `ensureReady()` (memoized) → `initialize()` → **per-server sequential** `install()`:
  1. If the previous row is `drained`/`released`: commit drained→released first, then open a fresh active row under the **same owner** (commit);
  2. `acquireOwner()`: `broker.acquire()` (HTTP) + a grant-renewal commit for each non-released configuration with a catalogRef (`commitConfiguration(record, renew=true)` advances the durable revision);
  3. Commit `dispatch_started`; dispatch `mcp-configure` (worker: spawn stdio / connect HTTP + initialize + tools/resources/prompts list, ≤25s);
  4. Publish the catalog resource + commit settled + advance same-owner sibling drained rows to released.
- **Per turn**: `refresh()` → `ensureReady` (already memoized) + `acquireOwner` + an `mcp-discover` dispatch per catalog. The worker answers discover from its cached catalog unless that catalog is stale or failed, so **a healthy discover makes no remote round trip and proves nothing about the remote side**. **Both resident and cold turns pay this.**
- **Suspend teardown step 2** (`hosted-harness-session.ts` `attemptSuspend`): `hooks.close({terminal:false})` + `mcp.close({terminal:false})`. `mcp.close` = `reconcileEffects()` (settle all pending operations/configurations) + `closeResources()`: per-configuration `drainConfigurations` (commit releasing → dispatch `mcp-release` → worker physical close → commit drained) + `broker.releaseMount()` (hand back the mount; the owner stays re-acquirable).
- **The reuse path already exists**: when `install()` meets a `previous.releaseState === 'active'` settled row, it dispatches no `mcp-configure`. It sends one `mcp-status` lookup for the original configure operation, which the worker answers from its in-memory operation record, and verifies the result against the saved catalog digest. Today this path serves crash reload (rows still active). **Phase 2 makes suspension also leave active rows, so it takes this reuse path.**
- **Replacement after a lost connection already exists**: discover on a closed connection settles with `managed_mcp_binding_conflict`, and `refresh()` then configures a replacement. The worker never removes closed connections from its map, so `mcp-release` for such a connection still settles. Today the replaced row stays `active` until the Session closes, and each load's `acquireOwner` renews it.

### 1.3 Hook current state

Hooks have no persistent transport — they are per-event dispatches into the worker, sharing the broker/mount with MCP (`HostedHookSession`). A non-terminal `close()` (`hosted-hook-session.ts`) = `drain()` (settle pending executions) + `releaseEarlierOwners` (release superseded old config-scoped owners) + recover recovered brokers + retry fenced owners, and finally, **only when the Hook session owns its broker**, hands back the mount for the current deterministic owner (no terminal release). A Session with MCP passes `session.mcp?.broker` to the Hook session, so `ownsBroker` is false and the Hook close never hands back the shared mount. A Hook-only Session owns its broker and must keep handing the mount back. **Phase 2 therefore changes nothing for Hooks.**

### 1.4 Storage mount semantics

The mount is not uniformly exclusive; its effect depends on the storage kind:

- **`LOCAL` / `SSH_LOCAL`**: execution is **shared membership**. Each Runtime Session that claims the mount increments `ma_storage_owner.member_count` and records `ma_runtime_session.execution_storage_key` (`JdbcWorkspaceExecutionStore`), so several Sessions run on the same storage at once. On `LOCAL` storage, membership blocks physical maintenance: `holdForMaintenance` requires `member_count = 0`, except for main-Session worktree preparation.
- **`EXTERNAL`**: the storage has a **single holder** (`JdbcExternalWorkspaceOwnership`); a rival acquire receives the retryable `workspace_busy`.

The [MCP runtime design](2026-09-28-managed-mcp-runtime.md)'s "one attached MCP owner per tenant/storage lease" therefore matches the single-holder case only; `LOCAL` / `SSH_LOCAL` storage admits several members.

## 2. Goals and scope

**Goal**: suspend/reopen no longer drains, reconnects, or rediscovers MCP connections when the connection is still usable. The Runtime side retains connections across attaches and the Broker reclaims them after an idle period; the Harness re-acquires them via the durable owner identity + a grant issued to the new writer.

**Scope (this proposal, first increment)**:

- Suspension leaves the MCP owner **parked** (connections alive, mount membership kept, grant expires naturally) instead of draining, on `LOCAL` / `SSH_LOCAL` storage when the Broker advertises parking.
- Reopen takes the existing active-row reuse path, revalidates remote connections before they are advertised, and replaces connections that are no longer usable.
- The Broker adds **idle reclamation**: parked connections are physically closed and the membership handed back after an idle duration.
- The worker evicts idle connections under quota pressure.
- Recovery-view contract wording update + parked-owner observability.

**Out of scope (later increments)**:

- **Decoupling connection lifetime from storage ownership** (H1's open problem): allowing the mount to be handed back while parked connections stay alive. Requires fencing stdio servers' workspace writes; a larger safety project, not done here (see §5.4).
- Parking on `EXTERNAL` storage, where a parked owner would exclude every rival (§5.4).
- Reinstalling automatically after worker loss (§5.7).
- Journal recovery cost (the part that grows with history) — the parent design states Phase 2 does not eliminate it.
- Phases 3/4 (wake scheduling, approval docking).

## 3. Cost model (analytical estimate, not measured)

### 3.1 Baseline restated

The WP3 measurement (local notes, not committed to this repository) found cold-open overhead of **~91 statements, flat** (1/40/200 turns), marginal idle saving 46/min/session, break-even ~2min. **That measurement used pure-text Turns, no Runtime workers, no MCP.** So ~91 is the **MCP-free floor**; MCP reconnect cost sits entirely on top of it, not "a small part of ~91". The question is not "how much of ~91 is MCP" but "how much does MCP add on top of ~91".

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

After parked reuse, the reopen MCP path degrades to: `acquireOwner` (1 broker HTTP + ~K grant-renewal commits) + K `mcp-status` lookups + one `ping` per remote server (§4.3) + the per-turn refresh discover (already paid resident). **Eliminated**: suspend drain (~2K commits + K closes) + cold-open reinstall (~5K commits + K publishes + **K sequential reconnects/discoveries**). The cold-open MCP delta drops from ~7K commits + K reconnects to ~K commits + 1 acquire + K status round trips + at most K pings.

The benefit scales with K and reconnect latency; at K=1 fast local stdio the SQL benefit is modest (tens of statements), but the latency benefit remains. A reopen that finds a connection unusable pays the replacement cost for that server only.

### 3.4 Reconnect witness (the most easily observed measurement)

The IT fixture `hosted-mcp-fault-process.mjs` records `mcp.start` on each process start and `mcp.exit` on exit. Phase 1 adds +K `mcp.start` per cold open; Phase 2 parked reuse should add 0 (until idle reclamation). This is a direct reconnect witness independent of the SQL digest window.

## 4. Proposal

### 4.1 The parked owner state

A **parked** owner is one whose Session journal head is `SEALED` while its Runtime Session still holds execution membership: connections alive, journal configuration rows `active` + `run.state = settled`, grant expiring naturally (`leaseDurationMs = 300_000`). Parked is **derived from durable state that already exists**; it is neither a new journal `releaseState` nor a new Broker or worker state.

**Why no new journal state is needed**: `ManagedExtensionProjection.runtimeState` (`contracts/.../ManagedExtensionProjection.java`) derives from `run.state` — `settled` is TERMINAL → `runtime_state = null`, **independent of `releaseState`**. So a parked (active+settled) configuration row already satisfies the recovery view's "no live Runtime execution" criterion (§6.3). A new journal state would break the existing projection/recovery proof for no benefit.

### 4.2 Suspend path change

Teardown step 2 changes from drain to park for MCP, when all of these hold:

1. **The Broker advertises parking.** The acquire reply carries a new `mcpParkable` field, true only for `LOCAL` / `SSH_LOCAL` storage on a deployment with reclamation enabled. If it is absent or false, the Harness runs today's Phase 1 drain unchanged.
2. **`reconcileEffects()` still runs**: settle all pending operations/configurations. Unsettled side effects still block suspension (as today; the eligibility predicate independently blocks `mcpBusy`/`mcpRecovering`). Parked connections are all settled, so a park never carries an unknown outcome.
3. **Only the latest row per server stays active.** Superseded non-released rows are drained through the existing `drainConfigurations`. If any remaining row is not `active` + `settled`, the Harness falls back to today's drain.

Parking then **skips `drainConfigurations` for the latest rows and skips `releaseMount`**. Connections stay in the worker and the membership stays held. The Harness sends no notification: sealing the writer in teardown step 5 is what makes the owner parked.

Hooks are unchanged (§1.3). Teardown step 3 `releaseLeaseNow` is unchanged: it already returns false for MCP-owned leases.

### 4.3 Reopen reuse path

A cold open constructs `HostedMcpSession` (same durable owner), and the first prompt's `install()` sees an active+settled row:

1. **Acquire first.** The reuse branch calls `acquireOwner()` before its `mcp-status` lookup. `lookup` reports every failure as `outcome_unknown`, which `install()` turns into recovery-required; acquiring first lets a retryable `workspace_busy` or Broker rejection surface as itself, as it does on the fresh-install path.
2. **Look up and verify.** `mcp-status` returns the original configure result, which is checked against the saved catalog digest. No reconnect.
3. **Revalidate before advertising tools.** The first `refresh()` of a reopened Session sends `mcp-discover` with a new optional `revalidate: true`. For remote transports the worker sends an MCP `ping` under a short timeout; a JSON-RPC `-32601` reply counts as alive. On any other failure the worker closes the connection and answers `managed_mcp_retiring`. Stdio connections skip the ping, because process exit already closes them.
4. **Retire and replace unusable connections.** On `managed_mcp_binding_conflict` or `managed_mcp_retiring`, `refresh()` first retires the old row through the existing `drainConfigurations` (the `mcp-release` of a closed connection settles immediately), then configures a replacement through the existing path. If that release does not settle cleanly, the Session stays recovery-required.

| Connection state at reopen                   | Detected by                     | Outcome                                                                         |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| Alive and accepted by the server             | Revalidation passes             | Reuse; no `mcp-configure`                                                       |
| Remote session expired or credential refused | `ping` fails                    | Retire and reconfigure; a refused credential fails before the model turn starts |
| Closed by reclamation, eviction, or exit     | `managed_mcp_binding_conflict`  | Retire and reconfigure                                                          |
| Worker lost (Runtime generation changed)     | `acquireOwner` generation check | Recovery-required, unchanged (§5.7)                                             |

**Why revalidation is required**: without it, a remote session that expired during the park stays invisible until the first tool call. That `send` fails, the worker records `outcome_unknown`, and the Session becomes `recovery_blocked` over a call the server never executed. Phase 1 avoids this by reconnecting on every wake.

**What revalidation proves**: the connection is alive and the server accepted its credentials at that moment. It does not assert per-tool authorization. Definition credentials are static headers/environment held by the Runtime, HTTP transports send them on every request, and the remote server authorizes each call itself, so parking introduces no cached authorization. A connection can still fail after the probe, exactly as it can for a resident Session.

### 4.4 Broker idle reclamation

The Broker reclaims parked owners with a scheduled job of the same shape as `RuntimeRetentionJob`. Eligibility is a database predicate over existing columns, with no schema change:

- `ma_runtime_session`: `session_state = 'READY'` and `execution_storage_key IS NOT NULL`;
- the matching `ma_session_head` (same tenant and `harness_session_id`, `head_kind = 'MANAGED_SESSION'`): `state = 'SEALED'` and `gmt_modified` older than the idle duration.

A resident Session has an `ACTIVE` head and is never eligible. A later head update, such as a wake projection, only pushes the deadline back. For each eligible owner:

1. **Adopt.** If the binding is not live in this Broker process, adopt it through the existing trusted `recoverBinding` path.
2. **Close connections.** The Broker sends a new Broker-only `mcp-reclaim` control. The worker refuses it while `hasPendingWork` is true; otherwise it runs the existing `drainSession`. A refusal changes nothing and is retried on the next tick. The Harness control route rejects this kind.
3. **Hand back the membership.** Under the Session lock, the Broker re-checks that the head is still `SEALED`, reads the current mount claim, and calls the existing `releaseMountAfterSweep` guard, which refuses a superseded claim, active control, or a live or unproven background execution.

Connections close before the membership is handed back, so a stdio server cannot write to storage it no longer holds. Reclamation is **non-terminal**: a full release would leave a RELEASED tombstone under the id the next load recomputes and wedge the durable owner. Journal rows do not change; the successor Harness replaces the connection through §4.3.

**Race with reopen**: a successor that acquires during reclamation supersedes the claim, so step 3 keeps its membership. Any connection closed in step 2 is replaced through §4.3, and a tool call that reaches a closed connection settles with an error before anything is sent.

**Maintenance**: when `holdForMaintenance` answers `workspace_busy` because of parked members, it requests an immediate reclamation of those members regardless of idle duration. The maintenance caller's normal retry of that retryable refusal then proceeds.

### 4.5 Quota

Parked connections count against the worker's shared 16-connection quota. When `mcp-configure` reaches the quota, the worker **evicts** the least recently used connection that belongs to another Runtime Session, has no pending request, and has been unused for at least the 300s grant lease. If no such connection exists, the configure fails with `managed_mcp_connection_quota` as it does today.

Eviction needs no budget constant or drain fallback, because an evicted connection is replaced through §4.3 and a settled connection carries no unknown outcome. Eviction closes the connection only; the membership is released by §4.4.

### 4.6 Answers to the parent design's interfaces

- **Distinction between suspending and releasing an owner**: suspending leaves a sealed head with a re-acquirable owner; releasing is the existing terminal release with its tombstone. No new verb is required.
- **Who retires connections and when**: the Broker, after the idle duration, or earlier for maintenance; the worker under quota pressure.
- **Where unknown-outcome holds and their quotas live**: nowhere new. An owner with an unknown outcome is never parked, and the worker refuses to reclaim a Runtime Session with pending work.

## 5. Design decisions and rationale

### 5.1 Parked state is derived; no park verb

An explicit park notification was rejected. A lost notification would need a fallback idle signal anyway, and that fallback alone is sufficient. The sealed journal head is already durable, survives a Broker restart, distinguishes parked from resident Sessions, and cannot be lost. Dropping the verb also removes a teardown failure branch and the race between notification and seal.

### 5.2 No new journal releaseState

Parked rows stay `active`+`settled` (§4.1). Rationale: the reuse path recognizes `active`; the projection's `runtime_state` derives from `run.state` and is already null; a new state would break the recovery-view proof and the existing drained/released state machine for no benefit.

### 5.3 No durable reclamation receipt

The successor needs only to learn that a connection is gone. While the Runtime generation is unchanged, the worker that closed the connection is still running and answers authoritatively through `managed_mcp_binding_conflict`. If the generation changed, the Session is recovery-required regardless of any receipt (§5.7). A persisted receipt would never decide an outcome, so none is added and no Broker schema change is needed.

### 5.4 Membership stays held; parking is limited to shared-membership storage

The membership stays held during park. Rationale: H1 states that releasing storage while a stdio server can still access the Workspace would allow concurrent writers, and decoupling connection lifetime from storage ownership is follow-up work.

**Cost on `LOCAL` / `SSH_LOCAL`**: other Sessions are not blocked, because membership is shared (§1.4). On `LOCAL` storage, a parked member blocks physical maintenance that requires `member_count = 0`; §4.4 reclaims on demand so that maintenance is delayed only by one reclamation.

**`EXTERNAL` storage does not park in the first increment**: its single holder would exclude every rival until reclamation. These Sessions keep the Phase 1 drain.

### 5.5 Suspension still frees Harness resources

The mount is a Broker-side claim, not a Harness resource. Holding it during park does not prevent the Harness from sealing the writer, releasing the activation, dropping the resident, and stopping renewal — all of Phase 1's core benefits (memory/ports/renewal SQL) are retained.

### 5.6 Broker-advertised parking is the rollout control

The parent design records that suspension has no kill switch. `mcpParkable` gives Phase 2 one: while the Broker does not advertise parking, every Session keeps the Phase 1 drain. It also guarantees that parking is never enabled on a deployment without reclamation.

### 5.7 Worker loss stays recovery-required

A Runtime generation change while parked remains recovery-required. The existing fault gate `workerKillWhileIdleNeverMintsAFreshOwnerOnMySql` (`HostedMcpRestartFaultGatesIT`) deliberately pins that a killed idle worker never mints a fresh owner or starts a second server. Parking does not weaken this contract. Relaxing it for owners proven settled would be a separate decision (§10).

## 6. Interaction with Phase 1

### 6.1 Eligibility predicate

`suspensionLiveWork` (`hosted-harness-session.ts`) blocks on `mcpBusy`/`hooksBusy`/`mcpRecovering > 0`, `heldRuntimeTurns`, live monitor loops, unsettled child/monitor runs, `clientFiles`, `streams`, and public-shell MCP without lifecycle v2. It **does not block** a private `hosted-workspace-mcp/1` Session merely for having MCP. Phase 2 keeps these: pending work still blocks suspension; parked idle connections are not "live work".

### 6.2 Teardown ordering and the #8 bounded-recovery proof

Teardown order: wake → owners (step 2) → lease (step 3) → publishers → writer seal (step 5) → stopLocal. Phase 2 changes step 2 from drain to park (reconcile and retire superseded rows), still at the revertible boundary before seal. A failure there follows today's drain-failure path.

**The #8 proof holds** ([bounded recovery addendum](2026-11-18-managed-suspension-bounded-recovery.md)): it relies on **writer fencing** (lease expiry → any acquire generation+1), **not on SEALED ⟹ resources released**. Resource obligations are reconciled by the successor cold open via the existing takeover/cleanup path. Park leaves resources under Runtime care; the successor cold open reuses or replaces them — the same shape as the crash-recovery branch the proof already declares.

### 6.3 Recovery view

The recovery view ([supplement](2026-11-18-managed-suspension-recovery-view.md)) `ready` criterion requires `ma_session_record.runtime_state` to be empty. Verified: the `mcp_configuration` projection's `runtimeState` derives from `run.state`, settled → null, **independent of releaseState**. So a parked (active+settled) configuration row **already satisfies** the criterion; no projection change is needed. Required:

- Contract wording: "reinstall the owner" → "reuse or reinstall the parked owner".
- "No unsettled work" must still hold (no pending `mcp_operation`) — guaranteed by reconcile before park.
- A reclaimed-but-journal-active connection: the view may stay ready; the load replaces it (§4.3).
- Optional: parked-owner count in observability.

### 6.4 Cleanup debt

`hasHostedCleanupDebt` (`hosted-turn-cleanup.ts`) tracks `hosted.cleanup` owed events (turn-scoped Runtime leases). Parking adds no durable obligation: the only park failure is reconcile failing to settle a pending operation, which already blocks suspension as today. **No new durable cleanup-debt class is introduced**; replacing a reclaimed connection rides the §4.3 load path rather than the cleanup-debt scanner. This must be verified during implementation (§8).

## 7. Measurement plan (implementation gate)

Parent design: "its share must be measured". §3 is an analytical estimate; **measurement is an enablement gate**. Two paths:

### 7.1 Extend the WP3 rig (TS, recommended)

The WP3 rig is a local script (MySQL8.4 + Spring exec jar + hosted-harness bundle + fake model, performance_schema digest-window method) and is not committed to this repository. Extend it for MCP:

1. **MCP fixture server**: reuse `packages/managed-agent-server/verification/src/test/resources/hosted-mcp-fault-process.mjs` (self-contained stdio MCP, records `mcp.start`/`mcp.exit`).
2. **Remote fixture server**: add a Streamable HTTP fixture that records `initialize` and `ping` requests and can expire its session or refuse its credential on demand.
3. **Manifest + worker wrapper**: write `mcp.json` (stdio, command=node, args=[fixture,'mcp',evidence,'1'], definitionDigest matching the session pin) + `worker.mjs` (sets `QWEN_MANAGED_MCP_CONFIG` then imports dist/cli.js, mirroring the IT). Spring sets `QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY` to the wrapper.
4. **Profile + workspace**: Spring sets `QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES=hosted-workspace-mcp/1`. The workspace needs IT-style registration (`ma_workspace` with `WorkspaceExecutionProfile.CONFIG_REF` + `ma_workspace_access` + storage guard register) so the broker scope capabilityDigest = `WORKSPACE_CAPABILITY_DIGEST` (accepted by the TS broker `readRuntime`). **Note**: the IT builds the stack with Java beans (`guard.register`, `store.insertWorkspaceSessionCommand`); the TS rig needs HTTP/SQL equivalents — the main engineering difficulty.
5. **Agent definition + session**: POST `/v1/agents` (`tools:[{type:hosted_profile,profile:hosted-workspace-mcp/1}]` + `mcp_servers` pin + `permission_policy:{approval_mode:yolo}`), then POST `/v1/agents/sessions`.
6. **Measure**: as the rig (resident-turn baseline → wait for suspension → cold-open turn), digest window for the SQL delta; additionally count `mcp.start` events in the evidence file (reconnect witness). Compare K=1/4/16.

### 7.2 New Java IT (alternative)

Add an IT in the verification module, building the stack like `HostedMcpRestartFaultGatesIT` (real Harness + worker + MySQL) but measuring suspend/reopen SQL + timing + `mcp.start` count. Needs the isolated Maven repository and sibling SDK install described in `packages/managed-agent-server/AGENTS.md`, plus the `mysql.url` system property. Pro: the stack-build steps are already solved by the IT; con: the Maven verification chain is heavy.

### 7.3 Measurement outputs

- Cold-open MCP delta statements (K=1/4/16) vs the §3.2 estimate.
- Cold-open MCP delta wall-clock (sequential reconnect latency), for stdio and remote servers.
- Revalidation latency per remote server, and how often a reopen finds a connection unusable.
- Suspend drain delta statements.
- `mcp.start` reconnect count (Phase 1 +K/cold open).
- Use these to choose the idle duration and revalidation timeout, and confirm the benefit is worth it (§9).

## 8. Constraints and risks

- **Maintenance delayed by parked members** (§5.4): physical maintenance on `LOCAL` storage waits for on-demand reclamation of parked members.
- **Stale remote connections**: a remote session can expire during the park. Revalidation (§4.3) covers the reopen; a failure after the probe behaves as it does for a resident Session.
- **Replacement correctness**: a reclaimed connection's journal row is still active. The load must retire that row before replacing it, and must not resend original operations. Worker loss (recovery-required) and connection loss (replace) must each be verified.
- **Reclamation races**: `mcp-reclaim` and the membership handback must stay safe against a concurrent reopen, a Broker restart between the two steps, and adoption after a restart.
- **Quota pressure**: eviction can close an idle connection of a resident Session; its next tool call fails cleanly and its next refresh replaces the connection.
- **Long-lived stdio process resources**: a parked stdio server is a long-lived process in the worker, holding memory/FDs. Idle reclamation bounds it; H1's deployment constraints ("stdio HOME/USERPROFILE is the Workspace", etc.) carry over.
- **Coupling with the detach path**: suspension reuses part of detach's close path; Phase 2's park change must pin every line of the "close-path review" with tests (a parent-design risk item).
- **Measurement not done**: §3 is an estimate; the benefit conclusion awaits §7 measurement.

## 9. Validation and acceptance

- **Reuse witness**: after a parked Session reopens, the `mcp.start` count does not increase (no reconnect); catalog and connectionGeneration pins unchanged; grant renewed to the new writer.
- **Revalidation**: a remote session expired during the park is replaced before tools are advertised and never produces `outcome_unknown`; a credential revoked during the park fails the turn before the model runs; an unchanged remote server is reused without `mcp-configure`; a stdio server receives no `ping`.
- **Reclamation**: after idle reclamation the load retires the old row and reconfigures; original operations are not resent; retired rows do not accumulate across repeated cycles.
- **Worker loss**: a worker killed while parked takes recovery-required, mints no fresh owner, and starts no second server (the `workerKillWhileIdleNeverMintsAFreshOwnerOnMySql` contract).
- **Error classification**: a retryable `workspace_busy` during reopen surfaces as itself, not as recovery-required.
- **Suspension correctness**: after park the writer is sealed, activation released, resident dropped, renewal stopped; the recovery view reports ready; the #8 bounded-recovery proof still holds.
- **Pending-work blocking**: a Session with a pending MCP operation does not park, and the worker refuses `mcp-reclaim` while work is pending.
- **Quota**: at the connection quota, an idle parked connection of another Session is evicted and the new configure succeeds; with no evictable connection the quota error is unchanged.
- **Mount semantics**: on `LOCAL` / `SSH_LOCAL`, other Sessions run on the same storage during the park; on `LOCAL`, maintenance proceeds after on-demand reclamation; a concurrent reopen keeps its membership; `EXTERNAL` storage and deployments without `mcpParkable` keep the Phase 1 drain.
- **Hooks**: a Hook-only Session still hands its mount back on suspension.
- **Real-process/MySQL IT**: mirroring Phase 1 acceptance, run the real Harness+worker+MySQL park/reuse/reclaim/fault matrix at the required CI tier; skipping the Hosted/MySQL gate is not acceptance.
- **Measurement**: §7 measurement proves the release constants reasonable and the benefit worth it.
- **Regression**: Phase 1's existing tests unchanged (a Session never idle for a full idle duration behaves identically); the non-MCP Session suspension path unchanged.

## 10. Open questions

1. The idle duration, reclamation scan delay, and revalidation timeout (chosen by measurement), and whether revalidation runs concurrently across servers.
2. The wire shape of `mcpParkable`, `revalidate`, and `mcp-reclaim`, and their relationship to the existing `managed-runtime-provider/1` control endpoint.
3. Whether `EXTERNAL` storage should park later, which would require preempting a parked holder when a rival acquires.
4. Whether an owner proven settled may reinstall automatically after worker loss, which would require revisiting the fault gate in §5.7.
5. Whether reclamation should also cover a crashed Harness (`ACTIVE` head with an expired writer lease). The first increment covers sealed heads only.
6. Whether storage-ownership decoupling is needed once maintenance delay is measured (§5.4 later increment).

## 11. Feasibility conclusion

**Worth doing, with prerequisites; measurement is an implementation gate.**

- **The benefit is real and primarily latency**: Phase 2 eliminates K **sequential** physical reconnects/discoveries (each ≤25s) + ~7K journal commits + K resource publishes on the cold-open side, and ~2K commits + K physical closes on the suspend side. For MCP-configured Sessions the wake-latency benefit is significant (especially large K or slow servers); the SQL benefit scales with K. ~91 is the MCP-free floor; MCP cost sits entirely on top (§3.1).
- **Most infrastructure is already in place**: the worker survives attaches, the durable owner is re-acquirable, the active-row reuse path and connection replacement exist, the projection's runtime_state already accommodates parked, and the sealed head already identifies parked owners. The additions are mainly: remote revalidation, stale-row retirement, Broker idle reclamation, quota eviction, and the parking advertisement.
- **Prerequisites**: correctness proof of reclamation and its races; real-process proof of revalidation against expired and refused remote sessions. Storage-ownership decoupling is deferred (does not block the first increment).
- **Compatible with Phase 1**: the eligibility predicate, the #8 bounded-recovery proof, and the recovery-view criterion all hold (§6); no new journal state, no schema change, no new cleanup-debt class.
- **Gate**: §7 measurement confirms the benefit share and release constants; real-process/MySQL fault acceptance. An estimate cannot replace measurement (the parent design explicitly requires it).

**Suggested slicing**: (1) measurement rig extension + measurement (gate); (2) reopen hardening: acquire before lookup, remote revalidation, stale-row retirement; (3) Broker idle reclamation + on-demand maintenance reclamation + quota eviction; (4) parking behind `mcpParkable` + recovery-view wording, enabled only after (2) and (3) have landed; (5) real-process/MySQL fault matrix + release-constant selection. Storage-ownership decoupling as a separate follow-up design.
