/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostedHarnessReleaseReceipt } from '@qwen-code/qwen-code-core/managed-runtime/hosted-harness-release.js';
import type { Application } from 'express';
import { randomUUID } from 'node:crypto';
import type { HostedActionParkRefusal } from './hosted-action-parking.js';
import { HOSTED_UUID } from './hosted-file-history.js';
import type { HostedHarnessContract } from './hosted-harness-contract.js';
import { HostedHarnessInstance } from './hosted-harness-instance.js';
import { registerHostedAutomationRoutes } from './hosted-harness-session/automation-routes.js';
import {
  createHostedExtensionsManager,
  registerHostedConfigurationRoutes,
} from './hosted-harness-session/configuration-routes.js';
import { registerHostedInteractionRoutes } from './hosted-harness-session/interaction-routes.js';
import {
  registerHostedCloseRoutes,
  registerHostedFileAndTitleRoutes,
  registerHostedLifecycleRoutes,
} from './hosted-harness-session/lifecycle-routes.js';
import { registerHostedObservationRoutes } from './hosted-harness-session/observation-routes.js';
import { createHostedRuntimeOwnership } from './hosted-harness-session/runtime-ownership.js';
import {
  error,
  identity,
  object,
} from './hosted-harness-session/session-http.js';
import { registerHostedSessionOpenRoutes } from './hosted-harness-session/session-open.js';
import type {
  HostedHarnessSessionOptions,
  HostedSession,
  HostedSessionOpenings,
  HostedSuspensionStats,
} from './hosted-harness-session/session-state.js';
import {
  createHostedSessionSuspension,
  heldResources,
} from './hosted-harness-session/session-suspension.js';
import { registerHostedTakeoverRoutes } from './hosted-harness-session/takeover-routes.js';
import { registerHostedCancellationRoutes } from './hosted-harness-session/turn-cancellation.js';
import { registerHostedPromptRoute } from './hosted-harness-session/turn.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';

export { reloadStableOwnerIds } from './hosted-harness-session/runtime-ownership.js';
export { parseChannelSubmitInput } from './hosted-harness-session/interaction-routes.js';
export { readHostedClassifierUserText } from './hosted-harness-session/wake-recovery.js';
export { wakeDispatchOwnsInput } from './hosted-harness-session/wake-recovery.js';
export { settleCrashedWakeTurnAftermath } from './hosted-harness-session/wake-recovery.js';
export { parkNeedsNoRuntimeSettlement } from './hosted-harness-session/turn-cancellation.js';
export { settleCancelledHookTurn } from './hosted-harness-session/turn-cancellation.js';
export { attributeShellReceipts } from './hosted-harness-session/workspace-restore.js';

export function registerHostedHarnessSessionRoutes(
  app: Application,
  contract: HostedHarnessContract,
  cwd: string,
  brokerOptions?: HostedWorkspaceBrokerOptions,
  options?: HostedHarnessSessionOptions,
): {
  owns: (id: string) => boolean;
  accepting: () => boolean;
  beginOperation?: () => () => void;
  suspensionStats: () => HostedSuspensionStats;
} {
  // The owed mount handbacks of recovery-blocked turns (#13800) outlive
  // their Session, whose close never frees a parked turn's mount; the
  // daemon owns them and stops them at shutdown.
  let ownershipDrainTimer: ReturnType<typeof setInterval> | undefined;

  let ownershipDraining = false;

  let ownershipDrainStopped = false;

  const mountHandbacks = new Set<() => void>();

  (
    app.locals as { stopHostedMountHandbacks?: () => void }
  ).stopHostedMountHandbacks = () => {
    ownershipDrainStopped = true;
    if (ownershipDrainTimer) clearInterval(ownershipDrainTimer);
    for (const stop of [...mountHandbacks]) stop();
  };

  if (brokerOptions) brokerOptions = { ...brokerOptions, mountHandbacks };

  const sessions = new Map<string, HostedSession>();

  const suspensionStats = {
    cleanSuspensions: 0,
    revertedAttempts: 0,
    eligibilityFailures: 0,
    blockedTeardowns: 0,
    reconciledGates: 0,
    openBusyRefusals: 0,
    coldOpens: 0,
    coldOpenTotalMs: 0,
    coldOpenStoreMs: 0,
    mcpReadyMs: 0,
    parkRefusals: {} as Partial<Record<HostedActionParkRefusal, number>>,
  };

  const openings: HostedSessionOpenings = {
    inFlight: new Set(),
    unresolved: new Set(),
    reconciliations: 0,
  };

  const epoch = contract.bootId.replaceAll('-', '_');

  const released = new Map<
    string,
    { clientId: string; receipt: HostedHarnessReleaseReceipt }
  >();

  const instance =
    contract.instanceId === undefined
      ? undefined
      : new HostedHarnessInstance(
          { ...contract, instanceId: contract.instanceId },
          () => ({
            attachedSessions: sessions.size,
            activeTurns: [...sessions.values()].filter(
              (session) => session.active,
            ).length,
            openingSessions:
              openings.inFlight.size +
              openings.unresolved.size +
              openings.reconciliations,
            pendingInputs: [...sessions.values()].reduce(
              (sum, session) =>
                sum +
                pendingSessionInputs(
                  session.managed.authority.eventsInSequenceRange(
                    1,
                    session.managed.authority.committedSequence,
                  ),
                ).length,
              0,
            ),
            heldResources: [...sessions.values()].reduce(
              (sum, session) => sum + heldResources(session),
              mountHandbacks.size,
            ),
            pendingPublications: [...sessions.values()].filter(
              (session) =>
                session.shell?.publisher || session.backgroundLane?.publisher,
            ).length,
          }),
          () => startOwnershipDrain(),
          () => suspensionStats,
        );

  const acceptingWork = () => instance?.accepting !== false;

  const ownership = createHostedRuntimeOwnership(brokerOptions);
  const {
    releaseLeaseNow,
    releaseOrphanedConfigOwners,
    releaseRecoveredRuntime,
    cleanupOriginalRecovery,
  } = ownership;
  const suspension = createHostedSessionSuspension({
    sessions,
    openings,
    released,
    instance,
    options,
    brokerOptions,
    suspensionStats,
    releaseLeaseNow,
  });
  const { releaseIdleOwner, dropSuspension } = suspension;
  const extensionsManager = createHostedExtensionsManager(
    brokerOptions,
    contract,
  );

  if (instance) {
    instance.register(app);
    app.use('/session', instance.track);
    app.post('/session/:id/ownership:release', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const body = object(req.body);
      const operationId = body?.['operationId'];
      const placementEpoch = body?.['placementEpoch'];
      if (
        !body ||
        Object.keys(body).sort().join(',') !== 'operationId,placementEpoch' ||
        typeof operationId !== 'string' ||
        !HOSTED_UUID.test(operationId) ||
        !Number.isSafeInteger(placementEpoch) ||
        (placementEpoch as number) < 1
      )
        return error(res, 400, 'invalid_hosted_ownership_release');
      const previous = released.get(req.params['id']);
      if (
        previous &&
        previous.clientId === req.get('X-Qwen-Client-Id') &&
        previous.receipt.operationId === operationId &&
        previous.receipt.placementEpoch === placementEpoch
      )
        return res.json(previous.receipt);
      const session = identity(req, sessions);
      if (!session) return error(res, 404, 'hosted_session_not_found');
      if (
        instance.accepting ||
        session.placement?.placementEpoch !== placementEpoch
      )
        return error(res, 409, 'hosted_ownership_release_conflict');
      if (
        session.ownershipRelease &&
        session.ownershipRelease.operationId !== operationId
      )
        return error(res, 409, 'hosted_ownership_release_conflict');
      try {
        const receipt = await releaseIdleOwner(
          req.params['id'],
          session,
          operationId,
        );
        if (!receipt) return error(res, 409, 'hosted_ownership_release_busy');
        res.json(receipt);
      } catch {
        error(res, 503, 'hosted_ownership_release_unresolved');
      }
    });
  }

  function startOwnershipDrain(): void {
    if (ownershipDrainTimer || ownershipDrainStopped) return;
    const pass = async () => {
      if (ownershipDraining || ownershipDrainStopped) return;
      ownershipDraining = true;
      try {
        for (const [sessionId, session] of sessions) {
          try {
            await releaseIdleOwner(
              sessionId,
              session,
              session.ownershipRelease?.operationId ?? randomUUID(),
            );
          } catch {
            // Unknown work or a missing Store keeps this owner attached.
          }
        }
        if (instance?.snapshot().state === 'DRAINED' && ownershipDrainTimer) {
          clearInterval(ownershipDrainTimer);
          ownershipDrainTimer = undefined;
        }
      } finally {
        ownershipDraining = false;
      }
    };
    ownershipDrainTimer = setInterval(() => {
      void pass();
    }, 500);
    ownershipDrainTimer.unref();
    void pass();
  }

  registerHostedSessionOpenRoutes({
    app,
    sessions,
    openings,
    contract,
    cwd,
    brokerOptions,
    instance,
    options,
    epoch,
    acceptingWork,
    suspensionStats,
    suspension,
    ownership,
    extensionsManager,
  });
  registerHostedLifecycleRoutes({
    app,
    sessions,
    contract,
    brokerOptions,
    releaseOrphanedConfigOwners,
    releaseLeaseNow,
  });
  registerHostedPromptRoute({
    app,
    sessions,
    epoch,
    instance,
    brokerOptions,
    suspensionStats,
    cwd,
    releaseRecoveredRuntime,
  });
  registerHostedConfigurationRoutes({
    app,
    sessions,
    brokerOptions,
    contract,
    extensionsManager,
  });
  registerHostedInteractionRoutes(app, sessions);
  registerHostedTakeoverRoutes({
    app,
    sessions,
    epoch,
    cwd,
    brokerOptions,
    releaseRecoveredRuntime,
  });
  registerHostedObservationRoutes({
    app,
    sessions,
    epoch,
    options,
    cleanupOriginalRecovery,
  });
  registerHostedCancellationRoutes(app, sessions);
  registerHostedFileAndTitleRoutes({ app, sessions, brokerOptions });
  registerHostedAutomationRoutes(app, sessions);
  registerHostedCloseRoutes({
    app,
    sessions,
    brokerOptions,
    releaseOrphanedConfigOwners,
    releaseLeaseNow,
    dropSuspension,
  });

  return {
    accepting: acceptingWork,
    beginOperation: instance?.beginOperation,
    owns: (id) =>
      [...sessions.keys(), ...openings.inFlight].some(
        (candidate) => candidate.toLowerCase() === id.toLowerCase(),
      ),
    suspensionStats: () => ({
      ...suspensionStats,
      parkRefusals: { ...suspensionStats.parkRefusals },
    }),
  };
}
