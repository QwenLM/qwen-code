/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseMcpConfiguration } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-record.js';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import {
  dropPendingHostedFileHistoryTurn,
  readHostedFileHistory,
} from '../hosted-file-history.js';
import {
  hostedConfigScopedOwnerId,
  isHostedConfigScopedOwner,
} from '../hosted-hook-session.js';
import { isHostedDurableMcpOwner } from '../hosted-mcp-session.js';
import {
  hasBlockingHostedCleanupDebt,
  hasHostedCleanupDebt,
  type HostedCleanupResult,
  reconcileHostedTurnCleanup,
} from '../hosted-turn-cleanup.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
  HostedWorkspaceBrokerRejection,
} from '../hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from '../hosted-workspace-tool-turn.js';
import type { HostedSession } from './session-state.js';
import { unsettledPromptId } from './wake-recovery.js';

export function liftRecoveryBlock(session: HostedSession): void {
  session.blocked = false;
  session.recoveryReason = undefined;
  session.runtimeRecoveryPromptId = undefined;
  session.recoveryCancelPromptId = undefined;
  session.cleanupBlocked = false;
}

/**
 * Blocks a Session on recovery under the name of the failure blocking it
 * now — `namedStoreFailure`'s, or none — so a block never carries the
 * reason an earlier block left behind (#13800 R2-14).
 *
 * A stopped writer is the exception: its latch is never reset, so the name
 * recorded for that failure still describes the block when a later error
 * arrives unclassified. Only `liftRecoveryBlock` clears it.
 */
export function blockRecovery(
  session: HostedSession,
  storeFailure: string | undefined,
): void {
  session.blocked = true;
  session.runtimeRecoveryPromptId = undefined;
  session.recoveryReason =
    storeFailure ??
    (session.managed.authority.writesStopped
      ? session.recoveryReason
      : undefined);
}

/**
 * The owners this Session holds whose id the next load recomputes. A detach
 * must never terminally release one: a RELEASED row makes that id
 * unacquirable ever after (R13-1/R14-1/R28-1). Keyed on the owners the Harness
 * constructed, never on a held entry's shape — a channel `inputId` is
 * client-chosen and only length-bounded, so a turn can carry the same prefix
 * without being an owner, and that turn's Runtime is still owed a drain.
 *
 * Both durable families qualify: the config-scoped `extensions-components-*`
 * owner and the `mcp-<digest>` owner named after the durable configuration ids
 * (R2-7). The per-load `hooks-activation-*` owner is the one a successor never
 * recomputes, so it stays releasable (R14-1). Which object references the id
 * says nothing about this — the load hands MCP's broker to Hooks, so a shared
 * broker carrying a durable id must be exempt exactly as an owned one is.
 */
export function reloadStableOwnerIds(session: {
  hooks?: { broker: { runtimeSessionId: string } };
  mcp?: { broker: { runtimeSessionId: string } };
  configScopedOwnerIds?: readonly string[];
  durableMcpOwnerIds?: readonly string[];
}): Set<string> {
  return new Set(
    [
      session.hooks?.broker.runtimeSessionId,
      session.mcp?.broker.runtimeSessionId,
      ...(session.configScopedOwnerIds ?? []),
      ...(session.durableMcpOwnerIds ?? []),
    ].filter(
      (id): id is string =>
        id !== undefined &&
        (isHostedConfigScopedOwner(id) || isHostedDurableMcpOwner(id)),
    ),
  );
}

/**
 * The live objects alone are not enough: a passive load whose extension
 * bootstrap never completed sets `blocked` and continues without building a
 * Hooks or MCP session, while the restore still seeds the owner id from the
 * Broker's hold rows. The durable config_install chain names every revision
 * this Session has had, so its owner ids stay exempt on that resident too
 * (R5-1). Still ids the Harness derives, never a held entry's shape.
 */
export function sessionReloadStableOwnerIds(
  session: HostedSession,
): Set<string> {
  return reloadStableOwnerIds({
    hooks: session.hooks,
    mcp: session.mcp,
    configScopedOwnerIds: (session.extensions?.configRevisions ?? []).map(
      (revision) =>
        hostedConfigScopedOwnerId(
          session.managed.authority.sessionHeader.sessionKey,
          revision,
        ),
    ),
    // The mcp-<digest> family needs the same durable source, or an apply that
    // drops both the MCP servers and the Hook catalog leaves an owner the
    // restore still seeds but this set no longer knows — and a detach would
    // tombstone it (R8-2). These are the very rows the MCP constructor picks
    // its owner from, so the ids are byte-identical to the ones a reload
    // acquires; a released row is one no successor recomputes.
    durableMcpOwnerIds: session.managed.authority
      .extensionRecordsInDomain('mcp_configuration')
      .map((entry) => parseMcpConfiguration(entry.record))
      .filter((entry) => entry.releaseState !== 'released')
      .map((entry) => entry.runtimeSessionId),
  });
}

/**
 * Retires a settled Turn's owed file-history marker ahead of the exits that
 * clean up its recovered lease. The lease's cleanup obligation refuses to
 * release while the marker still names its Turn (#13188), so a close that
 * released first returned 204 with the lease never handed back, and a
 * lifecycle answered recovery-required on every retry with nothing left to
 * retire the marker. Callers hold the closing gate, so the drop cannot race
 * a fresh Turn's own marker. A failure stays owed, in memory and durably:
 * the caller's retry, or the next load, retires it.
 */
export async function retireOwedFileHistory(
  session: HostedSession,
  where: string,
): Promise<void> {
  const owed = session.fileHistoryOwed;
  if (owed === undefined) return;
  try {
    await dropPendingHostedFileHistoryTurn(session.managed, owed);
    if (session.fileHistoryOwed === owed) session.fileHistoryOwed = undefined;
  } catch (cause) {
    writeStderrLineSafe(
      `qwen serve: Hosted Harness file-history retirement of settled Turn ${owed} failed ${where}: ${String(cause)}`,
    );
  }
}

export function retainHostedCleanupHolds(
  session: HostedSession,
  result: HostedCleanupResult | undefined,
): void {
  if (!result) return;
  session.cleanupHolds ??= new Map();
  for (const promptId of result.states.keys())
    session.cleanupHolds.delete(promptId);
  for (const [promptId, hold] of result.held) {
    session.cleanupHolds.set(promptId, hold);
    session.heldRuntimeTurns.add(hold.runtimeSessionId);
  }
}

export async function retryHostedCleanup(
  session: HostedSession,
  options: HostedWorkspaceBrokerOptions,
  drain = false,
  probeOnly = false,
  excludedPromptId?: string,
): Promise<void> {
  if (!drain && unsettledPromptId(session)) return;
  // A load can overlap the wake pump's retry. Re-read the debt with each
  // caller's authority after the previous attempt settles.
  const retry = (session.cleanupRetry ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (!drain && unsettledPromptId(session)) return;
      try {
        session.cleanupHolds?.clear();
        if (hasHostedCleanupDebt(session.managed)) {
          // Unsettled wake turns need their recovery pump to commit the terminal
          // record before reconciliation can release their Runtime.
          retainHostedCleanupHolds(
            session,
            await reconcileHostedTurnCleanup(
              session.managed,
              options,
              undefined,
              drain && !probeOnly,
              excludedPromptId,
            ),
          );
        }
        if (session.cleanupBlocked) liftRecoveryBlock(session);
        session.cleanupBlocked = false;
      } catch (cause) {
        if (!session.blocked) {
          session.cleanupBlocked = true;
          session.blocked = true;
          session.monitorWake?.kick();
        }
        throw cause;
      }
    });
  session.cleanupRetry = retry;
  try {
    await retry;
  } finally {
    if (session.cleanupRetry === retry) {
      session.cleanupRetry = undefined;
    }
  }
}

// A recovered Runtime Session the Broker already forgot is handed back
// by definition — treat its 404 as a completed release instead of
// retrying a doomed handback forever. Only the runtime_session_not_found
// code certifies that: a foreign-coded 404 (a gateway, route version skew,
// a Broker-side not-found) says nothing about the handback, so the lease
// stays owed and retried — the gate hosted-hook-session already follows.
export const releaseIsSatisfied = (cause: unknown): boolean =>
  cause instanceof HostedWorkspaceBrokerRejection &&
  cause.status === 404 &&
  cause.code === 'runtime_session_not_found';

export type HostedRuntimeOwnership = ReturnType<
  typeof createHostedRuntimeOwnership
>;

export function createHostedRuntimeOwnership(
  brokerOptions: HostedWorkspaceBrokerOptions | undefined,
) {
  // A takeover adoption owed on a Session closed before ever registering
  // can never be handed back by a route — every discharger resolves the
  // Session through this map. Record the stranded identity so it is neither
  // silent nor wedged by a release; the next successful load of the id
  // drains the record.
  const refusedAdoptions = new Map<string, string>();
  const noteOwedAdoption = (
    session: HostedSession,
    sessionId: string,
  ): void => {
    const lease = session.runtimeLeaseHeld;
    if (lease === undefined || refusedAdoptions.has(sessionId)) return;
    const { runtimeSessionId } = lease;
    refusedAdoptions.set(sessionId, runtimeSessionId);
    writeStderrLineSafe(
      `qwen serve: Hosted Harness takeover of session ${sessionId} adopted Runtime Session ${runtimeSessionId} but refuses the load: the lease stays owed until this session loads successfully or retires.`,
    );
  };

  const releaseHeldRuntime = async (
    session: HostedSession,
    options: HostedWorkspaceBrokerOptions,
    lease: NonNullable<HostedSession['runtimeLeaseHeld']>,
    drain = false,
    terminal = false,
  ): Promise<'released' | 'held' | 'pending' | 'deferred'> => {
    const { promptId, runtimeSessionId } = lease;
    session.cleanupHolds?.delete(promptId);
    const result = await reconcileHostedTurnCleanup(
      session.managed,
      options,
      promptId,
      drain,
    );
    retainHostedCleanupHolds(session, result);
    if (result.held.has(promptId)) return 'held';
    if (result.states.get(promptId) === 'owed') return 'pending';
    // A lease is a Turn's obligation; a reload-stable owner outlives the Turn.
    // Releasing it here persists RELEASED under the id the next load
    // recomputes — the tombstone the held-Runtime drains also refuse (R3-1).
    // Only a Session that survives needs that protection. A delete has no
    // next load, and the blocked resident R5-1 exempts builds no live owner
    // object, so the close this used to defer to does not exist there:
    // declining a terminal handback left the owner released by nobody (R6-1).
    // The delete's drain and owner close already release the same id twice
    // when both reach it, so handing it back here is the established shape.
    const deferred =
      !terminal && sessionReloadStableOwnerIds(session).has(runtimeSessionId);
    // The lease carrier reaches this decision without passing either drain,
    // so it names the id itself — otherwise the half of the invariant that
    // leaves an owner READY is the half missing from the log (R4-1). Not
    // "detach": a settled prompt and a recovery recheck hand back here too.
    // A terminal handback is never deferred, so this only names a real park
    // — never a leak the route already discharged (R4-1 follow-up).
    if (deferred)
      writeStderrLineSafe(
        `qwen serve: Hosted Harness keeps reload-stable owner ${runtimeSessionId} running: release deferred, obligation still owed (#16579).`,
      );
    if (
      !deferred &&
      (runtimeSessionId !== hostedRuntimeSessionId(promptId) ||
        !result.states.has(promptId))
    ) {
      try {
        await new HostedWorkspaceBroker(
          options,
          session.managed.authority.sessionHeader.sessionKey,
          runtimeSessionId,
        ).release(drain ? { drain: true } : undefined);
      } catch (cause) {
        if (
          !(cause instanceof HostedWorkspaceBrokerRejection) ||
          cause.status !== 404 ||
          cause.code !== 'runtime_session_not_found'
        )
          throw cause;
      }
    }
    if (!hasHostedCleanupDebt(session.managed))
      await retryHostedCleanup(session, options);
    return deferred ? 'deferred' : 'released';
  };

  // A recovery load may hold the Runtime Session. On the cancellation
  // path, terminal routes hand it back — or the workspace lease stays
  // pinned forever — but retry-inviting refusals must not (see the field
  // doc): a release persists RELEASED. The continuation route keeps its
  // #13083 handback discipline (recorded follow-up). The flag clears only
  // once the release is confirmed, so a failed handback stays owed and the
  // next terminal route retries it.
  const releaseRecoveredRuntime = (session: HostedSession): void => {
    const lease = session.runtimeLeaseHeld;
    if (lease === undefined || !brokerOptions) return;
    // MCP configurations own their Runtime until their own drain completes.
    if (
      lease.runtimeSessionId !== hostedRuntimeSessionId(lease.promptId) &&
      (session.mcp || unsettledPromptId(session) === lease.promptId)
    )
      return;
    void releaseHeldRuntime(session, brokerOptions, lease).then(
      (outcome) => {
        if (outcome !== 'pending' && session.runtimeLeaseHeld === lease) {
          session.runtimeLeaseHeld = undefined;
          session.runtimeLeaseOwedByTerminalRoute = false;
        }
      },
      (cause: unknown) => {
        // A handback that was attempted and failed is owed by the route
        // that attempted it: the next settled /prompt retries it. A
        // re-adoption landing while the release was in flight re-recorded
        // the lease under a fresh identity, so this stale continuation
        // must not arm the owed flag against it.
        if (session.runtimeLeaseHeld === lease)
          session.runtimeLeaseOwedByTerminalRoute = true;
        writeStderrLineSafe(
          `qwen serve: Hosted Harness release of recovered Runtime ${lease.runtimeSessionId} failed: ${String(cause)}`,
        );
      },
    );
  };

  // Awaited variant for exits after which no route can retry the handback
  // (session close/detach). Retry-inviting refusals must not call it: see
  // the owed-lease comment at the blocked cancel refusal. The close drains:
  // a recovered Runtime can hold live background runs (#13856), and only
  // the drain arm may stop them. This exit swallows a refused release, so
  // the owed file-history retirement must go first. Answers whether it left a
  // reload-stable owner running, which a non-terminal close must report as an
  // unproven stop rather than certify (R3-1). The suspension teardown passes
  // rethrowOnFailure: it seals and drops the resident, so a swallowed refusal
  // would certify a release nobody proved and delete the only record of the
  // debt with the resident.
  const releaseLeaseNow = async (
    session: HostedSession,
    terminal: boolean,
    rethrowOnFailure = false,
    probeOnly = false,
    retainPromptId?: string,
  ): Promise<boolean> => {
    await retireOwedFileHistory(session, 'at close');
    const lease = session.runtimeLeaseHeld;
    if (
      lease === undefined ||
      !brokerOptions ||
      lease.promptId === retainPromptId
    )
      return false;
    if (
      session.mcp &&
      lease.runtimeSessionId !== hostedRuntimeSessionId(lease.promptId)
    )
      return false;
    let unproven = false;
    await releaseHeldRuntime(
      session,
      { ...brokerOptions, lifecycleAuthority: () => session.lifecycle },
      lease,
      !probeOnly,
      terminal,
    ).then(
      (outcome) => {
        // A suspension release stops nothing (§4.9): the Broker confirmed
        // this hold is a background execution of the current binding and
        // generation, so 'held' is its success. Foreground debt still fails.
        if (
          outcome !== 'released' &&
          outcome !== 'deferred' &&
          !(probeOnly && outcome === 'held')
        )
          throw new Error('Original Runtime cleanup is still owed.');
        // Only a non-terminal handback can defer, so a deferral here always
        // means the owner really was left running. A certified background
        // hold is proven by the Broker's own answer, not left unproven.
        unproven = outcome === 'deferred';
        if (session.runtimeLeaseHeld === lease) {
          session.runtimeLeaseHeld = undefined;
          session.runtimeLeaseOwedByTerminalRoute = false;
        }
      },
      (cause: unknown) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness release of recovered Runtime ${lease.runtimeSessionId} failed: ${String(cause)}`,
        );
        if (rethrowOnFailure) throw cause;
      },
    );
    return unproven;
  };

  // A delete must release every reload-stable owner no live object will
  // release. HostedHookSession.close() sweeps the earlier ones, so an apply
  // that moves to a bundle with no Hook catalog — drain nils the session and
  // enable does not rebuild it — leaves nothing to run that sweep, and the
  // delete answers 204 having released nothing (R7-1). Reachable without any
  // recovery: install hooks, fire one, then apply a hook-free revision.
  const releaseOrphanedConfigOwners = async (
    session: HostedSession,
  ): Promise<boolean> => {
    if (!brokerOptions) return false;
    let unproven = false;
    const sessionKey = session.managed.authority.sessionHeader.sessionKey;
    // The very set the exemption uses, so the two sides cannot drift one
    // owner family at a time (R9-1). Only a live broker id is skipped: that
    // one has a close of its own. Everything else is swept even when a Hooks
    // session exists — an owner `configure()` acquired but no Hook ever ran
    // has no `hook_execution` record, so `releaseEarlierOwners` cannot name
    // it (R8-1), and a delegated Hooks session sweeps nothing at all (R9-2).
    // The redundant release of an owner Hooks did sweep is absorbed below.
    const live = new Set(
      [
        session.hooks?.broker.runtimeSessionId,
        session.mcp?.broker.runtimeSessionId,
      ].filter((id): id is string => id !== undefined),
    );
    for (const id of sessionReloadStableOwnerIds(session)) {
      if (live.has(id)) continue;
      try {
        await new HostedWorkspaceBroker(brokerOptions, sessionKey, id).release({
          drain: true,
        });
      } catch (cause) {
        // Exactly what both held-Runtime drains tolerate (R25-1/R17-1): a 404
        // means nothing remains to stop, and a Broker restarted beside the
        // Harness holds no resident Session and answers 503 — the Workspace
        // cascade owns that Runtime. Rethrowing the 503 wedged the Session
        // undeletable, because the state it answers from never changes.
        // A hold fence is deliberately NOT absorbed: `HostedHookSession.close`
        // names a remaining fence rather than answering 204, for the same
        // reason — a delete that succeeded here would drop the only state
        // that can retry the release.
        if (
          !(cause instanceof HostedWorkspaceBrokerRejection) ||
          !(
            (cause.status === 404 &&
              cause.code === 'runtime_session_not_found') ||
            (cause.status === 503 &&
              cause.code === 'runtime_reconciliation_required')
          )
        )
          throw cause;
        // Tolerating the 503 is only half of what the drains do: the stop it
        // could not prove must not settle as stop_requested (R8-1).
        if (cause.status === 503) {
          unproven = true;
          writeStderrLineSafe(
            `qwen serve: Hosted Harness delete could not prove config-scoped owner ${id} stopped: the Broker requires reconciliation, the Workspace cascade owns it.`,
          );
        }
      }
    }
    return unproven;
  };

  const cleanupOriginalRecovery = async (
    session: HostedSession,
    promptId: string,
  ): Promise<void> => {
    const history = await readHostedFileHistory(session.managed);
    if (
      history?.pendingUndo ||
      (history?.pendingTurn && history.pendingTurn !== promptId)
    )
      throw new Error('Original file history cleanup cannot be verified.');
    await dropPendingHostedFileHistoryTurn(session.managed, promptId);
    if (session.fileHistoryOwed === promptId)
      session.fileHistoryOwed = undefined;
    if (brokerOptions) {
      session.cleanupHolds?.delete(promptId);
      retainHostedCleanupHolds(
        session,
        await reconcileHostedTurnCleanup(
          session.managed,
          brokerOptions,
          promptId,
        ),
      );
      const lease = session.runtimeLeaseHeld;
      if (
        lease?.promptId === promptId &&
        session.runtimeLeaseOwedByTerminalRoute &&
        (await releaseHeldRuntime(session, brokerOptions, lease)) !==
          'pending' &&
        session.runtimeLeaseHeld === lease
      ) {
        session.runtimeLeaseHeld = undefined;
        session.runtimeLeaseOwedByTerminalRoute = false;
      }
    }
    if (
      session.cleanupBlocked &&
      session.managed.authority
        .eventsInSequenceRange(1, session.managed.authority.committedSequence)
        .findLast((event) => event.kind === 'input.accepted')?.payload[
        'turnId'
      ] === promptId &&
      !(await hasBlockingHostedCleanupDebt(
        session.managed,
        session.cleanupHolds,
      )) &&
      !session.fileHistoryOwed &&
      !session.runtimeLeaseOwedByTerminalRoute
    )
      liftRecoveryBlock(session);
  };
  return {
    refusedAdoptions,
    noteOwedAdoption,
    releaseHeldRuntime,
    releaseRecoveredRuntime,
    releaseLeaseNow,
    releaseOrphanedConfigOwners,
    cleanupOriginalRecovery,
  };
}
