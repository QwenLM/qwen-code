# Mount release for recovery-blocked Hosted Workspace turns

[English](workspace-execution-mount-recovery-block-release.md) | [简体中文](workspace-execution-mount-recovery-block-release.zh-CN.md)

## Status and scope

Implemented and locally verified. This slice ends the cross-Session wedge of [#13800](https://github.com/QwenLM/qwen-code/issues/13800): a Hosted Workspace tool turn that goes recovery-blocked hands its Workspace execution mount back, so later tool turns of unrelated Sessions on the same `(tenantId, storageId)` proceed instead of parking forever on `409 workspace_busy`. Out of scope: A1 itself ([#13533](https://github.com/QwenLM/qwen-code/issues/13533), fix in flight as [#13789](https://github.com/QwenLM/qwen-code/pull/13789)), the Hook lane's shared acquisition and the MCP lane's session-scoped mount (own release disciplines), daemon-death residue (the LOST family's existing sweep, `#12670` family), and enabling `monitor_run` or the `child_run` `shell` kind.

## Problem and the named mechanism

A `recovery_blocked` Session wedged later turns of other Sessions on the same daemon: the journal stopped after `hostedModelAttempt` and before `commitMessage`, the model was never called again, no error, no terminal event. Runtime witnesses isolated the mechanism (`.qwen/issues/issue-13800.md` reproduction report):

1. Every Workspace tool turn's broker acquire passes `WorkspaceRuntimeTransport.acquire` → `WorkspaceExecutionStore.claim`, which manages one lease row per `(tenantId, storageId)` in `managed_workspace_execution_lease`; `holder_key` names the holding Runtime Session.
2. The lease is freed only by `finish()`'s full `release()` on the settled path. A turn that goes recovery-blocked (`uncertain` outcome, block-and-never-replay contract) throws `HostedToolRecoveryRequiredError` before any release — the lease is held forever by a turn that parks alive by contract.
3. Every later tool turn on the same storage spins on `409 workspace_busy` (`retryable: true`) with no error and no terminal event; without a prompt deadline (the default), the spin is unbounded. Deleting only the lease row live-unwedged a parked turn in under a second while the blocked Session stayed blocked — the coupling is exactly the lease row, scoped `(tenantId, storageId)`.

## Fix

The blocked turn hands back the mount — never the Runtime Session:

- New broker-internal `POST /tool-sessions/{runtimeSessionId}:release-mount`. `RuntimeBrokerService.releaseMount` resolves only the resident Session Context (a dead Daemon's residue belongs to the LOST family's sweep), checks the Harness identity, and refuses with `409 runtime_session_busy` while the Session has an active operation — every kind of unsettled row counts, background processes included, because the drain's exclusion exists only beside its stop-or-settle sweep, and this path runs no sweep. The gate reads the broker-registered state as of the check; it does not fence a concurrent out-of-contract admission landing one instant later. `RuntimeTransport.releaseMount` defaults fail-closed; only `WorkspaceRuntimeTransport` implements it: `WorkspaceExecutionStore.release` clears the holder columns. The Runtime Session row stays `READY`, never `RELEASED`, so the recovery fleet keeps its adoptable identity (`release` persists `RELEASED` forever and must not run here).
- Daemon side, `executeHostedTurn` catches the three recovery-required errors and calls the tool turn's new `releaseForRecoveryBlock()` before rethrowing; the block verdict itself is unchanged. `releaseForRecoveryBlock()` mirrors `finish()`'s lane condition — only the plain lane (`broker.acquire()`), not the Hook lane's shared acquisition or the MCP lane's session-scoped mount — and calls the new `HostedWorkspaceBroker.releaseMount()`. The handback runs without an acquired flag too: an acquire reply lost after the Broker committed the claim holds the mount exactly like a settled one, and the store's holder-conditioned clear is a no-op when nothing was granted. A failed handback is logged, never thrown — the block verdict must still reach the Session — and retries on a bounded cadence (twice) so a mount refused busy behind unsettled executions is freed once those rows settle; a Session whose work never settles keeps its freeze honestly.

A later full `release()` of a mount-free Session takes the transport's absent-holder shortcut: `RELEASING && !isHeld` already means "everything the mount fenced is over", which a mount release now makes true early. The worker-side detach the shortcut skips dies with the binding, and the row still settles `RELEASED` honestly.

## Alternatives considered

- Full `broker.release()` on the block transition: rejected — it persists `RELEASED` forever, and the wake aftermath / operator continuation re-acquires the same READY identity.
- Server-side lease TTL with heartbeat and steal-on-expiry: rejected for this issue — schema, renewal, and steal protocol machinery disproportionate to the named mechanism; the live Daemon can and should act at the transition it owns.
- Claim-time eviction keyed on journal `recovery_status`: insufficient — at this HEAD the recovery block settles Daemon-locally without persisting to the journal (a separate under-reporting finding), so such an eviction would not fire.
- Bounding the Daemon's `workspace_busy` retry alone: converts the wedge into a named failure but never lets a fresh turn complete against a leaked lease; kept as-is otherwise — the queue correctly waits behind genuinely live holders.

## Validation and acceptance

- Daemon unit witnesses (`packages/cli/src/serve/hosted-workspace-tool-turn.test.ts`): an acquired turn's handback calls `releaseMount` exactly once, never `release`; a rejected handback is logged, not thrown, and retries exactly twice more before staying owed; a busy-then-settling mount is handed back on the retry; an acquire whose reply was lost after the grant still runs the handback; Hook/MCP lanes hand nothing back.
- Route witness (`packages/cli/src/serve/hosted-harness-session.test.ts`): a prompt-driven tool turn that goes recovery-blocked through each of the Tool/MCP/Hook error families releases the mount exactly once and never sees the full release, with `recoveryBlocked` still reported.
- Broker service unit tests: resident mount release keeps `READY` and counts zero full releases; a crossed Harness answers `runtime_session_conflict`; a non-resident Session answers `runtime_reconciliation_required`; an unsettled execution, an in-flight control, and a settled execution whose background process still runs each answer `runtime_session_busy`; a transport without Workspace ownership answers 501 `workspace_mount_release_unsupported`.
- Real-stack IT (`HostedWorkspaceConcurrencyIT#mountReleaseFreesHeldStorageAndKeepsTheSessionReady`): rival acquire answers `workspace_busy` while held; the narrow release refuses `runtime_session_busy` with an unsettled execution and succeeds after settlement; the mount row's holder columns clear; the Runtime Session stays `READY`; the rival acquires; the holder's later full release completes.
- Physical rig re-run of the issue's reproduction: block mode settled the fresh turn in 2.6 s on its first acquire attempt while the blocker reported blocked exactly as before (`workspace_busy` count 0, down from 207 pre-fix); control mode unchanged; reverting only the `await toolTurn?.releaseForRecoveryBlock();` line restored the wedge with the pre-fix journal fingerprint (mechanism-restored witness — no `:release-mount` call, the mount wait logged), and restoring the line removed it again (rig evidence preserved under `.qwen/issues/13800-repro/`).

Restore the mechanism — removing that one line — and the witness suites plus the rig fail: the unit witnesses see no `releaseMount` call, the IT sees the lease holder pinned, and the rig wedges. Package build/typecheck/lint and the touched suites (`hosted-workspace-tool-turn`, `hosted-workspace-broker`, `hosted-harness-session`, runtime-broker, managed-agent-server, the mount-release IT) pass.
