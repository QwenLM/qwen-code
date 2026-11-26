# Stateless Hosted Harness: idle Session suspension and the path beyond it

[English](2026-11-16-managed-stateless-harness.md) | [简体中文](2026-11-16-managed-stateless-harness.zh-CN.md)

Status: Phase 1 (idle Session suspension) is being implemented in [#17690](https://github.com/QwenLM/qwen-code/pull/17690); it is not ready to enable until the recovery prerequisites, failure tests and measurements below pass. Phases 2 to 4 define boundaries and interfaces only and will each get their own design before implementation. Two addenda carry Phase 1 details this document only gates: the [recovery view](2026-11-18-managed-suspension-recovery-view.md) and [bounded recovery](2026-11-18-managed-suspension-bounded-recovery.md) for open question 8.

The Java prerequisites have partly landed since this design was written: [#17521](https://github.com/QwenLM/qwen-code/pull/17521) (admission-only 404 recovery, per-reference atomic attachment/marker updates, pool reselection), [#17680](https://github.com/QwenLM/qwen-code/pull/17680) (continuation-ready parks driven in the epoch-less resubmission arm) and [#17681](https://github.com/QwenLM/qwen-code/pull/17681) (SDK heartbeat retirement notice, `hosted_session_open_busy` / `hosted_session_teardown_blocked` classification, and the wait ageing cap, now `WAIT_CHURN_BUDGET_FACTOR`). What remains is listed under Control-plane changes. Current-state claims were checked against `main` at `326818aa28` and re-checked against `78f8bfb1dc` for the sections updated here.

## Relationship to the idle parking proposal

The [idle parking proposal](2026-11-08-hosted-idle-parking.md), merged as documentation in [#16564](https://github.com/QwenLM/qwen-code/pull/16564), already specifies Harness-owned idle release. Its status is still a proposal, and its measurements are historical results, not acceptance of an implementation. This document keeps that work as the baseline for idle timing, reference-safe Java recovery, per-Session concurrency and uncertain outcomes, and adds the longer-term stateless target. The two phase numberings describe different plans.

| Decision                     | This proposal                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle clock and concurrency   | Adopt the earlier proposal's activity exclusions, bounded pre-teardown wait and gate covering loads and internal work.                                                                                                                                                                                                                                                |
| Java recovery                | Adopt its atomic entry/marker updates, admission-only 404 recovery, Turn recovery, pool reselection and heartbeat retirement notice. Land these before any autonomous suspension.                                                                                                                                                                                     |
| Store protocol               | Start with the existing seal protocol, retain placement and add no schema change. This requires keeping failed or uncertain teardown gated; a timeout does not permit immediate reopening. The earlier proposal's atomic park transaction, receipt and lease counter remain an alternative if bounded automatic recovery cannot be proved with the existing protocol. |
| MCP, Hooks and deferred work | Keep the broader target, but suspend only configurations with proven teardown. A Session with any pending input, including a future `notBefore`, stays resident until Phase 3 moves wake scheduling to the control plane. Other unsupported cases remain resident too.                                                                                                |
| Defaults and cost            | Keep coordinated upgrades and no configuration switch. Ten minutes and eight concurrent cold opens are candidates, subject to measurements before enabling suspension. A concurrency limit does not make each restore cheaper.                                                                                                                                        |

The stateless goal and Phases 2 to 4 remain unchanged. Reusing the earlier correctness rules does not require adopting its entire Store transaction, or treating its five open questions as accepted decisions.

## Problem

A Managed Session that a Hosted Harness has attached stays resident in that Harness process until the Session is closed or deleted. The control plane never detaches an ordinary Session, so a Session the user stopped talking to an hour ago is handled exactly like one with a Turn running.

While resident, every Session pays for itself continuously:

- **Writer lease and activation renewal.** The Harness renews the Session's writer lease and its activation through the private Session Store, one `/writers:renew` request per Session roughly every `leaseDurationMs / 3` (20 seconds at the 60-second default). The earlier proposal records 51–56 SQL statements per idle minute per Session on its historical rig. Current statement counts must be measured again; the cost scales with resident Sessions, not with active Turns.
- **Harness memory and per-Session owner state.** Each resident Session holds its restored journal state, its model context, its MCP and Hook owner state (configuration records, catalogs, grants), its wake scheduler and its timers. The Harness reports `attachedSessions` as a load signal, so idle Sessions consume capacity that active Sessions could use.
- **Runtime-side connections.** The MCP connections and Hook owners for the Session live in its Tool Runtime and stay open for as long as the Harness keeps the Session attached.

Managed Agent is before its first formal release, as reflected in its schema policy. This proposal assumes deployments with thousands of attached Sessions of which most are idle; that is a target, not a measured workload. It retains coordinated Harness/control-plane upgrades and no supported configuration key or capability negotiation. These choices do not replace the recovery and measurement gates below.

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

- it stops every live background Shell and Monitor observation loop and settles them as `stop_requested`, or `runtime_lost` where the Session is blocked or the held drain failed or could not be proven;
- it settles every pending monitor, channel, automation, child, session-message and loop input as **cancelled**, model-free, before the log closes;
- it releases the Runtime lease, drains held Runtime work and retries any hosted cleanup debt;
- it closes Hooks and MCP (non-terminally for a detach, which drains the Runtime connections but keeps the owner re-acquirable);
- it releases the activation and seals the writer.

Reusing it for idle Sessions would cancel queued and deferred inputs that the user expects to run. Phase 1 therefore adds a separate suspension path; the close-path audit in Phase 1 lists every effect of the handler and how suspension treats it.

### What already tolerates a Harness letting a Session go

- **Recovery from an unowned writer.** `WakeRecovery` scans every two seconds, handles up to eight candidates per pass and calls `recoverForWake`, which performs a passive load. It recognizes sealed writers and expired active leases; a crash can leave the latter. Its SQL selection is limited to eligible active public Sessions with an uncompacted journal. Its deferred-input handling specifically preserves future loop inputs and their wake hint. It is not timely: a claim postpones the Session's next attempt by 30 seconds, each attempt proves at most 32 journal transactions, and a cached proof that skipped a future loop input restarts from the first transaction once that input is due. On a journal of 201 transactions, the wake therefore comes at least three minutes after the input is due. It is a crash backstop, not a general durable scheduler for every Session or every `notBefore`.
- **Re-attaching a vanished reference.** #17521 landed the admission-only 404 retry, the per-reference atomic attachment/marker rule and pool reselection; #17680 added the continuation drive for the epoch-less resubmission arm. Plain loads can still be refused for resident Sessions, so the rules in Reopening remain the contract.
- **Transient closing.** `hosted_session_closing` is classified transient (`HarnessConflictCodes`); public routes surface it as a retryable 503, and the session-message, child-result and lifecycle paths already treat it as retryable.
- **Placement takeover.** The store admits a takeover on one of two paths: the placement is `RELEASED` with a release receipt and the head is sealed, or the writer lease has lapsed and the activation is known and released, revoked or expired. Sealing alone does not shorten `writer_lease_until`, so a Phase 1 suspension — which retains the placement and writes no receipt — leaves the Session takeover-eligible only once its lease lapses, up to the 60-second default. Until then the request is refused with `harness_owner_still_live`, which the pool-ownership wait codes already classify as a wait.
- **Drain release.** `releaseIdleOwner` in `packages/cli/src/serve/hosted-harness-session.ts` already releases a Session without cancelling its inputs, but only on a draining pool instance: it returns at once while the instance accepts work. It refuses while any of its busy checks holds, some of them instance-wide, and while a pending input is not a wake input or was already attempted by a wake. It then stops renewal, releases the activation and releases the placement through a Store receipt (`quiesceOwnership`, `prepareOwnershipRelease`, `releaseOwnership`); a failed release keeps the Session attached and is retried with the same operation id and commit proof. Finally it closes the wake scheduler, event streams, the local Store client and the client-files registration and removes the Session. It does not close Hook or MCP owners or release the Runtime lease.

## Goals and non-goals

Goals:

- Release the per-Session resources of an eligible idle Session without cancelling its inputs or losing history.
- Reopen a cleanly suspended Session on the next request, wake input or lifecycle operation. Expose failed suspension as recovery work, rather than silently reopening an uncertain writer.
- ~~Add no supported configuration key and no capability negotiation~~; the Harness and the control plane are released and upgraded together. The only override is the test-only idle period described below. (This was the Phase 1 constraint; the [suspension placement-release addendum](2026-11-26-managed-suspension-placement-release.md) adds a writer-grant capability for mixed-version safety but still adds no configuration key.)
- Define the target architecture, a Harness that holds no Session between requests, and the boundaries of the steps that lead there.

Non-goals for Phase 1:

- Redesigning journal restore. Phase 1 measures its current cost before enabling suspension; a failed cost gate requires targeted load improvements first. Phase 2 removes the MCP/Hook reconnect component, not all history-dependent restore cost.
- Moving the wake scheduler, approval waits or observation loops out of the Harness. Sessions that need them stay resident in Phase 1.
- Adopting the earlier proposal's Store park transaction or changing the writer lease protocol without evidence that the existing protocol cannot satisfy the failure gates.
- ~~Releasing placements of suspended Sessions~~ (superseded by the [suspension placement-release addendum](2026-11-26-managed-suspension-placement-release.md); pull scheduling remains a separate design).

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

Each resident Session gets an activity-based idle timer. When it fires, the Harness checks eligibility, gates the Session and waits for its in-flight work before checking again. It then stops local scheduling, drains eligible owners, releases Runtime ownership and closes the writer without cancelling inputs. Only confirmed cleanup permits normal reopening. Once teardown starts, a failure cannot return the partially closed object to ordinary service.

### Idle period

- The candidate idle period is a constant in the Harness, initially 10 minutes. There is no supported configuration key or request field for it, and the Harness advertises no capability for suspension.
- Unit tests set a shorter period through a constructor option. A Harness that real-process tests start as its own process reads a shorter period from the test-only variable `QWEN_E2E_IDLE_SUSPEND_MS`, like the existing E2E fault-injection variables such as `QWEN_E2E_DROP_LOAD_REPLY`. The Harness honors only values below the constant, so the variable cannot disable suspension; deployments never set it.
- The Harness applies a jitter of up to 10 percent to each timer so that Sessions that went idle together do not suspend together.
- Measurements choose the shipping constant before suspension is enabled; ten minutes is not an accepted default merely because it appears here.

### Idle predicate

When the timer fires, the Harness suspends the Session only if all of the following hold; otherwise it re-arms the timer for another full period.

- No Turn is active and no recovered Turn is waiting for a continue or cancel drive.
- No Harness event stream is open — the Session's stream set is empty. That covers the Turn's stream and any read-only observer, both of which a teardown would cut.
- No input is pending, including a loop input whose `notBefore` lies in the future. The resident wake scheduler delivers such inputs when they become due; SQL wake recovery would deliver them late on a long journal (see Current state). Phase 3 moves wake scheduling to the control plane so that these Sessions can suspend.
- No MCP or Hook operation is pending or recovering, no MCP configuration is being installed or refreshed, no session-message operation is in flight, and no context compression is running.
- No background Shell or Monitor observation loop is live.
- No channel reply-plan retry is scheduled or running, no post-Turn delivery or reconciliation is owed, and no journal append or activation renewal has an unsettled outcome.
- No Runtime that a Turn left held remains, no Runtime work is unsettled, and the hosted cleanup debt is zero.
- No client-files registration is active. The control plane keeps the browser's binding and closes it only when it closes or deletes the Session, so a Harness that dropped the registration on its own would leave the browser showing a connected bridge whose tools the model no longer has. A closed tab ends the binding at once, because its downlink closes; the Session can suspend after that.
- No lifecycle authority, ownership release or pool quiescing is in progress.
- The Session is not recovery-blocked. A blocked Session stays resident so that operator recovery keeps working unchanged.
- The Session is not on a public Workspace Shell profile (`hosted-workspace-shell/1`, `hosted-workspace-shell/3` or `hosted-workspace-shell/4`) with MCP. A plain detach of such a Session requires a lifecycle authority and is refused with `hosted_lifecycle_required`, so Phase 1 never suspends it.

Check persistent blockers before raising the gate. Recheck eligibility and mark the Session in one synchronous section, coordinating with pool drain and lifecycle ownership. A Session excluded by a blocker therefore continues serving without periodic closing refusals.

The predicate starts from the busy checks of `releaseIdleOwner`, evaluated per Session rather than instance-wide, and is stricter about inputs: the drain path may leave unattempted wake inputs pending because a successor owner loads them, while Phase 1 suspends only with no pending input. Suspension does not call `releaseIdleOwner` itself, because that helper runs only on a draining instance and releases the placement, which Phase 1 retains.

### Timer

- Measure idleness from the newest of: the last admitted mutation, the last non-renewal journal commit, Turn settlement, a completed load and an abandoned reversible suspension attempt. A long-running Turn and a read-triggered load both get a full residency period after completion.
- Heartbeats, read-only polling, activation renewals and rejected requests do not reset the clock. Internal work that produces one of the activity events above does; mere scheduling does not.
- A failed pre-check or bounded wait re-arms a full idle period. Teardown failure enters the recovery state below, not another ordinary idle attempt.
- Clear the idle timer on close, delete, suspension or lifecycle handoff. On successful teardown, stop every per-Session timer and publisher, including channel reply-plan retries.

### Admission gate and in-flight work

The gate is keyed by the full Session scope in both single-address and pool modes, and survives removal of the resident object while cleanup is uncertain. It covers every ordinary Session route and every `open()` path before acquiring a writer or reusing a resident: create, ordinary load, passive load, driving recovery and MCP-management load. The load route is registered before the existing Session middleware, so middleware alone cannot provide this guarantee. Private teardown reconciliation remains able to complete under its captured writer identity; an ordinary lifecycle load cannot bypass the gate.

Gated callers receive retryable `409 hosted_session_closing` while the gate is reversible or teardown is still converging. Once teardown reaches its retry cap and waits for operator recovery, the gate answers `409 hosted_session_teardown_blocked` instead. That code is not transient: callers stop waiting, and lifecycle close/delete reconcile or take over under their authority. Track already-admitted asynchronous work until its own `finally`, including work whose HTTP caller disconnected. Neither response completion nor the instance-wide request counter proves a Session's work has settled. The wake pump, reply planning and other internal mutation sources obey the same gate. Wait for a bounded interval, then check the predicate again. A timeout or failed check may clear the gate only before teardown has started. Renewal shutdown must await in-flight renewal outside the authority's serial queue, avoiding a wait on that queue from inside itself.

### Suspension sequence

1. Raise the gate, wait for admitted work and recheck eligibility as above. Failure here leaves the object intact, clears the gate and re-arms the timer.
2. Begin irreversible teardown by closing the wake scheduler without settling any input. From the first teardown call, including a call that throws, the object cannot return to ordinary service.
3. Close the Hook and MCP owners non-terminally, the same calls a detach makes. This drains the Runtime connections and leaves the owners re-acquirable by the next load.
4. Release the Runtime lease non-terminally with the existing helper, which first retires a settled Turn's owed file-history marker. Reconcile hosted cleanup debt. Remaining or unknown debt keeps the Session gated; it is not a successful suspension.
5. Close the Shell and background-lane publishers. No observation loop is live, so nothing is waiting to settle through them, and the next load recreates them.
6. Stop renewal and wait for its in-flight work, release the activation and seal the writer. `managed.close()` supplies existing close behavior, not a reversible transaction; suspension needs a local helper that exposes the individual outcomes and preserves the ability to reconcile the same seal.
7. After resource cleanup, activation release and seal are confirmed, permanently stop the old client and every remaining callback, remove the resident and clear the gate. The next request may cold-open it.

### Failed or uncertain teardown

The rollback boundary is the first teardown call, not the seal. `managed.close()` permanently stops activation renewal and attempts seal even if activation release fails. A successful seal with an unconfirmed activation release is recovery work, not a clean suspension. Partially closed Hook/MCP owners, publishers and schedulers are not restored by clearing a flag.

After that boundary, keep ordinary work and loads gated. Reconcile the original operation, preserving its writer id, generation, token and resource-owner identities. Retry only operations whose existing protocol permits an exact retry, with backoff, jitter and an explicit cap. At the cap, stop automatic attempts, answer `hosted_session_teardown_blocked` and expose the blocked cleanup for operator recovery; retain the gate and the evidence needed to finish it. Do not cancel pending inputs or lose durable cleanup obligations. Stop ordinary renewal and business callbacks, but do not call `stopLocal()` while the original client is still needed to reconcile a seal: it disables those requests too.

A seal timeout does not prove absence. Within a live lease, a new client using the same Harness boot id and token can acquire the same writer generation; a delayed old seal can then seal the new attachment. Waiting one lease interval on the local clock is not proof either, because seal checks writer identity and generation without requiring an unexpired lease. Normal reopening requires confirmed completion of the old teardown, or Store-backed proof that a successor generation fences every old operation and owns the remaining recovery obligations. Changing the writer id independently of the Harness boot id is not a workaround. The implementation must demonstrate this transition; if the existing protocol cannot provide the required automatic recovery, revisit the earlier proposal's fencing mechanism before enabling suspension.

A new Harness process uses the existing crash-recovery path and its new boot identity. It must still honor writer fencing and cleanup obligations; restart is not evidence of clean suspension. Lifecycle close/delete racing a failed suspension must reconcile or take over under their existing authority, never enter through an ungated ordinary load.

Suspension skips the ordinary execution authorization a detach requests first: it starts no work, and the seal is fenced by the writer itself. The audit below lists every other difference from detach; tests pin each one.

### Close-path audit

Every effect of the detach and delete handler (`close` in `packages/cli/src/serve/hosted-harness-session.ts`), and how suspension treats it. A Session under a lifecycle-protocol-2 operation runs its resource phases through the control plane and the handler then only seals; suspension never runs under a lifecycle authority, so the full path below applies.

| Effect                                                                                                                           | Detach (`POST`)                                                                       | Delete                                                  | Suspension                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Authorization                                                                                                                    | Ordinary `/execution:authorize`                                                       | None                                                    | Skipped                                                                             |
| Wait for in-flight session-message operations                                                                                    | Yes                                                                                   | Yes                                                     | Not needed: the predicate requires none                                             |
| `SessionEnd` and `SessionDelete` Hooks                                                                                           | No                                                                                    | Yes                                                     | Never                                                                               |
| Drain Runtimes a Turn left held                                                                                                  | Yes, except reload-stable owners, which keep running with their release owed (#16579) | Yes, all                                                | Not needed: the predicate requires none                                             |
| Close Hook owners                                                                                                                | Non-terminal                                                                          | Terminal, plus release of orphaned configuration owners | Non-terminal, as detach                                                             |
| Close the wake scheduler                                                                                                         | Yes                                                                                   | Yes                                                     | Yes, without settling inputs                                                        |
| Retire a settled Turn's owed file-history marker, then release the Runtime lease                                                 | Yes, non-terminal                                                                     | Yes, terminal                                           | Yes, non-terminal                                                                   |
| Stop observation loops, settled `stop_requested` or `runtime_lost`                                                               | Yes                                                                                   | Yes                                                     | Not needed: the predicate requires none live                                        |
| Retry hosted cleanup debt                                                                                                        | Yes                                                                                   | Yes                                                     | Yes; remaining or unknown debt keeps teardown gated                                 |
| Close the Shell and background-lane publishers                                                                                   | Yes                                                                                   | Yes                                                     | Yes                                                                                 |
| Close MCP owners                                                                                                                 | Non-terminal                                                                          | Terminal                                                | Non-terminal, as detach                                                             |
| Close the client-files registration                                                                                              | Yes                                                                                   | Yes                                                     | Not needed: the predicate requires none                                             |
| Settle pending monitor, channel, automation, child, session-message and loop inputs as cancelled, then reconcile automation runs | Yes                                                                                   | Yes                                                     | Never: the predicate requires no pending input, and later inputs reopen the Session |
| Release the activation and seal the writer                                                                                       | Yes                                                                                   | Yes                                                     | Yes                                                                                 |
| Stop event streams and remove the Session                                                                                        | After the seal                                                                        | After the seal                                          | After confirmed teardown; retain the gate on uncertain cleanup                      |

When the control plane closes or deletes a Session, its lifecycle coordinator also closes the browser's client-files binding (`closeForSession`); nothing closes it when the Harness drops the registration on its own, which is why an active registration blocks suspension.

The timer audit includes idle and wake timers, activation and writer renewal, channel reply-plan retries and event-stream callbacks. A callback must not restart work on a gated or removed object. The implementation inventories the remaining owner and publisher cleanup paths rather than assuming that the close handler is a complete timer inventory.

### Reopening

- **Admission verbs.** Prompt, approval/question response, channel, automation, message and child admission retry once after an exact `404 hosted_session_not_found` on the reference they used. Admission is the boundary, not the whole operation family: cancellation and committed-stop operations keep their existing recovery semantics. A passive re-attachment handles eligible non-Turn admissions; the Turn path re-enters `recoverManagedRuntime` and the coordinator's recovery handling, including `pendingRecovery`, `bindRecoveredHarness` and event watermarks. A leaf must not discard a returned recovery snapshot and simply resubmit the prompt. Preserve tenant, Workspace and action-specific authorization; setting passive on every new-work load is not a substitute.
- **Reference and marker ownership.** Publication, removal and marker changes use one atomic step per attachment key, conditional on the reference being changed. Apply this to every connector path, not only the new 404 handler. Do not run network I/O inside a map `compute`. A late 404 or heartbeat notice for an old reference must leave a newer reference and its marker intact. Treat `mcpManagementAttachments` by reference identity as well; never fall through to a known stale entry in the other cache.
- **Other verbs and heartbeat retirement.** Cancel, rename, Harness streams, context-compression reads, MCP/client-files management, extensions and runtime-skill reads stay outside the blanket 404 retry. The SDK notifies the connector when heartbeat retirement removes a reference, and the connector uses the same atomic rule. With a healthy periodic heartbeat, stale failures are bounded by that notification; disabling heartbeats removes that bound. Keep coded refusals intact instead of converting an evicted, non-loading resolver into a local exception. Lifecycle settlement keeps its rule that absence proves nothing.
- **Wake inputs.** A suspended Session had no pending input, so a wake usually concerns an input admitted after suspension. It need not: the transport activator only checks that the notice's sequence is committed and that no writer is live, so a notice delivered after the resident already consumed its input and suspended still loads the Session once. That reload is measured, not assumed away. When the wake fence proves there is no live writer, `activateForWake` evicts exactly the reference it observed, with its marker, before the recovery load; a concurrently published newer attachment survives and the verb reports it attached. The MCP-management cache holds its own references and is evicted under the same per-key identity rule. If the transport notice is lost, SQL wake recovery remains the backstop only for its supported Session scope, with the lateness described under Current state. Do not clear wake hints using the in-memory idle predicate.
- **Lifecycle and status.** Close/delete use their existing authority and recovery path, and wait on a suspension gate without spending the lifecycle retry budget. A recovery/status response must not report success from a missing cache entry or assume it proves an operator failure: establish the durable writer/activation state and follow the [recovery view addendum](2026-11-18-managed-suspension-recovery-view.md). A sealed head alone is not that proof — a refused load closes its writer the same way — and the view is projected onto every ordinary Session read, not only the operator endpoint.
- **Pool selection and errors.** A retry returns through `HarnessPoolConnector.select` with acquiring allowed and obtains a fresh `PoolCall`, even though a successful Phase 1 suspension retains placement. Preserve `hosted_session_closing`, `hosted_session_open_busy` and placement waits as transient outcomes, within the ageing bound under Cold-open admission; do not hide them under the original 404. `hosted_session_teardown_blocked` is a refusal, not a wait. Generation changes, unknown outcomes and terminal recovery failures retain their own classifications.
- **A 409 is not one meaning.** `create()`, `channelAttachment()` and `automationAttachment()` may fall back to a passive load only for the codes that say the Session is already there (`hosted_session_already_attached`, `managed_session_already_exists`). Every other 409 keeps its own code and reaches the caller: loading again behind a closing gate, a full cold-open slot or a wedged teardown spends a second admission on a wait, and behind `hosted_session_open_busy` it loads a journal the refused create never wrote.

### Cold-open admission

Suspension turns some steady-state work into bursts of cold opens, for example when one automation schedule fires for many suspended Sessions at once, or when a pool member restarts. Each cold open restores the journal and reinstalls MCP configurations, whose connection and discovery each wait up to 25 seconds.

- The Harness limits concurrent cold opens per instance, with 8 as the candidate constant. An open beyond the limit is refused with the new code `409 hosted_session_open_busy`.
- The limit applies to every cold open, including a first create — which installs MCP and Hook owners even without a journal to restore — and the bulk reloads that follow a Harness restart, which it also smooths. A cap-refused create publishes no resources and leaves no unresolved-opening debt.
- The control plane classifies `hosted_session_open_busy` as transient in `HarnessConflictCodes` and, in `HarnessCoordinator`, as a code that postpones a Turn without charging its admission budget, alongside the existing pool-ownership wait codes (#17681). Without it, a burst of refusals would exhaust the admission budget of queued Turns and fail them.
- An exempt wait still needs an ageing bound, and the bound means different things per caller. #17681 renamed the cap `WAIT_CHURN_BUDGET_FACTOR` and applies it to generation and pool waits alike: past it a **Turn** fails with its phase's unavailable code. A **lifecycle** operation instead publishes `recovery_blocked` with the refusal's own code and keeps being re-driven, because giving up would strand the resources it owes. The **relays** are the remaining gap. #17681 exempts the command-execute and child-stop arms, and Stage 3 of #18149 exempts every step of ordinary session-message delivery, whose closing wait the Harness bounds by escalating to `hosted_session_teardown_blocked`; child-result delivery and automation fires still charge these waits against their attempt budget. Since transport wake and SQL wake recovery both cover public Sessions only, a suspended child Session depends on those relays, and a cold-open burst can settle its message as cancelled or unknown. Closing that gap is a Phase 1 prerequisite, not a follow-up.
- The control plane's existing bounds stay: the transport wake load pool and `WakeRecovery`'s eight candidates per pass.
- The Session Store is shared by every pool member, so the per-instance limit does not bound store load or reduce total restore work. Before enabling suspension, measure idle SQL, cold-open SQL/latency/CPU by history size, MCP reconnect cost, reclaimed memory and the reload frequency caused by reads or late wake notices. Compare resident and suspended workloads across multiple pool members. Record the workload and accepted latency/store budgets; revise the constants or reduce load cost if the candidate defaults fail them. The old 51–56 statements/minute and 200-Turn load measurements are baselines to reproduce, not current guarantees.

### Control-plane changes

All of these land before, or in the same release as, the Harness change (see Rollout). Landed items are marked; the rest is still owed.

1. **Landed (#17521, #17680).** The admission/recovery contract above: admission-only 404 recovery, argument-sensitive Harness mocks, recovery-snapshot and watermark handling including the epoch-less resubmission arm. A cached reference's disappearance and a completely absent Session are distinct cases. The real two-control-plane takeover test is still owed.
2. **Landed (#17521, #17681).** Every attachment/marker update under the per-key ownership rule, and the SDK heartbeat retirement notice.
3. **Partly landed (#17681).** Pool reselection on retry; closing, open-busy and ownership waits preserved in coordinator and lifecycle handling, with the ageing bound under Cold-open admission, and `hosted_session_teardown_blocked` never treated as a wait. Ordinary session-message delivery has the exemption since Stage 3 of #18149. **Still owed:** the same exemption and bound for child-result delivery and automation fires, named under Cold-open admission.
4. **Partly landed (#17690).** Wake cache invalidation evicts exactly the observed reference in both caches. **Still owed:** proving deferred-input eligibility and durable hints, and the recovery/status behavior of the [recovery view addendum](2026-11-18-managed-suspension-recovery-view.md) against real MySQL.
5. **Landed (#17690).** `create()`, `channelAttachment()` and `automationAttachment()` keep every non-already-held 409's own code instead of loading again.
6. Update the permanent-residency assumptions in the coordinator only when the above behaviors and their tests land. A green mock-only retry test does not establish them.

### Delivery order

First land the Java/SDK prerequisites, which are useful without suspension. Next implement the Harness clock, admission gate and teardown states with deterministic race and failure tests. Run real-process/MySQL recovery checks and the current-version cost measurements before enabling autonomous suspension. Keep these as reviewable changes; #17690 carries the Harness slice and the remaining connector fixes, and the measurements and real-MySQL gates are still owed. Phases 2 to 4 follow after Phase 1 meets its acceptance criteria.

### Pool interaction

A suspended Session keeps its placement. If its pool member leaves the pool, the next request takes the placement over — but only once the writer lease has lapsed, since Phase 1 writes no release receipt and sealing does not shorten the lease (see Current state). Until then the takeover meets `harness_owner_still_live` and waits. A suspended Session that is never touched again keeps `hasUnreleasedOwnership` true for the departed member, so the pool keeps that member's connector entry. This is the same state a crashed member leaves today; a reaper for such placements is an open question.

### Observability

- Harness: clean suspensions, reversible aborts, gated failed/uncertain teardown and its age/reason, predicate rejections, cold opens split into store restore and MCP reinstallation, and `hosted_session_open_busy` refusals. Failed teardown is not counted as a clean suspension. The counts accumulate from process start and are reported under `suspension` on the instance's `/internal/hosted-harness/v1/metrics` route.
- Control plane: admission re-attachments, heartbeat retirements, preserved recovery snapshots, pool reselections, wake activations that evicted a stale attachment, and waits that reached their ageing bound.

### Failure modes

- **Harness crash during suspension.** Existing crash recovery fences the old writer and reconciles durable obligations. A sealed writer alone does not prove all resource cleanup or activation release completed.
- **Session Store unavailable during suspension.** Before teardown, abandon the attempt. After teardown starts, keep the Session gated and reconcile; a failed or timed-out request does not prove that the Store did not commit it.
- **Late wake notification.** A notification for a suspended Session meets `hosted_session_not_found` or a missing attachment and reloads the Session.
- **Concurrent request or internal work.** Work admitted before the gate is tracked to completion and rechecked; later work, including loads and timer callbacks, cannot enter. Only meaningful activity resets the idle clock.
- **Late seal after a failed attempt.** Retain the old writer's gate until completion or a proven successor fence. A fresh client with the same boot id is not such a fence.

### Rollout

Suspension has no switch, and a Harness suspends Sessions on its own. It therefore needs a control plane that re-attaches vanished references, evicts stale attachments on wake and treats `hosted_session_open_busy` as a wait. Against an older control plane, the cached reference to a suspended Session would keep answering `hosted_session_not_found` and never re-attach.

- The control-plane changes land before, or in the same release as, the Harness change.
- The Harness and the control plane are upgraded together. A mixed-version rolling upgrade is not supported, the same boundary other Managed Agent changes set.
- The initial design uses no schema change. If its failure/recovery proof needs a Store fencing change, review that explicit change before enabling suspension; do not weaken the gate to preserve this preference.
- Stopping suspension means rolling back the Harness change through the coordinated deployment procedure. Cleanly suspended Sessions reopen on demand. Failed or uncertain teardown still needs fenced recovery; rollback must not reopen an old in-process object or discard its recovery evidence.

## Phase 2: Runtime-owned MCP and Hook connection lifetime

Boundary only; a separate design will precede implementation.

- **Today.** The lifetime of a Session's MCP connections and Hook owners equals its Harness attachment: a non-terminal close reconciles every configuration, drains it and dispatches `mcp-release`, and the next load reinstalls the configuration, reconnects and rediscovers.
- **Target.** The Tool Runtime, through the Broker, keeps a Session's connections across Harness attachments and retires them on its own idle period. A Harness re-acquires them by the durable owner identity and a grant issued to the new writer. The [MCP design](2026-09-28-managed-mcp-runtime.md) already advances a configuration's durable revision and issues a grant to a new writer after an idle reload while keeping the catalog and connection pins.
- **Interfaces to define.** A Broker distinction between suspending and releasing an owner; who retires connections and when; where unknown-outcome holds and their quotas live once the Harness no longer drains.
- **Effect.** Suspension and reopening no longer drain, reconnect or rediscover. This removes that component of cold-open cost; measurements must establish its share, and journal restore remains separate. stdio MCP servers, which are long-lived processes in the Runtime, are the main reason this ownership belongs to the Runtime.

## Phase 3: wake scheduling and observation in the control plane

Boundary only.

- **Today.** Each resident Session runs a `HostedMonitorWakeScheduler` in the Harness, with deferral timers and busy and blocked retries, and background Shell and Monitor observation loops run in the Harness. `WakeRecovery` in the control plane is the backstop for Sessions nobody holds. Phase 1 keeps every Session with a pending input resident.
- **Target.** The control plane decides when a Session has a due input and sends a wake request to any pool member; the Harness runs the requested input and suspends again. Observation of background work moves to the Runtime publisher and the control plane, so a Session with a background Shell or Monitor can suspend.
- **Existing assets.** The wake columns in `ma_session_head` (`is_wake_pending`, `wake_head_revision`, `wake_retry_at`), `WakeRecovery`'s handling of deferred `notBefore`, and the transport wake activator.

## Phase 4: parked approvals

Boundary only. See [Action parking](2026-11-21-managed-action-parking.md) for the pre-implementation design; it resumes the Turn through the G3 step 3 approval-continuation driver, not the Managed Runtime continue path named below.

- **Today.** A Turn waiting for a tool approval keeps running in the Harness, held by `HostedApprovalWaiters`, although the checkpoint already records the `await_action` phase.
- **Target.** The Turn parks at `await_action` and its request ends. The approval response resumes it through the existing Managed Runtime continue path, on any pool member.

## Risks

- **Reopen latency and total cost.** In Phase 1 every reopen pays the current restore and MCP reconnect cost. Candidate constants must pass the cost gate before shipping; journal-load improvements may still be required first.
- **Cold-open bursts.** Synchronized wakes can overload the shared Session Store even when each Harness limits its own opens.
- **Close-path coupling.** Suspension reuses parts of the detach path; a later change to detach can silently change suspension. Tests pin every row of the close-path audit.
- **Failed teardown availability.** With the existing seal protocol, a capped uncertain outcome may require operator recovery while the Session remains gated. The implementation must prove safe convergence or explicitly revise the Store protocol before claiming bounded automatic recovery.
- **Pool leftovers.** Suspended Sessions on departed members keep their placement until touched.
- **No kill switch.** A defect in suspension can only be stopped by rolling back the Harness change. The test-only idle-period variable accepts only shorter periods, so it is not a switch either. The validation plan below is the mitigation.

## Validation plan

Phase 1:

- **Harness clock and gate.** Heartbeats, polling and renewals never postpone suspension; admitted mutations, Turn settlement and completed loads do. Each blocker leaves the Session serving normally. Force races with load, pool drain, reply-plan timers and a disconnected HTTP caller whose work continues. Gate all load modes and internal admission, track work to completion, bound the reversible wait and avoid renewal/serial-queue deadlock.
- **Harness teardown.** Pin every close-audit row: no cancelled input, no `SessionEnd`/`SessionDelete` Hook, non-terminal resource release and no surviving callback. Fail each teardown step and verify that only pre-teardown failures resume the original object. Test confirmed seal with failed activation release, unknown seal, capped retries and `stopLocal()` ordering. An old delayed seal must never affect a reopened attachment.
- **Control-plane recovery.** Force stale-404/new-reference and late-heartbeat/new-reference interleavings and assert the newer recovery snapshot survives. Mock load like the real Harness: reject ordinary loads over a resident Session. Exercise the coordinator's recovered Turn and watermark handling, pool reselection after placement changes, both attachment caches, and the boundary between admission and non-retried operations. Closing/open-busy waits must retain their codes and not consume retry budgets. A Turn that keeps meeting `hosted_session_open_busy` or the suspension gate fails with its phase's unavailable code at the ageing bound, and `hosted_session_teardown_blocked` is never treated as a wait.
- **Wake and status.** Invalidate only the observed stale attachment on a no-live-writer fence. Any pending input, including a future loop input, keeps the Session resident. An input admitted after suspension reopens it through the transport wake, and after a lost notice through SQL recovery for an eligible Session. Preserve wake hints and verify recovery/status answers for clean suspension, uncertain teardown and genuine recovery failure.
- **Real-process and MySQL integration.** Two control planes sharing one Harness recover a stale reference. Suspend then prompt with history intact; deliver monitor, channel, automation, message and child inputs through both transport and eligible SQL recovery. Test lifecycle close/delete, disabled heartbeat behavior, pool member departure and a placement change during retry. These cases must run in the required CI tier; a skipped Hosted or MySQL gate is not acceptance.
- **Fault tests.** Kill the Harness before and after each irreversible boundary; lose Store replies after commit; delay an old seal across a new load; race lifecycle claims and renewal completion with teardown. Verify retained evidence, fencing and convergence without replaying side effects.
- **Measurement.** Compare resident and suspended workloads by history size, MCP configuration and pool size. Record idle and restore SQL, latency, CPU, reclaimed memory, unnecessary reloads and the lateness of SQL recovery after a lost wake notice by journal length, and choose the shipping constants against explicit budgets.

## Acceptance criteria

- A Session that is never idle for the idle period behaves as today, and existing test results are unchanged.
- With dependencies healthy and the predicate satisfied, an idle Session starts teardown after one idle period plus jitter; confirmed teardown stops renewals and removes it from `attachedSessions` within the measured teardown budget. Report failed teardown separately.
- Suspension never settles input as cancelled or stops active background work. A Session with any pending input, including a future `notBefore`, does not suspend; an input admitted after suspension reopens it.
- An eligible admission encountering a vanished reference makes at most one recovery retry in that call. Healthy clean suspensions reopen; transient waits may span multiple dispatches without exhausting admission budgets, up to their ageing bound. Other verbs follow the heartbeat retirement contract, not a universal one-call success promise.
- A stale reference or heartbeat never erases a newer recovery marker; a stale placement is never reused for the retry; an old teardown cannot mutate a successor writer or owner.
- No partially closed object resumes service. Every failed or unknown outcome either converges through proven recovery or remains visibly gated for operator recovery with its obligations retained, answering `hosted_session_teardown_blocked` rather than a transient wait.
- The specified real-process, MySQL and fault checks pass in CI, and current-version measurements justify the shipping constants. Documentation, mock tests or skipped gates do not satisfy this criterion.

## Open questions

1. A reaper that releases placements of suspended Sessions on members that left the pool.
2. The shipping idle period and open limit (candidates: 10 minutes and 8), and the accepted latency/store budgets, chosen before enablement from current-version measurements.
3. Whether recovery-blocked Sessions should also suspend once operator recovery can reload them.
4. Re-registering an active client-files binding with the Harness on reload, so that a Session with an open browser bridge can suspend.
5. Whether every pool member can reach every Workspace mount; Phases 2 to 4 assume any member can open any Session.
6. Whether a Turn's reload-stable Runtime owners, which a detach leaves running with their release owed (#16579), may stay running across a suspension, so that such Sessions can suspend too.
7. Suspending Sessions on a public Workspace Shell profile with MCP, whose plain detach requires a lifecycle authority today.
8. **Answered by the [bounded recovery addendum](2026-11-18-managed-suspension-bounded-recovery.md):** a capped uncertain teardown recovers automatically once both renewals are stopped and a wait exceeding the writer lease plus the Store request timeout has passed, with no schema or Store protocol change. The candidate constant still needs measurement before enablement, and the recovery/status proof remains a Phase 1 delivery gate.
9. Whether the cold-open limit needs per-tenant fairness. The ageing bound fails a starved Turn but does not stop one tenant's opens from crowding out another's.
