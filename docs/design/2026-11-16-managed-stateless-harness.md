# Stateless Hosted Harness: idle Session suspension and the path beyond it

[English](2026-11-16-managed-stateless-harness.md) | [简体中文](2026-11-16-managed-stateless-harness.zh-CN.md)

Status: proposed. Phase 1 (idle Session suspension) is designed for implementation; Phases 2 to 4 define boundaries and interfaces only and will each get their own design before implementation. Phase 1 depends on [#17521](https://github.com/QwenLM/qwen-code/pull/17521) (re-attach when the Harness drops a cached Session reference), which is open and pending CI.

## Problem

A Managed Session that a Hosted Harness has attached stays resident in that Harness process until the Session is closed or deleted. The control plane never detaches an ordinary Session, so a Session the user stopped talking to an hour ago is handled exactly like one with a Turn running.

While resident, every Session pays for itself continuously:

- **Writer lease and activation renewal.** The Harness renews the Session's writer lease and its activation through the private Session Store, one `/writers:renew` request per Session roughly every `leaseDurationMs / 3` (20 seconds at the 60-second default). Each renewal is one database transaction of roughly eight to ten single-row statements. The cost scales with resident Sessions, not with active Turns.
- **Harness memory and per-Session owner state.** Each resident Session holds its restored journal state, its model context, its MCP and Hook owner state (configuration records, catalogs, grants), its wake scheduler and its timers. The Harness reports `attachedSessions` as a load signal, so idle Sessions consume capacity that active Sessions could use.
- **Runtime-side connections.** The MCP connections and Hook owners for the Session live in its Tool Runtime and stay open for as long as the Harness keeps the Session attached.

The project has not launched, so there is no production profile and no existing deployment to protect. The design assumes deployments with thousands of attached Sessions of which most are idle. Suspension ships without a switch: there is no configuration key and no capability negotiation.

## Current state

### What the Harness holds per Session

| State                                                                                                  | Durable source                                                                                           | Released by                                                                                     |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Conversation history, context, domain records, MCP and Hook configuration records                      | The Session journal in the private Session Store (restored from a native snapshot plus its tail)         | Nothing needs to release it; a cold open restores it                                            |
| MCP and Hook owner identity                                                                            | Derived deterministically from the durable configuration ids on every load                               | Recomputed on every load                                                                        |
| MCP connections and Hook owners in the Tool Runtime                                                    | Configuration records name the original `runtimeSessionId`                                               | A non-terminal close drains every configuration and dispatches `mcp-release` through the Broker |
| Wake scheduler (`HostedMonitorWakeScheduler`), including the timer for the earliest future `notBefore` | Inputs are committed to the journal; the control plane's `WakeRecovery` also tracks deferred `notBefore` | Process memory only                                                                             |
| A Turn waiting for a tool approval                                                                     | The Harness checkpoint has an `await_action` phase                                                       | `HostedApprovalWaiters` keeps the Turn in process memory                                        |
| Background Shell and Monitor observation loops                                                         | Their records are committed; the loops themselves run in the Harness                                     | Only a Session close stops them                                                                 |
| Writer lease and activation                                                                            | `ma_session_head` and the activation records in the journal                                              | `managed.close()` releases the activation and seals the writer                                  |

### Detach ends a Session, it does not suspend one

The existing detach and delete handler (`close` in `packages/cli/src/serve/hosted-harness-session.ts`) is written as the end of a Session's attachment:

- it stops every live background Shell and Monitor observation loop and settles them as `stop_requested`;
- it settles every pending monitor, channel, automation, child, session-message and loop input as **cancelled**, model-free, before the log closes;
- it releases the Runtime lease, drains held Runtime work and retries any hosted cleanup debt;
- it closes Hooks and MCP (non-terminally for a detach, which drains the Runtime connections but keeps the owner re-acquirable);
- it releases the activation and seals the writer.

Reusing it for idle Sessions would cancel queued and deferred inputs that the user expects to run. Phase 1 therefore adds a separate suspension path; the close-path audit in Phase 1 lists every effect of the handler and how suspension treats it.

### What already tolerates a Harness letting a Session go

- **Recovery from a sealed writer.** `WakeRecovery` treats a Session whose writer is sealed, or whose lease expired, as unowned. It scans every two seconds, handles up to eight candidate Sessions per pass, accounts for deferred `notBefore`, and calls `recoverForWake`, which performs a passive load. A crashed Harness already leaves exactly this state behind.
- **Re-attaching a vanished reference.** With #17521, an ordinary verb that the Harness answers `hosted_session_not_found` for a cached reference evicts the entry, attaches again the way a cold cache would, and retries once.
- **Transient closing.** `hosted_session_closing` is classified transient (`HarnessConflictCodes`); public routes surface it as a retryable 503, and the session-message, child-result and lifecycle paths already treat it as retryable.
- **Placement takeover.** A placement may move to another pool member once the writer is sealed or its lease expired and the activation is released; a live writer is refused with `harness_owner_still_live`.

## Goals and non-goals

Goals:

- Release every per-Session resource of a Session that has been idle for the idle period, without cancelling any of its inputs or changing what the user sees.
- Reopen a suspended Session transparently on the next request, wake input or lifecycle operation.
- Add no configuration key and no capability negotiation; the Harness and the control plane are released and upgraded together.
- Define the target architecture, a Harness that holds no Session between requests, and the boundaries of the steps that lead there.

Non-goals for Phase 1:

- Making cold opens cheaper. Phase 1 accepts today's cold-open cost (journal restore, MCP reinstallation and discovery); Phase 2 addresses it.
- Moving the wake scheduler, approval waits or observation loops out of the Harness. Sessions that need them stay resident in Phase 1.
- Changing the writer lease protocol or the Session Store.
- Releasing placements of suspended Sessions.

## Target architecture

The end state is a Harness that holds a Session only while there is work for it: a request, a running Turn, or an in-flight Runtime obligation. Between requests it holds nothing, so any pool member may open the Session, and placement stickiness becomes cache affinity rather than a requirement.

The journal and the Session Store stay the only authority. A Turn that is running still has exactly one owner, because two Harnesses advancing one Session would diverge and duplicate side effects. The writer lease therefore stays; it is held for the lifetime of a request instead of the lifetime of an attachment.

This is the shape of Claude Managed Agents, where the session is an append-only log outside the harness, the harness is stateless and any harness resumes a session with `wake(sessionId)`, and tools run in a per-session sandbox ([Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)). The difference that makes this work here harder is that our Harness owns per-Session MCP and Hook lifecycles, which must be drained before it lets a Session go. Phase 2 moves that ownership to the Runtime.

| Phase | Change                                               | Effect                                                                |
| ----- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| 1     | Idle Session suspension                              | Idle Sessions stop renewing and release Harness and Runtime resources |
| 2     | Runtime-owned MCP and Hook connection lifetime       | Suspension and reopening no longer drain, reconnect or rediscover     |
| 3     | Wake scheduling and observation in the control plane | Sessions with deferred inputs or background work can suspend          |
| 4     | Parked approvals                                     | A Turn waiting for approval no longer pins the Harness                |

After Phase 4 the idle period can shrink toward zero, which is the stateless end state.

## Phase 1: idle Session suspension

### Overview

Each resident Session gets an idle timer in the Harness. Every request for the Session and every completion of internal work pushes the timer back. When it fires, the Harness checks whether the Session is idle; if so it suspends the Session: it stops the wake scheduler without settling anything, drains the MCP and Hook owners the same way a detach does, releases its Runtime lease, releases the activation, seals the writer and forgets the Session. Pending inputs stay in the journal. The next request reaches a Harness that no longer has the Session and attaches it again through the existing cold-open path.

### Idle period

- The idle period is a constant in the Harness, initially 10 minutes. There is no configuration key, environment variable or request field for it, and the Harness advertises no capability for suspension.
- Unit tests set a shorter period through a constructor option. Real-process integration tests need a short period as well, so the Harness accepts a test-only override that is not part of its documented configuration.
- The Harness applies a jitter of up to 10 percent to each timer so that Sessions that went idle together do not suspend together.
- The constant is revisited once cold opens have been measured.

### Idle predicate

When the timer fires, the Harness suspends the Session only if all of the following hold; otherwise it re-arms the timer for another full period.

- No Turn is active and no recovered Turn is waiting for a continue or cancel drive.
- No Turn event stream is open (the control plane opens one only for the duration of a Turn).
- No input is due. Inputs whose `notBefore` lies in the future do not block suspension, because `WakeRecovery` reloads the Session when they become due.
- No MCP or Hook operation is pending or recovering, no MCP configuration is being installed or refreshed, no session-message operation is in flight, and no context compression is running.
- No background Shell or Monitor observation loop is live.
- No Runtime that a Turn left held remains, no Runtime work is unsettled, and the hosted cleanup debt is zero.
- No client-files registration is active. The control plane keeps the browser's binding and closes it only when it closes or deletes the Session, so a Harness that dropped the registration on its own would leave the browser showing a connected bridge whose tools the model no longer has. A closed tab ends the binding at once, because its downlink closes; the Session can suspend after that.
- No lifecycle authority, ownership release or pool quiescing is in progress.
- The Session is not recovery-blocked. A blocked Session stays resident so that operator recovery keeps working unchanged.
- The Session is not on a public Workspace Shell profile (`hosted-workspace-shell/1`, `hosted-workspace-shell/3` or `hosted-workspace-shell/4`) with MCP. A plain detach of such a Session requires a lifecycle authority and is refused with `hosted_lifecycle_required`, so Phase 1 never suspends it.

The predicate and the step that marks the Session as suspending run in the same synchronous section, so no request can be admitted between the check and the mark.

### Timer

- Armed when the Session becomes resident and whenever it settles back to idle.
- Pushed back by every request the `/session/:id` routes accept for the Session, and by the end of every Turn, wake Turn, MCP or Hook operation, compression and observation loop.
- Cleared when the Session closes, is deleted, is suspended or enters a lifecycle operation.

### Suspension sequence

1. Mark the Session suspending. From this point the `/session/:id` middleware answers every request for it with `409 hosted_session_closing`, which callers already treat as transient.
2. Close the wake scheduler without settling any input.
3. Close the Hook and MCP owners non-terminally, the same calls a detach makes. This drains the Runtime connections and leaves the owners re-acquirable by the next load.
4. Release the Runtime lease non-terminally with the existing helper, which first retires a settled Turn's owed file-history marker. Retry the hosted cleanup debt; if any remains, abort the suspension.
5. Close the Shell and background-lane publishers. No observation loop is live, so nothing is waiting to settle through them, and the next load recreates them.
6. Call `managed.close()`, which stops renewal, releases the activation and seals the writer.
7. Remove the Session from the resident map.

If any step before the seal fails, the Harness clears the suspending mark, keeps the Session resident and re-arms the timer, exactly as a failed detach leaves the Session usable for a retry. A failure after the seal is committed still removes the Session: its durable state is a sealed writer, which the next open takes over.

Suspension skips the ordinary execution authorization a detach requests first: it starts no work, and the seal is fenced by the writer itself. The audit below lists every other difference from detach; tests pin each one.

### Close-path audit

Every effect of the detach and delete handler (`close` in `packages/cli/src/serve/hosted-harness-session.ts`), and how suspension treats it. A Session under a lifecycle-protocol-2 operation runs its resource phases through the control plane and the handler then only seals; suspension never runs under a lifecycle authority, so the full path below applies.

| Effect                                                                                                                           | Detach (`POST`)                                                                       | Delete                                                  | Suspension                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Authorization                                                                                                                    | Ordinary `/execution:authorize`                                                       | None                                                    | Skipped                                                               |
| Wait for in-flight session-message operations                                                                                    | Yes                                                                                   | Yes                                                     | Not needed: the predicate requires none                               |
| `SessionEnd` and `SessionDelete` Hooks                                                                                           | No                                                                                    | Yes                                                     | Never                                                                 |
| Drain Runtimes a Turn left held                                                                                                  | Yes, except reload-stable owners, which keep running with their release owed (#16579) | Yes, all                                                | Not needed: the predicate requires none                               |
| Close Hook owners                                                                                                                | Non-terminal                                                                          | Terminal, plus release of orphaned configuration owners | Non-terminal, as detach                                               |
| Close the wake scheduler                                                                                                         | Yes                                                                                   | Yes                                                     | Yes, without settling inputs                                          |
| Retire a settled Turn's owed file-history marker, then release the Runtime lease                                                 | Yes, non-terminal                                                                     | Yes, terminal                                           | Yes, non-terminal                                                     |
| Stop observation loops, settled `stop_requested` or `runtime_lost`                                                               | Yes                                                                                   | Yes                                                     | Not needed: the predicate requires none live                          |
| Retry hosted cleanup debt                                                                                                        | Yes                                                                                   | Yes                                                     | Yes; remaining debt aborts the suspension                             |
| Close the Shell and background-lane publishers                                                                                   | Yes                                                                                   | Yes                                                     | Yes                                                                   |
| Close MCP owners                                                                                                                 | Non-terminal                                                                          | Terminal                                                | Non-terminal, as detach                                               |
| Close the client-files registration                                                                                              | Yes                                                                                   | Yes                                                     | Not needed: the predicate requires none                               |
| Settle pending monitor, channel, automation, child, session-message and loop inputs as cancelled, then reconcile automation runs | Yes                                                                                   | Yes                                                     | Never: inputs stay in the journal for the next load or `WakeRecovery` |
| Release the activation and seal the writer                                                                                       | Yes                                                                                   | Yes                                                     | Yes                                                                   |
| Stop event streams and remove the Session                                                                                        | After the seal                                                                        | After the seal                                          | After the seal; the predicate requires no open stream                 |

When the control plane closes or deletes a Session, its lifecycle coordinator also closes the browser's client-files binding (`closeForSession`); nothing closes it when the Harness drops the registration on its own, which is why an active registration blocks suspension.

No other per-Session component holds a long-lived timer. The remaining Session components have no close or stop of their own, and the only timers among them are short waits inside a single operation.

### Reopening

- **Ordinary verbs.** The next verb from the control plane meets `hosted_session_not_found`, evicts the cached reference and re-attaches through its own attachment resolver (#17521). A verb arriving during suspension meets `hosted_session_closing` and is retried by its caller.
- **Wake inputs.** `WakeRecovery` already reloads unowned Sessions with pending or newly due inputs. The transport path changes in one place: `activateForWake` currently returns without loading when this process still caches an attachment. It must instead evict a cached attachment when the wake fence reports no live writer, and load the Session.
- **Lifecycle operations.** Close and delete load the Session through the lifecycle attachment when nothing is cached, as they do after a control-plane restart.
- **Placement.** Phase 1 does not change placement, so the reopen lands on the same pool member.

### Cold-open admission

Suspension turns some steady-state work into bursts of cold opens, for example when one automation schedule fires for many suspended Sessions at once, or when a pool member restarts. Each cold open restores the journal and reinstalls MCP configurations, whose connection and discovery each wait up to 25 seconds.

- The Harness limits concurrent cold opens per instance, initially to 8, a constant like the idle period. An open beyond the limit is refused with the new code `409 hosted_session_open_busy`.
- The limit applies to every cold open, including the bulk reloads that follow a Harness restart, which it also smooths.
- The control plane classifies `hosted_session_open_busy` as transient in `HarnessConflictCodes` and, in `HarnessCoordinator`, as a code that postpones a Turn without charging its admission budget, alongside the existing pool-ownership wait codes. This classification is a prerequisite: without it, a burst of refusals would exhaust the admission budget of queued Turns and fail them.
- The control plane's existing bounds stay: the transport wake load pool and `WakeRecovery`'s eight candidates per pass.
- The Session Store is shared by every pool member, so the per-instance limit does not bound store load. Validation measures cold-open store load, and the limit is revised from it.

### Control-plane changes

All of these land before, or in the same release as, the Harness change (see Rollout).

1. Re-attach a vanished cached reference (#17521).
2. `activateForWake` evicts a stale cached attachment when the wake fence reports no live writer.
3. `hosted_session_open_busy` in `HarnessConflictCodes` and in the coordinator's wait codes.
4. Update the `HarnessCoordinator` comment stating that the control plane never detaches. The budget treatment of `hosted_session_already_attached` stays correct, because a suspended Session answers `hosted_session_not_found` and a plain load of it succeeds.

### Pool interaction

A suspended Session keeps its placement. If its pool member leaves the pool, the next request takes the placement over, which the placement store allows because the writer is sealed and the activation released. A suspended Session that is never touched again keeps `hasUnreleasedOwnership` true for the departed member, so the pool keeps that member's connector entry. This is the same state a crashed member leaves today; a reaper for such placements is an open question.

### Observability

- Harness: suspensions, suspension aborts by reason, predicate rejections by reason, cold opens and their duration split into store restore and MCP reinstallation, and `hosted_session_open_busy` refusals.
- Control plane: re-attachments after `hosted_session_not_found`, and wake activations that evicted a stale attachment.

### Failure modes

- **Harness crash during suspension.** Before the seal, the writer lease lapses and the Session is recovered exactly as after any Harness crash. After the seal, the Session is cleanly suspended.
- **Session Store unavailable during suspension.** The seal or the activation release fails before commit; the suspension aborts and the Session stays resident.
- **Late wake notification.** A notification for a suspended Session meets `hosted_session_not_found` or a missing attachment and reloads the Session.
- **Concurrent request.** The suspending mark is set synchronously after the predicate, so a request either arrives first and pushes back the timer, or arrives after and receives `hosted_session_closing`.

### Rollout

Suspension has no switch, and a Harness suspends Sessions on its own. It therefore needs a control plane that re-attaches vanished references, evicts stale attachments on wake and treats `hosted_session_open_busy` as a wait. Against an older control plane, the cached reference to a suspended Session would keep answering `hosted_session_not_found` and never re-attach.

- The control-plane changes land before, or in the same release as, the Harness change.
- The Harness and the control plane are upgraded together. A mixed-version rolling upgrade is not supported, the same boundary other Managed Agent changes set.
- No schema change is required.
- Stopping suspension means rolling back the Harness change. Sessions suspended before the rollback reopen on demand as before.

## Phase 2: Runtime-owned MCP and Hook connection lifetime

Boundary only; a separate design will precede implementation.

- **Today.** The lifetime of a Session's MCP connections and Hook owners equals its Harness attachment: a non-terminal close reconciles every configuration, drains it and dispatches `mcp-release`, and the next load reinstalls the configuration, reconnects and rediscovers.
- **Target.** The Tool Runtime, through the Broker, keeps a Session's connections across Harness attachments and retires them on its own idle period. A Harness re-acquires them by the durable owner identity and a grant issued to the new writer. The MCP design already advances a configuration's durable revision and issues a grant to a new writer after an idle reload while keeping the catalog and connection pins.
- **Interfaces to define.** A Broker distinction between suspending and releasing an owner; who retires connections and when; where unknown-outcome holds and their quotas live once the Harness no longer drains.
- **Effect.** Suspension and reopening no longer drain, reconnect or rediscover, which removes the largest part of the cold-open cost. stdio MCP servers, which are long-lived processes in the Runtime, are the main reason this ownership belongs to the Runtime.

## Phase 3: wake scheduling and observation in the control plane

Boundary only.

- **Today.** Each resident Session runs a `HostedMonitorWakeScheduler` in the Harness, with deferral timers and busy and blocked retries, and background Shell and Monitor observation loops run in the Harness. `WakeRecovery` in the control plane is the backstop for Sessions nobody holds.
- **Target.** The control plane decides when a Session has a due input and sends a wake request to any pool member; the Harness runs the requested input and suspends again. Observation of background work moves to the Runtime publisher and the control plane, so a Session with a background Shell or Monitor can suspend.
- **Existing assets.** The wake columns in `ma_session_head` (`is_wake_pending`, `wake_head_revision`, `wake_retry_at`), `WakeRecovery`'s handling of deferred `notBefore`, and the transport wake activator.

## Phase 4: parked approvals

Boundary only.

- **Today.** A Turn waiting for a tool approval keeps running in the Harness, held by `HostedApprovalWaiters`, although the checkpoint already records the `await_action` phase.
- **Target.** The Turn parks at `await_action` and its request ends. The approval response resumes it through the existing Managed Runtime continue path, on any pool member.

## Risks

- **Reopen latency.** In Phase 1 every reopen pays the full cold-open cost, including MCP reconnection and discovery. An idle period that is too short trades renewal savings for slow first responses; the initial constant is revised from measurements.
- **Cold-open bursts.** Synchronized wakes can overload the shared Session Store even when each Harness limits its own opens.
- **Close-path coupling.** Suspension reuses parts of the detach path; a later change to detach can silently change suspension. Tests pin every row of the close-path audit.
- **Pool leftovers.** Suspended Sessions on departed members keep their placement until touched.
- **No kill switch.** A defect in suspension can only be stopped by rolling back the Harness change. The validation plan below is the mitigation.

## Validation plan

Phase 1:

- **Harness unit tests.** Each predicate condition blocks suspension; the timer resets on requests and internal completions; the suspension sequence runs in order; each row of the close-path audit is pinned, in particular that no input is settled as cancelled, no `SessionEnd` or `SessionDelete` Hook runs, the owed file-history marker is retired and the Runtime lease is released non-terminally; aborts before the seal keep the Session resident and retryable; requests during suspension receive `hosted_session_closing`; opens beyond the limit are refused with `hosted_session_open_busy`.
- **Control-plane unit tests.** `activateForWake` evicts a stale attachment; the new code is transient and postpones Turns without charging their budget.
- **Real-process and MySQL integration.** Suspend, then prompt: the history is intact and the Turn completes. Suspend, then deliver monitor, channel, automation and child inputs: each is run after a reload through the transport path and through `WakeRecovery`. A deferred loop input becomes due after suspension and runs. A Session with a running background Shell is not suspended. Close and delete of a suspended Session. Pool takeover of a suspended Session after its member leaves.
- **Fault tests.** Kill the Harness during suspension before and after the seal; make the Session Store unavailable during suspension.
- **Measurement.** Cold-open duration and store load for Sessions of different sizes and MCP configurations, to revise the idle period and the open limit.

## Acceptance criteria

- A Session that is never idle for the idle period behaves as today, and existing test results are unchanged.
- An idle Session stops renewing within one idle period plus jitter and is no longer counted in `attachedSessions`.
- No suspension settles an input as cancelled or stops background work; every pending input runs after a reload.
- Every request to a suspended Session succeeds after at most one transient refusal and one re-attachment.
- The integration and fault tests above pass in CI.

## Open questions

1. A reaper that releases placements of suspended Sessions on members that left the pool.
2. The idle period (initially 10 minutes) and the open limit (initially 8), to be revised from cold-open measurements.
3. Whether recovery-blocked Sessions should also suspend once operator recovery can reload them.
4. Re-registering an active client-files binding with the Harness on reload, so that a Session with an open browser bridge can suspend.
5. Whether every pool member can reach every Workspace mount; Phases 2 to 4 assume any member can open any Session.
6. Whether a Turn's reload-stable Runtime owners, which a detach leaves running with their release owed (#16579), may stay running across a suspension, so that such Sessions can suspend too.
7. Suspending Sessions on a public Workspace Shell profile with MCP, whose plain detach requires a lifecycle authority today.
