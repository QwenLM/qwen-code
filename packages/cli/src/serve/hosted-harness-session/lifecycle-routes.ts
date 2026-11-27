/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  type ManagedSessionLifecycleAuthority,
  ManagedSessionStoreHttpError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { AUTOMATION_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { CHANNEL_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { PR_EVENT_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-pr-watch-operations.js';
import {
  ManagedSessionConflictError,
  ManagedSessionTitleSupersededError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { CHILD_NOTIFICATION_SOURCES } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { Application, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  sanitizeDaemonLogLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import { readHostedAgentInstructions } from '../hosted-agent-definition.js';
import {
  HostedCompressionRefusal,
  HostedContextCompression,
} from '../hosted-context-compression.js';
import {
  assertHostedFileHistoryCapacity,
  commitHostedFileHistory,
  HOSTED_UUID,
  HostedFileHistoryRefusedError,
  readHostedFileHistory,
} from '../hosted-file-history.js';
import type { HostedHarnessContract } from '../hosted-harness-contract.js';
import { runHostedHookOperation } from '../hosted-hook-model.js';
import {
  hostedHookOccurrenceId,
  HostedHookRecoveryRequiredError,
} from '../hosted-hook-session.js';
import { LOOP_INPUT_SOURCE } from '../hosted-loop-session.js';
import { HOSTED_MCP_PROFILE } from '../hosted-mcp-session.js';
import { parseHostedModelSelection } from '../hosted-model-selection.js';
import { settlePendingMonitorInputs } from '../hosted-monitor-wake.js';
import { SESSION_MESSAGE_INPUT_SOURCE } from '../hosted-session-message-session.js';
import { recordSuspensionActivity } from '../hosted-session-suspension.js';
import {
  hasBlockingHostedCleanupDebt,
  hasHostedCleanupDebt,
} from '../hosted-turn-cleanup.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
  HostedWorkspaceBrokerRejection,
  isHostedFileHistoryRefusal,
} from '../hosted-workspace-broker.js';
import {
  isHostedWorkspaceExternalProfile,
  isHostedWorkspacePublicShellProfile,
} from '../hosted-workspace-profiles.js';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  hostedRuntimeSessionId,
  isRetryableWorkspaceAcquisition,
  touchesWorkspaceContext,
} from '../hosted-workspace-tool-turn.js';
import {
  type HostedRuntimeOwnership,
  retireOwedFileHistory,
  retryHostedCleanup,
  sessionReloadStableOwnerIds,
} from './runtime-ownership.js';
import {
  error,
  hostedTurnBusyReason,
  identity,
  lifecycleAuthority,
  object,
  ordinaryAuthorizationError,
  record,
} from './session-http.js';
import type { HostedSession } from './session-state.js';
import type { HostedSessionSuspension } from './session-suspension.js';
import { unsettledPromptId } from './wake-recovery.js';

export function compressionFor(
  session: HostedSession,
): HostedContextCompression {
  return (session.compression ??= new HostedContextCompression({
    session: session.managed,
    cwd: session.cwd,
    agentDefinition: session.agentDefinition,
    modelConfig: session.modelConfig,
    instructions: async () =>
      [
        await readHostedAgentInstructions(
          session.agentDefinition,
          session.managed.resources,
        ),
        session.skills?.instructions(),
        session.workspaceContext,
      ]
        .filter(Boolean)
        .join('\n\n'),
    busy: () => {
      const pending = new Set<string>();
      const now = Date.now();
      for (const event of session.managed.authority.eventsInSequenceRange(
        1,
        session.managed.authority.committedSequence,
      )) {
        if (event.kind === 'input.accepted') {
          // A not-yet-due loop wakeup is parked, not busy. Mirror the
          // authority's compaction carve-out exactly, or the host would
          // refuse a compaction the authority is prepared to admit.
          const notBefore = event.payload['notBefore'];
          if (
            event.payload['source'] === LOOP_INPUT_SOURCE &&
            typeof notBefore === 'number' &&
            notBefore > now
          )
            continue;
          pending.add(event.payload['turnId'] as string);
        }
        if (event.kind === 'turn.settled')
          pending.delete(event.payload['turnId'] as string);
      }
      return !!(
        session.active ||
        session.recoveredTurn ||
        session.blocked ||
        pending.size ||
        session.mcpClosing ||
        session.mcpBusy ||
        session.mcpRecovering ||
        session.hooksBusy ||
        session.mcp?.hasPendingOperations() ||
        session.hooks?.hasPendingOperations ||
        session.managed.authority.currentActivation?.phase !== 'active'
      );
    },
    hasPendingHooks: () => !!session.hooks?.hasPendingOperations,
    ...(session.hooks
      ? {
          fireHook: (event, operationId, fields) =>
            runHostedLifecycleHook(session, event, operationId, { ...fields }),
        }
      : {}),
    onCompactionCommitted: () => session.loops?.resetResolverCache(),
  }));
}

// Turn completion is activity: a Session that just settled a Turn earns a
// full residency period before idle suspension may consider it. Top-level
// so every driver's settle site can call it with the session alone.
export function noteSessionActivity(session: HostedSession): void {
  const suspension = session.suspension;
  if (!suspension || suspension.gate !== 'open') return;
  recordSuspensionActivity(suspension, Date.now());
  suspension.rearm?.();
}

export function compressionBusy(session: HostedSession): boolean {
  return (
    !!session.compression?.busy ||
    !!session.managed.authority.activeHistoryMaintenance
  );
}

export async function runHostedLifecycleHook(
  session: HostedSession,
  event: HookEventName,
  operationId: string,
  fields: Record<string, unknown>,
  kind?: 'legacy-close',
): Promise<unknown> {
  if (!session.hooks) return undefined;
  await session.hooks.ensureReady();
  const signal = new AbortController().signal;
  const controller = new ManagedHookActivationController(session.managed);
  return controller.runHookOperation(
    {
      operationId,
      occurrenceId: hostedHookOccurrenceId(event, operationId),
      originTurnId: null,
    },
    async (scope) => {
      const run = (
        runner?: import('../hosted-hook-session.js').HostedPromptHookRunner,
      ) => session.hooks!.fire(event, operationId, fields, signal, runner);
      if (!(await session.hooks!.needsPromptRunner(event, operationId)))
        return run();
      return runHostedHookOperation(
        {
          sessionId:
            session.managed.authority.sessionHeader.sessionKey.sessionId,
          cwd: session.cwd,
          signal,
          scope,
          modelConfig: session.modelConfig
            ? () => session.modelConfig!(kind)
            : undefined,
        },
        run,
      );
    },
  );
}

export function registerHostedLifecycleRoutes({
  app,
  sessions,
  contract,
  brokerOptions,
  releaseOrphanedConfigOwners,
  releaseLeaseNow,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  contract: HostedHarnessContract;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  releaseOrphanedConfigOwners: HostedRuntimeOwnership['releaseOrphanedConfigOwners'];
  releaseLeaseNow: HostedRuntimeOwnership['releaseLeaseNow'];
}): void {
  app.post('/session/:id/context/compress', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const body = object(req.body);
    if (!session.toolProfile || (session.childDepth ?? 0) !== 0)
      return error(res, 409, 'unsupported_feature');
    const operationId = body?.['operationId'];
    const expectedCompactionRevision = body?.['expectedCompactionRevision'];
    if (
      typeof operationId !== 'string' ||
      !operationId ||
      operationId.length > 128 ||
      !Number.isSafeInteger(expectedCompactionRevision) ||
      (expectedCompactionRevision as number) < 0 ||
      Object.keys(body!).some(
        (key) =>
          ![
            'operationId',
            'expectedCompactionRevision',
            'modelSelection',
          ].includes(key),
      )
    )
      return error(res, 400, 'invalid_context_compression');
    try {
      const modelSelection = parseHostedModelSelection(
        body?.['modelSelection'],
      );
      const status = await compressionFor(session).admit({
        operationId,
        expectedCompactionRevision: expectedCompactionRevision as number,
        ...(modelSelection ? { modelSelection } : {}),
      });
      res.status(202).json(status);
    } catch (cause) {
      if (cause instanceof HostedCompressionRefusal)
        return error(res, 409, cause.code);
      if (cause instanceof ManagedSessionConflictError)
        return error(res, 409, 'session_context_busy');
      writeStderrLineSafe(
        `qwen serve: Hosted context compression admission failed: ${String(cause)}`,
      );
      return error(res, 503, 'context_compression_unavailable');
    }
  });

  app.get('/session/:id/context/compressions/:operationId', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const compression = compressionFor(session);
    const status = compression.status(req.params['operationId']!);
    if (!status) return error(res, 404, 'operation_not_found');
    compression.resume();
    res.json(status);
  });

  app.post('/session/:id/lifecycle', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const body = object(req.body);
    let authority: ManagedSessionLifecycleAuthority | undefined;
    try {
      authority = lifecycleAuthority(body?.['authority']);
    } catch {
      return error(res, 400, 'invalid_hosted_lifecycle_authority');
    }
    const kind = body?.['kind'];
    const protocolVersion =
      body?.['protocolVersion'] === undefined ? 1 : body['protocolVersion'];
    const phase = protocolVersion === 1 ? 'effects' : body?.['phase'];
    const v2 =
      protocolVersion === 2 &&
      typeof session.toolProfile === 'string' &&
      contract.lifecycleV2Profiles?.includes(session.toolProfile) &&
      body?.['toolProfile'] === session.toolProfile;
    if (
      !authority ||
      (protocolVersion !== 1 && !v2) ||
      !['effects', 'prepare_resources', 'settle_resources'].includes(
        String(phase),
      ) ||
      (kind !== 'close' && kind !== 'delete') ||
      !isDeepStrictEqual(
        body?.['sessionKey'],
        session.managed.authority.sessionHeader.sessionKey,
      ) ||
      (protocolVersion === 1 &&
        session.toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
        !(
          isHostedWorkspaceExternalProfile(session.toolProfile) &&
          contract.lifecycleProtocolVersion === 1 &&
          contract.features?.includes(session.toolProfile as string)
        ))
    )
      return error(res, 400, 'invalid_hosted_lifecycle_request');
    if (
      session.lifecycle &&
      (session.lifecycle.operationId !== authority.operationId ||
        (session.lifecycleKind && session.lifecycleKind !== kind))
    )
      return error(res, 409, 'hosted_lifecycle_operation_conflict');
    if (
      session.active ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.hooksBusy
    )
      return error(res, 409, 'hosted_turn_active');
    if (hasHostedCleanupDebt(session.managed) && unsettledPromptId(session))
      return error(res, 503, 'hosted_lifecycle_recovery_required');
    const previousAuthority = session.lifecycle;
    session.stores!.setLifecycleAuthority(authority);
    session.hooksBusy = true;
    let authorized = false;
    try {
      if (phase !== 'effects') await session.stores!.assertWritable();
      await session.stores!.authorizeLifecycle(
        phase === 'effects' ? kind : undefined,
      );
      authorized = true;
      session.lifecycle = authority;
      session.lifecycleKind = kind;
      session.lifecycleProtocolVersion = protocolVersion as 1 | 2;
      session.mcpClosing = true;
      await retireOwedFileHistory(session, 'at lifecycle');
      if (phase === 'effects') {
        if (brokerOptions)
          await retryHostedCleanup(session, {
            ...brokerOptions,
            lifecycleAuthority: () => session.lifecycle,
          });
        if (
          await hasBlockingHostedCleanupDebt(
            session.managed,
            session.cleanupHolds,
          )
        )
          throw new Error('Runtime cleanup remains owed.');
      }
      session.monitorWake?.close();
      session.shell?.publisher?.prepareLifecycle();
      session.backgroundLane?.publisher?.prepareLifecycle();
      for (const loop of session.shell?.monitorLoops?.values() ?? [])
        loop.prepareLifecycle();
      for (const loop of session.backgroundLane?.monitorLoops?.values() ?? [])
        loop.prepareLifecycle();
      if (phase !== 'effects') {
        await Promise.all(session.messageOperations ?? []);
        await settlePendingMonitorInputs({
          authority: session.managed.authority,
          sink: session.managed.sink,
          sessionId: req.params['id'],
          cwd: session.cwd,
          sources: [
            ...(session.monitors ? ['monitor'] : []),
            ...(session.childAgents ? ['child_agent'] : []),
            ...(session.messages ? [SESSION_MESSAGE_INPUT_SOURCE] : []),
            ...(session.automations ? [AUTOMATION_INPUT_SOURCE] : []),
            ...(session.channels ? [CHANNEL_INPUT_SOURCE] : []),
            LOOP_INPUT_SOURCE,
            PR_EVENT_INPUT_SOURCE,
          ],
        });
        await session.automations?.reconcileRuns();
        if (phase === 'settle_resources') {
          // Stop what the turns still owe ahead of the owner close that asks
          // for the mount back (R22-1, the order the v1 close already keeps for
          // R14-2): a live background run keeps the release-mount guard
          // refusing runtime_session_busy, so a handback issued first parks the
          // detach on recovery-required for as long as the process lives. The
          // stops also land their finalize through the still-open publisher
          // closed below. Two drains because the debt is recorded in two places
          // — a descriptor here, a held Runtime below (R24-1).
          if (brokerOptions)
            await retryHostedCleanup(
              session,
              {
                ...brokerOptions,
                lifecycleAuthority: () => session.lifecycle,
              },
              true,
            );
          else if (hasHostedCleanupDebt(session.managed))
            throw new Error('Runtime cleanup remains owed after drain.');
          // Drain the Runtimes a turn left held, where the v1 close already
          // does, so a live background run stops before the handback asks for
          // the mount back (R24-1). Scope: this reaches the obligations a wake
          // turn's held aftermath and a cleanup hold register. A Hook-
          // configured turn registers NEITHER — it acquires through
          // hooks.acquire(), writes no cleanup descriptor, and finish() skips
          // the broker.release() whose 409 catch is the only assignment of
          // runtimeHeld — so for that shape this loop is empty and the close
          // still parks on recovery-required below. That gap is pinned by
          // 'never registers a held Runtime for a Hook-configured turn' and
          // needs a keep-READY drain to close: the release used here would
          // tombstone the deterministic Hook owner (R13-1/R14-1).
          let heldDrainUnproven = false;
          if (brokerOptions)
            for (const heldTurn of [...session.heldRuntimeTurns]) {
              // No reload-stable exemption here: both v2 lifecycle operations
              // end the Session (#16728/#16882), so nothing recomputes these
              // ids afterwards. The v1 detach below keeps the exemption,
              // because that is the route a reload can follow.
              try {
                await new HostedWorkspaceBroker(
                  brokerOptions,
                  session.managed.authority.sessionHeader.sessionKey,
                  hostedRuntimeSessionId(heldTurn),
                ).release({ drain: true });
                session.heldRuntimeTurns.delete(heldTurn);
              } catch (cause) {
                // Both tolerances the v1 drain carries (R25-1). A 404 means
                // nothing remains to stop. A Broker that restarted beside the
                // Harness holds no resident Session and answers the
                // declared-retryable 503; throwing there would skip the owner
                // close, the lease release, the loop stops and the publisher
                // closes on every attempt while the reload re-seeds the same
                // id, so the Session could never close. The Workspace cascade
                // owns that Runtime instead — but the stop stays unproven, so
                // the loops below must not settle it as confirmed.
                if (
                  cause instanceof HostedWorkspaceBrokerRejection &&
                  ((cause.status === 404 &&
                    cause.code === 'runtime_session_not_found') ||
                    (cause.status === 503 &&
                      cause.code === 'runtime_reconciliation_required'))
                ) {
                  session.heldRuntimeTurns.delete(heldTurn);
                  if (cause.status === 503) heldDrainUnproven = true;
                  continue;
                }
                // Any other refusal left the run unproven with no cascade to
                // hand it to. Park rather than hand the mount back over a
                // writer that may still live.
                throw cause;
              }
            }
          // Both public lifecycle operations end the Session (#16728/#16882):
          // nothing reopens a v2-closed Session, so the owner is released
          // terminally here. The v1 detach below still keeps its owner
          // re-acquirable — that is the route a reload can actually follow.
          await session.hooks?.close({ terminal: true });
          heldDrainUnproven =
            (await releaseOrphanedConfigOwners(session)) || heldDrainUnproven;
          heldDrainUnproven =
            (await releaseLeaseNow(session, true)) || heldDrainUnproven;
          // Neither an unprovable drain nor a Session whose own settlement
          // already failed proved to the Runtime that anything stopped, so
          // both settle on the runtime_lost line — the only state
          // rebuildFromRuntimeLost accepts (R25-1/R26-1, matching the v1
          // close). v2 has no heldDrainFailed: that arm throws above instead.
          const stopSettle =
            session.blocked || heldDrainUnproven
              ? 'runtime_lost'
              : 'stop_requested';
          for (const loop of session.shell?.monitorLoops?.values() ?? [])
            await loop.stop(stopSettle);
          for (const loop of session.backgroundLane?.monitorLoops?.values() ??
            [])
            await loop.stop(stopSettle);
          await session.shell?.publisher?.close();
          await session.backgroundLane?.publisher?.close();
          // Terminal on a close as on a delete; HostedMcpSession.closeResources
          // says why that is safe.
          await session.mcp?.closeResources({ terminal: true });
          await session.clientFiles?.close();
          session.clientFiles = undefined;
        }
        res.json({
          protocolVersion: 2,
          phase,
          toolProfile: session.toolProfile,
          sessionKey: session.managed.authority.sessionHeader.sessionKey,
          operationId: authority.operationId,
          kind,
        });
        return;
      }
      await session.mcp?.reconcileEffects();
      const events =
        kind === 'close'
          ? [HookEventName.SessionEnd]
          : [HookEventName.SessionEnd, HookEventName.SessionDelete];
      const occurrences = events.map((event) =>
        hostedHookOccurrenceId(event, authority.operationId),
      );
      await session.hooks?.drain(new Set(occurrences));
      const effects = [];
      if (session.hooks) {
        for (const event of events) {
          await runHostedLifecycleHook(
            session,
            event,
            authority.operationId,
            event === HookEventName.SessionEnd
              ? { reason: 'other' }
              : { deleted_session_id: req.params['id'] },
          );
          await session.hooks.settleOccurrence(
            hostedHookOccurrenceId(event, authority.operationId),
          );
          const entry = session.managed.authority.extensionRecord(
            'hook_execution',
            hostedHookOccurrenceId(event, authority.operationId),
          );
          if (!entry || !parseHookExecution(entry.record).resultRef)
            throw new HostedHookRecoveryRequiredError();
          effects.push({ event, recordRef: entry.recordRef });
        }
      }
      res.json({
        protocolVersion,
        ...(v2 ? { phase, toolProfile: session.toolProfile } : {}),
        sessionKey: session.managed.authority.sessionHeader.sessionKey,
        operationId: authority.operationId,
        kind,
        definitionRef: session.managed.authority.sessionHeader.definitionRef,
        effects,
      });
    } catch (cause) {
      writeStderrLineSafe(
        `qwen serve: Hosted lifecycle requires recovery: ${String(cause)}`,
      );
      const code =
        cause instanceof ManagedSessionStoreHttpError
          ? cause.remoteCode
          : cause instanceof HostedWorkspaceBrokerRejection
            ? String(cause.code)
            : '';
      if (
        v2 &&
        (code.startsWith('workspace_lifecycle_claim') ||
          code.startsWith('workspace_lifecycle_authorization') ||
          code === 'workspace_close_identity_unverified' ||
          code === 'workspace_close_execution_unsettled' ||
          code === 'runtime_admission_closed')
      ) {
        return error(res, 503, code);
      }
      error(
        res,
        503,
        phase === 'effects'
          ? 'hosted_lifecycle_recovery_required'
          : 'workspace_lifecycle_resources_unsettled',
      );
    } finally {
      if (!authorized) session.stores!.setLifecycleAuthority(previousAuthority);
      session.hooksBusy = false;
    }
  });
}

export function registerHostedFileAndTitleRoutes({
  app,
  sessions,
  brokerOptions,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
}): void {
  app.get('/session/:id/files/history', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.toolProfile || session.toolProfile === HOSTED_MCP_PROFILE)
      return error(res, 409, 'hosted_file_history_unavailable');
    void readHostedFileHistory(session.managed).then(
      (history) =>
        res.json({ sessionId: req.params['id'], history: history ?? null }),
      (cause: unknown) => {
        writeStderrLineSafe(
          `qwen serve: Hosted file history read failed: ${String(cause)}`,
        );
        error(res, 503, 'hosted_file_history_failed');
      },
    );
  });
  app.post('/session/:id/files/rewind', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (
      !session.toolProfile ||
      session.toolProfile === HOSTED_MCP_PROFILE ||
      isHostedWorkspaceExternalProfile(session.toolProfile) ||
      !brokerOptions
    )
      return error(res, 409, 'hosted_file_history_unavailable');
    if (session.mcpBusy || session.mcpClosing || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    // A route that borrows `active` as its busy flag must not be admitted
    // over an undriven recovered Turn, or it wedges the recovery it races.
    if (session.active || session.recoveredTurn !== undefined)
      return error(res, 409, 'hosted_turn_active');
    if (session.hooksBusy || session.hooks?.hasUnsettledExecutions)
      return error(res, 409, 'hosted_hook_operation_active');
    if (
      session.blocked ||
      session.hooks?.hasPendingOperations ||
      session.managed.authority.currentActivation?.phase !== 'active'
    )
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        hostedTurnBusyReason(session),
      );
    const body = object(req.body);
    const requestId = body?.['requestId'];
    const promptId = body?.['promptId'];
    if (
      typeof requestId !== 'string' ||
      !HOSTED_UUID.test(requestId) ||
      typeof promptId !== 'string' ||
      !HOSTED_UUID.test(promptId)
    )
      return error(res, 400, 'invalid_file_rewind');
    session.active = {
      promptId: requestId,
      digest: '',
      abort: new AbortController(),
    };
    void (async () => {
      const saved = await readHostedFileHistory(session.managed);
      if (
        !saved ||
        !saved.state.snapshots.some(
          (snapshot) => snapshot.promptId === promptId,
        )
      )
        return error(res, 404, 'hosted_file_snapshot_not_found');
      if (saved.pendingTurn || saved.pendingUndo)
        return error(
          res,
          409,
          'hosted_file_history_recovery_required',
          saved.pendingUndo ? 'undo_unsettled' : 'file_history_unsettled',
        );
      const priorUndo = saved.undoReceipts?.find(
        (receipt) => receipt.requestId === requestId,
      );
      if (priorUndo) {
        if (priorUndo.promptId !== promptId)
          return error(res, 409, 'hosted_file_rewind_conflict');
        return res.status(priorUndo.conflict ? 409 : 200).json(priorUndo);
      }
      const pending = { ...saved, pendingUndo: { requestId, promptId } };
      try {
        await assertHostedFileHistoryCapacity(session.managed, pending);
      } catch (cause) {
        if (!(cause instanceof HostedFileHistoryRefusedError)) throw cause;
        return error(res, 409, 'hosted_file_history_capacity_exceeded');
      }
      const broker =
        session.mcp?.broker ??
        session.hooks?.broker ??
        new HostedWorkspaceBroker(
          brokerOptions,
          session.managed.authority.sessionHeader.sessionKey,
          requestId,
        );
      try {
        await broker.warm();
        if (session.mcp) await session.mcp.acquireOwner();
        else if (session.hooks) await session.hooks.acquire();
        else await broker.acquire();
      } catch (cause) {
        if (isRetryableWorkspaceAcquisition(cause))
          return error(res, 409, cause.code);
        if (
          cause instanceof HostedWorkspaceBrokerRejection &&
          cause.status === 409 &&
          cause.code === 'runtime_session_not_acquirable'
        )
          return error(res, 409, 'runtime_session_not_acquirable');
        throw cause;
      }
      try {
        await broker.fileHistory({
          kind: 'raw-file-history',
          action: 'bind',
          state: saved.state,
        });
      } catch (cause) {
        if (!isHostedFileHistoryRefusal(cause)) throw cause;
        if (!session.hooks && !session.mcp) await broker.release();
        return error(res, 409, 'hosted_file_history_refused');
      }
      await commitHostedFileHistory(session.managed, pending);
      const result = await broker.fileHistory({
        kind: 'raw-file-history',
        action: 'rewind',
        promptId,
      });
      // The rewind already changed the files: a restored instruction file
      // makes the cached context stale (#13564).
      if (touchesWorkspaceContext(result.filesChanged))
        session.workspaceContext = undefined;
      if (result.filesFailed.length)
        throw new Error('Hosted file undo only partially completed.');
      const undo = {
        requestId,
        promptId,
        filesChanged: result.filesChanged,
        conflict: result.conflict,
      };
      await commitHostedFileHistory(session.managed, {
        schemaVersion: 1,
        state: result.state,
        pendingTurn: null,
        pendingUndo: { requestId, promptId },
        undoReceipts: [...(saved.undoReceipts ?? []), undo],
      });
      if (!session.hooks && !session.mcp) await broker.release();
      await commitHostedFileHistory(session.managed, {
        schemaVersion: 1,
        state: result.state,
        pendingTurn: null,
        pendingUndo: null,
        undoReceipts: [...(saved.undoReceipts ?? []), undo],
      });
      return res.status(result.conflict ? 409 : 200).json(undo);
    })()
      .catch((cause: unknown) => {
        session.blocked = true;
        writeStderrLineSafe(
          `qwen serve: Hosted file undo requires recovery: ${sanitizeDaemonLogLine(String(cause))}`,
        );
        error(
          res,
          503,
          'hosted_file_history_recovery_required',
          hostedTurnBusyReason(session),
        );
      })
      .finally(() => {
        session.active = undefined;
        noteSessionActivity(session);
      });
  });
  app.post('/session/:id/title', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const title = object(req.body)?.['title'];
    if (typeof title !== 'string' || !title.trim() || title.length > 256)
      return error(res, 400, 'invalid_session_title');
    const revision = object(req.body)?.['managedRenameRevision'];
    if (
      revision !== undefined &&
      (typeof revision !== 'string' ||
        !/^[1-9][0-9]{0,18}$/u.test(revision) ||
        BigInt(revision) > 9223372036854775807n)
    ) {
      error(res, 400, 'invalid_session_title_revision');
      return;
    }
    const write =
      revision === undefined
        ? session.managed.sink.write(
            record(session, req.params['id']!, 'system', null, {
              subtype: 'custom_title',
              systemPayload: { customTitle: title, titleSource: 'manual' },
            }),
          )
        : session.managed.authority.commitDomainRecord(
            {
              operation: 'renameSession',
              commandId: `hosted-title:${revision}`,
              sessionKey: session.managed.authority.sessionHeader.sessionKey,
              contentDigest: createHash('sha256').update(title).digest('hex'),
            },
            {
              domain: 'session_metadata',
              content: {
                title,
                titleSource: 'manual',
                managedRenameRevision: revision,
              },
            },
            { class: 'trusted_entry' },
          );
    void write.then(
      () =>
        res.json({
          sessionId: req.params['id'],
          persisted: true,
          ...(revision === undefined
            ? {}
            : { managedRenameRevision: revision }),
        }),
      (failure: unknown) =>
        error(
          res,
          failure instanceof ManagedSessionTitleSupersededError ||
            failure instanceof ManagedSessionConflictError
            ? 409
            : 503,
          failure instanceof ManagedSessionTitleSupersededError ||
            failure instanceof ManagedSessionConflictError
            ? 'session_mutation_superseded'
            : 'managed_session_title_failed',
        ),
    );
  });
}

export function registerHostedCloseRoutes({
  app,
  sessions,
  brokerOptions,
  releaseOrphanedConfigOwners,
  releaseLeaseNow,
  dropSuspension,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  releaseOrphanedConfigOwners: HostedRuntimeOwnership['releaseOrphanedConfigOwners'];
  releaseLeaseNow: HostedRuntimeOwnership['releaseLeaseNow'];
  dropSuspension: HostedSessionSuspension['dropSuspension'];
}): void {
  const close = async (
    req: Request,
    res: Response,
    allowMissingClientId = false,
  ): Promise<void> => {
    let authority: ManagedSessionLifecycleAuthority | undefined;
    try {
      authority = lifecycleAuthority(object(req.body)?.['authority']);
    } catch {
      return error(res, 400, 'invalid_hosted_lifecycle_authority');
    }
    const session = identity(
      req,
      sessions,
      allowMissingClientId || authority !== undefined,
    );
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (compressionBusy(session))
      return error(res, 409, 'session_context_busy');
    if (
      session.mcp &&
      isHostedWorkspacePublicShellProfile(session.toolProfile) &&
      session.lifecycleProtocolVersion !== 2
    )
      return error(res, 409, 'hosted_lifecycle_required');
    if (
      session.active ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.hooksBusy
    )
      return error(res, 409, 'hosted_turn_active');
    session.mcpBusy = true;
    session.mcpClosing = true;
    // The deregistration is keyed on the writer seal, not the close call:
    // once close() settled, or its seal landed before a rejection (R11-3),
    // the journal is durably closed and the entry is dead weight. A
    // rejection whose seal never ran — a pre-seal failure (R13-1) or a
    // pre-close hook/admission refusal — left the writer open, so the
    // Session stays for a retry.
    let closeSettled = false;
    try {
      if (session.lifecycle || authority) {
        if (req.method === 'DELETE')
          return error(res, 409, 'hosted_lifecycle_operation_active');
        if (
          !authority ||
          (session.lifecycle &&
            authority.operationId !== session.lifecycle.operationId)
        )
          return error(res, 409, 'hosted_lifecycle_operation_conflict');
        const previousAuthority = session.lifecycle;
        session.stores!.setLifecycleAuthority(authority);
        try {
          await session.stores!.authorizeLifecycle();
        } catch (cause) {
          session.stores!.setLifecycleAuthority(previousAuthority);
          throw cause;
        }
        session.lifecycle = authority;
      } else if (req.method === 'POST') {
        try {
          await session.stores!.authorizeOrdinary();
        } catch (cause) {
          return ordinaryAuthorizationError(res, cause);
        }
      }
      // A message operation admitted before the close began lands before
      // the pending inputs are cancelled below; a later one is refused.
      await Promise.all(session.messageOperations ?? []);
      if (req.method === 'DELETE' && session.hooks) {
        session.hooksBusy = true;
        try {
          await session.hooks.drain();
          await runHostedLifecycleHook(
            session,
            HookEventName.SessionEnd,
            `session-end:${req.params['id']}`,
            { reason: 'other' },
            'legacy-close',
          );
          await runHostedLifecycleHook(
            session,
            HookEventName.SessionDelete,
            `session-delete:${req.params['id']}`,
            { deleted_session_id: req.params['id'] },
            'legacy-close',
          );
        } finally {
          session.hooksBusy = false;
        }
      }
      if (session.lifecycleProtocolVersion !== 2) {
        // #13856: drain every Runtime a turn left held, ahead of the owner
        // close that asks for the mount back (R14-2) as well as the loop
        // stops and the publisher close. The drain's stops land their
        // finalize through the still-open publisher — the maintenance
        // answer rides the completion that carries the finalize — so the
        // records project the requested stop before anything else settles
        // them. A drain that cannot prove a stop fails the close honestly
        // below: the Session stays reopenable and nothing claims settled.
        let heldDrainFailed: unknown = null;
        // A drain the restarted Broker declared unprovable (503 below) is
        // tolerated so the close is not wedged, but it is not a proven stop
        // either — the loops below must still settle runtime_lost.
        let heldDrainUnproven = false;
        const reloadStableOwners = sessionReloadStableOwnerIds(session);
        if (brokerOptions) {
          for (const heldTurn of [...session.heldRuntimeTurns]) {
            // Same invariant as the v2 drain, and it predates it: the restore
            // seeds reload-stable owners from the Broker's hold rows, and a
            // detach must not tombstone an id the next load recomputes
            // (R13-1/R14-1/R28-1). A DELETE is terminal and may release.
            if (
              req.method !== 'DELETE' &&
              reloadStableOwners.has(hostedRuntimeSessionId(heldTurn))
            ) {
              // Unproven, not failed: a detach declines to certify the stop,
              // it must not turn the park into a close failure at the rethrow
              // below.
              heldDrainUnproven = true;
              writeStderrLineSafe(
                `qwen serve: Hosted Harness detach keeps reload-stable owner ${hostedRuntimeSessionId(heldTurn)} running: release deferred, obligation still owed (#16579).`,
              );
              continue;
            }
            try {
              await new HostedWorkspaceBroker(
                brokerOptions,
                session.managed.authority.sessionHeader.sessionKey,
                hostedRuntimeSessionId(heldTurn),
              ).release({ drain: true });
              session.heldRuntimeTurns.delete(heldTurn);
            } catch (cause) {
              // A "not found" answer means nothing remains to stop: the Runtime
              // is already gone, so the turn owes nothing and the close may
              // proceed — the same tolerance the sibling owner-release carries
              // (#13856 R1-1). Every other refusal is unproven and parks
              // honestly below.
              if (
                cause instanceof HostedWorkspaceBrokerRejection &&
                cause.status === 404 &&
                cause.code === 'runtime_session_not_found'
              ) {
                session.heldRuntimeTurns.delete(heldTurn);
                continue;
              }
              // A Broker that restarted beside the Harness no longer holds
              // the Session in memory and cannot prove its release: it
              // answers the declared-retryable 503
              // runtime_reconciliation_required, and the Workspace-level
              // cascade owns the Runtime from there. Tolerate the answer so
              // the close still retires the Session — otherwise every retry
              // re-seeds the same id and the Session can never close — while
              // the unproven drain keeps the loops off a stop_requested
              // settle (#13986 R2-1).
              if (
                cause instanceof HostedWorkspaceBrokerRejection &&
                cause.status === 503 &&
                cause.code === 'runtime_reconciliation_required'
              ) {
                session.heldRuntimeTurns.delete(heldTurn);
                heldDrainUnproven = true;
                writeStderrLineSafe(
                  `qwen serve: Hosted Harness drain of held Runtime ${heldTurn} deferred to the Workspace cascade: ${String(cause)}`,
                );
                continue;
              }
              heldDrainFailed ??= cause;
              writeStderrLineSafe(
                `qwen serve: Hosted Harness drain of held Runtime ${heldTurn} failed: ${String(cause)}`,
              );
            }
          }
        }
        // A DELETE is terminal; a detach keeps the Session reloadable, so the
        // deterministic config-scoped Hook owner must stay re-acquirable
        // (R13-1) instead of being tombstoned under the id a reload recomputes.
        // The held-Runtime drain above ran first so a turn's background run no
        // longer fences the non-terminal mount handback (R14-2).
        await session.hooks?.close({ terminal: req.method === 'DELETE' });
        if (req.method === 'DELETE')
          heldDrainUnproven =
            (await releaseOrphanedConfigOwners(session)) || heldDrainUnproven;
        // Deferred until the close is known terminal: a Hook fence refusal
        // above keeps the Session attached and retryable, and its wake pump
        // with it. wakeBusy() holds mcpClosing for the whole drain, so no
        // wake turn can start meanwhile; pending notifications settle below.
        session.monitorWake?.close();
        // A lease a recovery load acquired must go back with the Session, or
        // the Workspace stays pinned after every later route is gone. The
        // release retires a settled Turn's owed file-history marker first,
        // ahead of the unguarded loop stop below so that a throw there
        // cannot strand the retirement.
        heldDrainUnproven =
          (await releaseLeaseNow(session, req.method === 'DELETE')) ||
          heldDrainUnproven;
        // A registered observation loop outlives its turn: only the Session
        // close ends it. Stop every live loop here, ahead of the publisher
        // close and the log close, so its settle write can still reach the
        // journal. A Session whose own settlement already failed (blocked)
        // never proved to the Runtime that anything stopped: claiming
        // `stop_requested` there would display an unconfirmed task as
        // settled, so the record parks on the runtime_lost line instead —
        // the loop ends, and the record keeps an honest rebuild path. A
        // failed held-Runtime drain is the same unproven shape.
        const stopSettle =
          session.blocked || heldDrainFailed !== null || heldDrainUnproven
            ? 'runtime_lost'
            : 'stop_requested';
        for (const loop of session.shell?.monitorLoops?.values() ?? [])
          await loop.stop(stopSettle);
        for (const loop of session.backgroundLane?.monitorLoops?.values() ?? [])
          await loop.stop(stopSettle);
        if (heldDrainFailed !== null) throw heldDrainFailed;
        // Nonterminal owners keep their durable debt for replacement recovery.
        // Every terminal owner must complete the actual drain before closing.
        if (brokerOptions)
          await retryHostedCleanup(session, brokerOptions, true);
        else if (hasHostedCleanupDebt(session.managed))
          throw new Error('Runtime cleanup remains owed after drain.');
        // The drains above stopped the Session's background Shells and
        // watches, and their exits settled through this publisher; it
        // closes last.
        await session.shell?.publisher?.close();
        await session.backgroundLane?.publisher?.close();
        const mcpLease = session.runtimeLeaseHeld;
        // Only a DELETE is terminal; a detach keeps the owner re-acquirable
        // across the reload (R14-1), matching the Hook close above.
        await session.mcp?.close({ terminal: req.method === 'DELETE' });
        // The client files registration is ephemeral harness-local state; a
        // detach loses it across the reload, so the browser re-registers.
        await session.clientFiles?.close();
        session.clientFiles = undefined;
        if (
          session.mcp &&
          mcpLease !== undefined &&
          mcpLease.runtimeSessionId !==
            hostedRuntimeSessionId(mcpLease.promptId) &&
          session.runtimeLeaseHeld === mcpLease
        )
          session.runtimeLeaseHeld = undefined;
        // No monitor, channel or automation notification may park the
        // Session: every pending one settles cancelled here, model-free,
        // before the log closes; a run whose input settled that way ends
        // cancelled with an execution proven not to have started.
        if (
          session.monitors ||
          session.childAgents ||
          session.automations ||
          session.channels
        ) {
          await settlePendingMonitorInputs({
            authority: session.managed.authority,
            sink: session.managed.sink,
            sessionId: req.params['id'],
            cwd: session.cwd,
            sources: [
              ...(session.monitors ? ['monitor'] : []),
              // #13803: child notifications of either child Session kind.
              ...(session.childAgents ? [...CHILD_NOTIFICATION_SOURCES] : []),
              ...(session.messages ? [SESSION_MESSAGE_INPUT_SOURCE] : []),
              ...(session.automations ? [AUTOMATION_INPUT_SOURCE] : []),
              ...(session.channels ? [CHANNEL_INPUT_SOURCE] : []),
              LOOP_INPUT_SOURCE,
              PR_EVENT_INPUT_SOURCE,
            ],
          });
          // A refused settle revision never blocks the close: the next open
          // reconciles it again from the same committed facts.
          await session.automations
            ?.reconcileRuns()
            .catch((cause: unknown) =>
              writeStderrLineSafe(
                `qwen serve: Hosted automation runs of session ${req.params['id']} could not be settled on close: ${String(cause)}`,
              ),
            );
        }
      }
      await session.managed.close(
        session.lifecycle ? { releaseActivation: false } : undefined,
      );
      closeSettled = true;
      res.sendStatus(204);
    } catch (cause) {
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${req.params['id']} close failed: ${String(cause)}`,
      );
      // A Hook Session that owns its Runtime owner and still holds unfinished
      // work keeps the Session attached; name that rather than reporting a
      // generic close failure. A Hook Session sharing the MCP owner is released
      // by that session instead and still reports the generic code.
      if (cause instanceof HostedHookRecoveryRequiredError)
        error(res, 503, 'hosted_hook_recovery_required');
      else error(res, 503, 'managed_session_close_failed');
    } finally {
      // Deregister only once the writer is durably closed: close() settled,
      // or it rejected after the seal landed (R11-3) — every later journal
      // write fails, so the entry is dead weight. A rejection whose seal
      // never ran (a pre-seal failure, R13-1) or before close() ran (a hook
      // or admission refusal) left the writer open, so the Session stays
      // usable for a retry.
      if (closeSettled || session.managed.authority.writerSealed) {
        for (const stop of session.streams) stop();
        sessions.delete(req.params['id']);
        dropSuspension(req.params['id']);
      }
      session.mcpClosing = !!session.lifecycle;
      session.mcpBusy = false;
    }
  };

  app.post('/session/:id/detach', (req, res) => {
    void close(req, res);
  });
  app.delete('/session/:id', (req, res) => {
    void close(req, res, true);
  });
}
