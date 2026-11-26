/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostedHarnessReleaseReceipt } from '@qwen-code/qwen-code-core/managed-runtime/hosted-harness-release.js';
import type { ManagedSessionWakeStamp } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import {
  sanitizeDaemonLogLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  type HostedActionParkRefusal,
  hostedActionParkRegistration,
  type HostedActionParkRegistration,
  hostedApprovalResumeShapeRefusal,
  hostedCommandStepResumeShapeRefusal,
} from '../hosted-action-parking.js';
import { findHostedApprovalContinuation } from '../hosted-approval-continuation.js';
import { detachBackgroundPublishers } from '../hosted-background-delivery-recovery.js';
import type { HostedHarnessInstance } from '../hosted-harness-instance.js';
import { wakeHasPriorAttempt } from '../hosted-monitor-wake.js';
import {
  armIdleSuspension,
  beginSuspensionClose,
  createSuspension,
  disarmIdleSuspension,
  HOSTED_IDLE_SUSPEND_MS,
  recordSuspensionActivity,
  runSuspensionAttempt,
  type SessionSuspension,
  suspensionReconcileMs,
} from '../hosted-session-suspension.js';
import { hostedApprovalAsks } from '../hosted-tool-approval.js';
import {
  backgroundSuspensionCertificate,
  hasHostedCleanupDebt,
  hasHostedCleanupDebtExcluding,
} from '../hosted-turn-cleanup.js';
import { pendingSessionInputs } from '../hosted-wake-intake.js';
import type { HostedWorkspaceBrokerOptions } from '../hosted-workspace-broker.js';
import { isHostedWorkspacePublicShellProfile } from '../hosted-workspace-profiles.js';
import { compressionBusy } from './lifecycle-routes.js';
import {
  type HostedRuntimeOwnership,
  retryHostedCleanup,
} from './runtime-ownership.js';
import type {
  HostedHarnessSessionOptions,
  HostedSession,
  HostedSessionOpenings,
  HostedSuspensionStats,
} from './session-state.js';
import { hostedOriginalPromptText } from './turn.js';
import {
  isResumableWakeSource,
  isWakeInputSource,
  isWakeOwnedInput,
  pickWakeInputs,
  unsettledInputs,
  wakeDispatchOwnsInput,
} from './wake-recovery.js';

export const heldResources = (session: HostedSession): number =>
  Number(Boolean(session.hooks)) +
  Number(Boolean(session.mcp)) +
  Number(Boolean(session.automations?.hasPendingGateReleases)) +
  Number(Boolean(session.shell?.publisher)) +
  Number(Boolean(session.backgroundLane?.publisher)) +
  session.heldRuntimeTurns.size +
  Number(Boolean(session.runtimeLeaseHeld)) +
  [...(session.shell?.monitorLoops?.values() ?? [])].length +
  [...(session.backgroundLane?.monitorLoops?.values() ?? [])].length +
  ['child_run', 'monitor_run'].reduce(
    (sum, domain) =>
      sum +
      session.managed.authority
        .extensionRecordsInDomain(domain as 'child_run' | 'monitor_run')
        .filter(
          (entry) =>
            !['settled', 'failed', 'cancelled'].includes(entry.run.state),
        ).length,
    0,
  );

export type HostedSessionSuspension = ReturnType<
  typeof createHostedSessionSuspension
>;

export function createHostedSessionSuspension({
  sessions,
  openings,
  released,
  instance,
  options,
  brokerOptions,
  suspensionStats,
  releaseLeaseNow,
}: {
  sessions: Map<string, HostedSession>;
  openings: HostedSessionOpenings;
  released: Map<
    string,
    { clientId: string; receipt: HostedHarnessReleaseReceipt }
  >;
  instance: HostedHarnessInstance | undefined;
  options: HostedHarnessSessionOptions | undefined;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  suspensionStats: HostedSuspensionStats;
  releaseLeaseNow: HostedRuntimeOwnership['releaseLeaseNow'];
}) {
  // Idle-suspension gates, keyed by Session id beside the residents: an
  // uncertain teardown keeps refusing loads after its resident is gone,
  // so the gate cannot live on the resident object alone.
  const suspensions = new Map<string, SessionSuspension>();
  // The idle period is a candidate constant, not a configuration: only a
  // shorter test value is accepted, so the variable can never disable
  // suspension (like the load reply fault injection in session-open.ts).
  const idleSuspendMs = (() => {
    const testValue = Number(process.env['QWEN_E2E_IDLE_SUSPEND_MS']);
    if (
      Number.isFinite(testValue) &&
      testValue > 0 &&
      testValue < HOSTED_IDLE_SUSPEND_MS
    )
      return testValue;
    const optionValue = options?.idleSuspendMs;
    return optionValue !== undefined &&
      optionValue > 0 &&
      optionValue < HOSTED_IDLE_SUSPEND_MS
      ? optionValue
      : HOSTED_IDLE_SUSPEND_MS;
  })();

  const countedParkRefusals = new WeakSet<HostedActionParkRegistration>();

  async function releaseIdleOwner(
    sessionId: string,
    session: HostedSession,
    operationId: string,
  ): Promise<HostedHarnessReleaseReceipt | undefined> {
    if (!session.placement || !instance || instance.accepting) return undefined;
    // Drain and suspension mark in synchronous sections; whichever marks
    // first wins, the other refuses.
    const gated = suspensions.get(sessionId);
    if (gated && gated.gate !== 'open') return undefined;
    if (!session.ownershipRelease) {
      if (
        instance.inFlightMutations ||
        openings.inFlight.size ||
        openings.reconciliations ||
        session.active ||
        session.recoveredTurn ||
        session.blocked ||
        session.lifecycle ||
        session.mcpBusy ||
        session.hooksBusy ||
        session.mcpRecovering ||
        compressionBusy(session) ||
        heldResources(session) ||
        session.fileHistoryOwed ||
        hasHostedCleanupDebt(session.managed) ||
        session.childConsumption.size ||
        session.messageOperations?.size ||
        unsettledInputs(session).size
      )
        return undefined;
      session.ownershipRelease = { operationId };
    }
    const release = session.ownershipRelease;
    try {
      release.result ??= (async () => {
        if (!release.proof) {
          const projected = await session.managed.sink.project();
          const pending = pendingSessionInputs(
            session.managed.authority.eventsInSequenceRange(
              1,
              session.managed.authority.committedSequence,
            ),
          );
          if (
            pending.some(
              (input) =>
                !isWakeInputSource(input.source) ||
                wakeHasPriorAttempt(projected, input.turnId),
            )
          )
            throw new Error('An attempted input still requires recovery.');
          await session.stores!.quiesceOwnership(session.placement!);
          release.proof = await session.managed.prepareOwnershipRelease();
        }
        return session.stores!.releaseOwnership({
          ...session.placement!,
          operationId: release.operationId,
          commitProof: release.proof,
        });
      })();
      const receipt = await release.result;
      session.monitorWake?.close();
      for (const stop of session.streams) stop();
      await session.stores!.stopLocal();
      // Drop the client-files registration wherever the Session is dropped, so
      // a releasing instance does not leave a live relay client behind.
      await session.clientFiles?.close();
      session.clientFiles = undefined;
      released.set(sessionId, { clientId: session.clientId, receipt });
      if (released.size > 256) released.delete(released.keys().next().value!);
      sessions.delete(sessionId);
      openings.unresolved.delete(sessionId);
      if (
        gated &&
        suspensions.get(sessionId) === gated &&
        !sessions.has(sessionId)
      )
        dropSuspension(sessionId);
      return receipt;
    } catch (cause) {
      release.result = undefined;
      writeStderrLineSafe(
        `qwen serve: Hosted ownership release requires reconciliation: ${String(cause)}`,
      );
      throw cause;
    }
  }

  // Idle suspension, phase 1 of the stateless Hosted Harness design
  // (docs/design/2026-11-16-managed-stateless-harness.md). The state
  // machine lives in hosted-session-suspension.ts; this block supplies
  // eligibility, the synchronous mark, and the non-terminal teardown.

  const suspensionFor = (sessionId: string): SessionSuspension => {
    let suspension = suspensions.get(sessionId);
    if (!suspension) {
      suspension = createSuspension(Date.now());
      suspensions.set(sessionId, suspension);
    }
    return suspension;
  };

  // Dropping an entry must disarm its timer too: the callback outlives the
  // map entry, and a leaked timer keeps firing for a Session nobody holds.
  const dropSuspension = (sessionId: string): void => {
    const entry = suspensions.get(sessionId);
    if (entry) disarmIdleSuspension(entry);
    suspensions.delete(sessionId);
  };

  const armFor = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const suspension = suspensionFor(sessionId);
    session.suspension = suspension;
    const onTimeout = () => {
      // Tie the fire to the entry that armed it. A dropped entry's timer stays
      // armed, and attemptSuspend re-resolves both actors by id: without this
      // guard an orphaned timer suspends the resident a later reload built.
      if (suspensions.get(sessionId) !== suspension) return;
      void attemptSuspend(sessionId).catch((cause) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Session ${sessionId} suspension attempt failed: ${sanitizeDaemonLogLine(String(cause))}`,
        );
      });
    };
    suspension.rearm = () =>
      armIdleSuspension(suspension, { idleMs: idleSuspendMs, onTimeout });
    suspension.rearm();
  };

  const noteActivity = (sessionId: string): void => {
    const suspension = suspensions.get(sessionId);
    if (!suspension || suspension.gate !== 'open') return;
    recordSuspensionActivity(suspension, Date.now());
    suspension.rearm?.();
  };

  interface ActionParkCandidate {
    readonly registration: HostedActionParkRegistration;
    readonly promptId: string;
    readonly wakeAt: number;
    readonly approvalRevision?: number;
    readonly cleanupExempt: boolean;
    /** A wake-started Turn: the wake scan, not a Turn row, resumes it. */
    readonly wakeOwned: boolean;
  }

  // Undefined means no Turn is waiting; a refusal names why a waiting Turn
  // cannot park, in the order the terms are checked.
  const actionParkCandidate = async (
    session: HostedSession,
  ): Promise<ActionParkCandidate | HostedActionParkRefusal | undefined> => {
    const registration = hostedActionParkRegistration(session.managed);
    if (!registration) return undefined;
    if (registration.refusal) return registration.refusal;
    if (session.active?.promptId !== registration.promptId)
      return 'turn_mismatch';
    if (session.recoveredTurn !== undefined) return 'recovered_turn';
    if (
      session.stores?.supportsActionParking?.() !== true ||
      session.stores?.supportsWakeDispatch?.() !== true
    )
      return 'capability_not_advertised';
    const events = session.managed.authority.eventsInSequenceRange(
      1,
      session.managed.authority.committedSequence,
    );
    const accepted = events.find(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['turnId'] === registration.promptId,
    );
    if (!accepted) return 'input_missing';
    // A wake-started Turn parks only where the pump resumes its wait, and
    // only on a control plane that accepts its wake-claiming certificate.
    const wakeOwned = isWakeOwnedInput(accepted);
    if (
      wakeOwned &&
      (!isResumableWakeSource(accepted.payload['source']) ||
        session.stores?.supportsWakeActionParking?.() !== true)
    )
      return 'wake_owned';
    // The pump owns wake inputs, so the unsettled set never holds a wake
    // Turn's own: it must hold nothing else. A second wake input still
    // refuses at the gate, which reads every pending input.
    const unsettled = unsettledInputs(session);
    if (
      wakeOwned
        ? unsettled.size !== 0
        : unsettled.size !== 1 || !unsettled.has(registration.promptId)
    )
      return 'other_unsettled_input';
    if (
      session.managed.authority.action(registration.options.requestId)
        ?.state !== 'requested'
    )
      return 'action_not_requested';
    const continuation = await findHostedApprovalContinuation(
      session.managed,
      registration.promptId,
    );
    if (!continuation) return 'no_continuation';
    const commandStep = continuation.plan.commandStep;
    const shape = commandStep
      ? hostedCommandStepResumeShapeRefusal(session, brokerOptions)
      : hostedApprovalResumeShapeRefusal(session, brokerOptions);
    if (shape) return shape;
    // A drained MCP owner comes back under a new connection, so its tool
    // names would no longer match the saved batch.
    if (session.mcp && !session.mcp.parkable()) return 'mcp_not_parkable';
    // The pump resumes only a native wait.
    if (commandStep && wakeOwned) return 'wake_owned';
    if (
      (await hostedOriginalPromptText(
        session.managed,
        registration.promptId,
      )) === undefined
    )
      return 'original_prompt_missing';
    let approvalRevision: number | undefined;
    if (registration.livePoll) {
      const settings = registration.settings;
      const selection = await session.stores.approvalSelection();
      if (!settings || !selection) return 'approval_selection_unavailable';
      if (
        !hostedApprovalAsks(
          {
            mode: selection.mode,
            timeoutMs: settings.timeoutMs,
            permissionRules: selection.permissionRules,
          },
          registration.options.toolName,
          registration.globProfile,
        )
      )
        return 'approval_mode_allows';
      approvalRevision = selection.revision;
    }
    const deadline = accepted.payload['deadline'];
    return {
      registration,
      promptId: registration.promptId,
      wakeAt:
        typeof deadline === 'number'
          ? Math.min(registration.options.expiresAt, deadline)
          : registration.options.expiresAt,
      approvalRevision,
      cleanupExempt: !(await hasHostedCleanupDebtExcluding(
        session.managed,
        registration.promptId,
      )),
      wakeOwned,
    };
  };

  // Live work only. The persistent owners (hooks, mcp, publishers) are
  // teardown targets the next load re-acquires, not residency pins; the
  // runtime lease is released by teardown step 3. Instance-wide terms are
  // not per-Session eligibility.
  const suspensionLiveWork = (
    session: HostedSession,
    backgroundCertified = false,
    actionPark?: ActionParkCandidate,
  ): boolean =>
    (session.active !== undefined && !actionPark) ||
    session.recoveredTurn !== undefined ||
    session.blocked ||
    session.lifecycle !== undefined ||
    session.mcpBusy === true ||
    session.hooksBusy === true ||
    session.mcpRecovering > 0 ||
    // The durable records, not just the in-flight flags: an operation the
    // dispatch poll gave up on stays pending after the route cleared mcpBusy,
    // and the owner close in teardown step 3 refuses while it does. Without
    // these terms every idle period would spend its retries and hand the
    // Session a blocked gate for a known-pending operation.
    (session.mcp?.hasPendingOperations() ?? false) ||
    (session.mcp?.hasUnsettledConfigurations ?? false) ||
    (session.hooks?.hasPendingOperations ?? false) ||
    compressionBusy(session) ||
    session.fileHistoryOwed !== undefined ||
    session.childConsumption.size > 0 ||
    (session.messageOperations?.size ?? 0) > 0 ||
    (!actionPark && unsettledInputs(session).size > 0) ||
    session.automations?.hasPendingGateReleases === true ||
    session.extensionBootstrapPending === true ||
    (session.replyPlanRetries?.size ?? 0) > 0 ||
    session.ownershipRelease !== undefined ||
    // Liveness, not object presence: unregister() drops the client and
    // registration but leaves the object on the Session, so testing the field
    // would make the Session permanently un-suspendable after one panel use.
    session.clientFiles?.active === true ||
    // An open Harness event stream is a reader this teardown would cut. The
    // design's predicate names it beside the Turn's own stream.
    (!actionPark && session.streams.size > 0) ||
    // The background terms a certified suspension exempts (§4.8).
    (!backgroundCertified &&
      ((actionPark?.cleanupExempt
        ? false
        : hasHostedCleanupDebt(session.managed)) ||
        session.heldRuntimeTurns.size > 0 ||
        [
          ...(session.shell?.monitorLoops?.values() ?? []),
          ...(session.backgroundLane?.monitorLoops?.values() ?? []),
        ].some((loop) => loop.live) ||
        ['child_run', 'monitor_run'].some((domain) =>
          session.managed.authority
            .extensionRecordsInDomain(domain as 'child_run' | 'monitor_run')
            .some(
              (entry) =>
                !['settled', 'failed', 'cancelled'].includes(entry.run.state),
            ),
        ))) ||
    (session.mcp !== undefined &&
      isHostedWorkspacePublicShellProfile(session.toolProfile) &&
      session.lifecycleProtocolVersion !== 2);

  const attemptSuspend = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    const suspension = suspensions.get(sessionId);
    if (!session || !suspension) return;
    const broker = brokerOptions;
    const attemptStart = Date.now();
    let marked = false;
    let lastTeardownError: unknown;
    // Capped retries resume at the failed step: only precise retries of
    // the same operations are allowed past the irreversible boundary.
    const done = {
      wake: false,
      owners: false,
      lease: false,
      publishers: false,
      writer: false,
    };
    // The background certificate is re-derived on every eligibility pass,
    // so an exemption the teardown relies on is never older than the last
    // check before the irreversible boundary (§4.8).
    let backgroundCertified = false;
    const refreshBackgroundCertificate = async (): Promise<boolean> => {
      const previous = backgroundCertified;
      backgroundCertified =
        session.stores?.supportsRuntimeObservation?.() === true &&
        // The seal only stamps the background hold under wake dispatch; a
        // certificate without it would suspend a Session into a seal its
        // recovery cannot read.
        session.stores?.supportsWakeDispatch?.() === true &&
        (await backgroundSuspensionCertificate(
          session.managed,
          new Set([
            ...(session.shell?.observationBindings ?? []),
            ...(session.backgroundLane?.observationBindings ?? []),
          ]),
        ));
      // The exemption evaporated between passes: revert instead of tearing
      // down against evidence that no longer holds.
      return previous && !backgroundCertified;
    };
    let actionPark: ActionParkCandidate | undefined;
    const outcome = await runSuspensionAttempt(suspension, {
      pendingInputs: async () => {
        // Derived inside the attempt so a failed read reverts and rearms;
        // the pass under the gate re-reads the approval selection (§4.1).
        if (!marked) {
          const candidate = await actionParkCandidate(session);
          if (typeof candidate === 'string') {
            // Each wait counts once, under the first reason that kept it
            // resident, so a long wait does not outweigh a short one.
            const registration = hostedActionParkRegistration(session.managed);
            if (registration && !countedParkRefusals.has(registration)) {
              countedParkRefusals.add(registration);
              suspensionStats.parkRefusals[candidate] =
                (suspensionStats.parkRefusals[candidate] ?? 0) + 1;
            }
            actionPark = undefined;
          } else actionPark = candidate;
        } else if (actionPark) {
          const current = await actionParkCandidate(session);
          if (
            typeof current === 'string' ||
            current?.registration !== actionPark.registration
          )
            return true;
          actionPark = current;
        }
        const pending = pendingSessionInputs(
          session.managed.authority.eventsInSequenceRange(
            1,
            session.managed.authority.committedSequence,
          ),
        );
        const park = actionPark;
        if (park) {
          const certificateLost = await refreshBackgroundCertificate();
          const blocked =
            (backgroundCertified &&
              session.stores?.supportsBackgroundActionParking?.() !== true) ||
            certificateLost ||
            hostedActionParkRegistration(session.managed) !==
              park.registration ||
            pending.some((input) => input.turnId !== park.promptId);
          if (!marked && blocked) suspensionStats.eligibilityFailures += 1;
          return blocked;
        }
        let blocked = pending.length > 0;
        if (blocked && session.stores?.supportsWakeDispatch?.()) {
          const projected = await session.managed.sink.project();
          const now = Date.now();
          blocked = pending.some(
            (input) => !wakeDispatchOwnsInput(session, input, projected, now),
          );
        }
        const certificateLost = await refreshBackgroundCertificate();
        if (!marked && (blocked || certificateLost))
          suspensionStats.eligibilityFailures += 1;
        return blocked || certificateLost;
      },
      markClosing: (attemptStart) => {
        if (
          suspensionLiveWork(session, backgroundCertified, actionPark) ||
          suspension.lastActivity > attemptStart ||
          session.ownershipRelease !== undefined ||
          session.lifecycle !== undefined ||
          session.mcpClosing === true ||
          instance?.accepting === false
        ) {
          suspensionStats.eligibilityFailures += 1;
          return false;
        }
        if (!beginSuspensionClose(suspension)) return false;
        marked = true;
        // The wake pump reads mcpClosing through wakeBusy(), so internal
        // wake work obeys the same gate as the routes.
        session.mcpClosing = true;
        return true;
      },
      liveWork: () =>
        suspensionLiveWork(session, backgroundCertified, actionPark),
      beforeTeardown: () => {
        const park = actionPark;
        if (!park) return true;
        // A poll or resolution in flight refuses the freeze; the attempt
        // reverts and the next idle period tries again.
        if (
          hostedActionParkRegistration(session.managed) !== park.registration ||
          !park.registration.freeze()
        )
          return false;
        if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
        session.deadlineTimer = undefined;
        return true;
      },
      teardown: async () => {
        try {
          if (!done.wake) {
            session.monitorWake?.close();
            done.wake = true;
          }
          if (!done.owners) {
            await session.hooks?.close({ terminal: false });
            await session.mcp?.suspend();
            done.owners = true;
          }
          if (!done.lease) {
            if (
              await releaseLeaseNow(
                session,
                false,
                true,
                backgroundCertified,
                actionPark?.promptId,
              )
            )
              throw new Error('Runtime lease release is unproven.');
            if (broker)
              await retryHostedCleanup(
                session,
                broker,
                true,
                backgroundCertified,
                actionPark?.promptId,
              );
            else if (
              !backgroundCertified &&
              (!actionPark
                ? hasHostedCleanupDebt(session.managed)
                : await hasHostedCleanupDebtExcluding(
                    session.managed,
                    actionPark.promptId,
                  ))
            )
              throw new Error('Runtime cleanup remains owed.');
            done.lease = true;
          }
          if (!done.publishers) {
            for (const timer of session.replyPlanRetries?.values() ?? [])
              clearTimeout(timer);
            session.replyPlanRetries?.clear();
            // A certified background suspension detaches its publisher
            // with the final applied watermark instead of closing the
            // worker relationship (§4.9); the local listener still stops
            // because this resident is going away.
            if (backgroundCertified && broker && session.stores?.publication) {
              for (const lane of [session.backgroundLane, session.shell]) {
                if (!lane?.publisher) continue;
                await detachBackgroundPublishers({
                  managed: session.managed,
                  lane,
                  writerOwner: session.stores.publication,
                  brokerOptions: broker,
                  childRuns: session.childRuns,
                  monitors: session.monitors,
                });
              }
            }
            await session.shell?.publisher?.close();
            await session.backgroundLane?.publisher?.close();
            done.publishers = true;
          }
          if (!done.writer) {
            // The writer lease's own renewal timer lives in the Store client,
            // not in the activation renewal below. End it before the release
            // and seal so a failure here leaves a lease that lapses instead of
            // one a removed resident keeps extending forever.
            session.stores!.stopWriterRenewal();
            // Outside the authority serial queue: the renewal runs inside
            // it, so waiting from within would deadlock.
            await session.managed.stopRenewal();
            await session.managed.releaseActivation();
            // The memoized seal: a retry reconciles this same seal. The wake
            // stamp is what the pump would pick from the prefix this seal
            // closes, recomputed on every retry.
            let wake: ManagedSessionWakeStamp | undefined;
            if (actionPark) {
              // A wake-started Turn has no Turn row to redispatch: its park
              // claims the wake at its own due time, and the scan resumes it.
              wake = {
                pending: actionPark.wakeOwned,
                dueAt: actionPark.wakeOwned ? actionPark.wakeAt : 0,
                ...(backgroundCertified ? { backgroundHeld: true } : {}),
                parkedTurn: {
                  promptId: actionPark.promptId,
                  wakeAt: actionPark.wakeAt,
                  ...(actionPark.approvalRevision === undefined
                    ? {}
                    : { approvalRevision: actionPark.approvalRevision }),
                  ...(actionPark.wakeOwned ? { owner: 'wake' as const } : {}),
                },
              };
            } else if (session.stores?.supportsWakeDispatch?.()) {
              const { first, earliestDeferred } = pickWakeInputs(
                session,
                Date.now(),
              );
              wake =
                first !== undefined
                  ? {
                      pending: true,
                      dueAt: 0,
                      ...(backgroundCertified ? { backgroundHeld: true } : {}),
                    }
                  : {
                      pending: earliestDeferred !== undefined,
                      dueAt: earliestDeferred ?? 0,
                      ...(backgroundCertified ? { backgroundHeld: true } : {}),
                    };
            }
            await session.managed.authority.close(wake);
            done.writer = true;
          }
          // Only after every step confirmed: stopLocal fences the seal
          // reconciliation requests too, so it must come last.
          await session.stores!.stopLocal();
          for (const stop of session.streams) stop();
        } catch (cause) {
          lastTeardownError = cause;
          throw cause;
        }
      },
      removeResident: () => {
        sessions.delete(sessionId);
        openings.unresolved.delete(sessionId);
      },
      rearm: () => {
        // A reverted attempt never reached teardown; release only the wake
        // hold this attempt set. A refused markClosing never set it, and a
        // lifecycle-attached or being-replaced resident rests at true — an
        // unconditional clear there hands the wake pump and every closing
        // route a Session another operation is still driving.
        if (marked) session.mcpClosing = false;
        armFor(sessionId);
      },
      retryBaseMs: options?.suspendRetryBaseMs,
      retryCap: options?.suspendRetryCap,
    });
    if (outcome === 'suspended') {
      suspensionStats.cleanSuspensions += 1;
      // Drop the registry entry only if no reload already reused it.
      if (suspensions.get(sessionId) === suspension && !sessions.has(sessionId))
        dropSuspension(sessionId);
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${sessionId} suspended idle.`,
      );
    } else if (outcome === 'reverted') {
      suspensionStats.revertedAttempts += 1;
    } else if (outcome === 'blocked') {
      suspensionStats.blockedTeardowns += 1;
      // The resident is gone but the teardown may have failed before its
      // last steps: no callback may restart work on a removed object.
      // stopLocal stays uncalled — the original client still owes the
      // seal reconciliation.
      for (const stop of session.streams) stop();
      void session.managed.stopRenewal().catch(() => undefined);
      // A teardown that failed before the writer step never reached its
      // stopWriterRenewal, and the removed resident's Store client would keep
      // renewing the lease forever — the bound below proves nothing while it
      // does. End that timer here too; the client stays usable for the seal
      // reconciliation, which stopLocal() would refuse.
      try {
        session.stores?.stopWriterRenewal();
      } catch {
        // A client already closed or fenced has no timer left to end.
      }
      // Bounded automatic recovery (design open question 8): renewal is
      // stopped and no further seal attempt is made, so once the writer
      // lease expires and the capped attempt's in-flight request times out,
      // any acquire bumps the generation and fences the old seal. The gate
      // therefore auto-clears after that bound and the next load cold-opens
      // safely; an operator is needed only if the Store stays unreachable,
      // which surfaces as the load's own transient Store failure. The gate
      // stays blocked (refusing loads) during the wait.
      // Derived from this Session's own lease: it is client-supplied up to
      // 300s, so a constant tuned for the 60s default would clear the gate
      // while a configured lease is still live.
      const reconcileMs =
        options?.suspendReconcileMs ??
        suspensionReconcileMs(session.storeDescriptor.leaseDurationMs);
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${sessionId} teardown uncertain` +
          ` afterMs=${Date.now() - attemptStart} attempts=${suspension.teardownAttempts}` +
          ` reason=${sanitizeDaemonLogLine(String(lastTeardownError))}; gate auto-clears in ${reconcileMs}ms`,
      );
      const reconcileTimer = setTimeout(() => {
        const entry = suspensions.get(sessionId);
        if (entry === suspension && entry.gate === 'blocked') {
          dropSuspension(sessionId);
          suspensionStats.reconciledGates += 1;
          writeStderrLineSafe(
            `qwen serve: Hosted Session ${sessionId} suspension gate reconciled; next load cold-opens.`,
          );
        }
      }, reconcileMs);
      reconcileTimer.unref?.();
    }
  };
  return {
    suspensions,
    releaseIdleOwner,
    dropSuspension,
    armFor,
    noteActivity,
  };
}
