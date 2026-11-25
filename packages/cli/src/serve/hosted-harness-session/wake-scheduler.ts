/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { AUTOMATION_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { CHANNEL_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import { hostedApprovalResumeShapeRefusal } from '../hosted-action-parking.js';
import {
  findHostedApprovalContinuation,
  type RestoredHostedApprovalContinuation,
} from '../hosted-approval-continuation.js';
import type { HostedHarnessInstance } from '../hosted-harness-instance.js';
import {
  createMonitorWakeRunTurn,
  monitorWakeNeedsRecovery,
  withChildAgentConsumption,
} from '../hosted-monitor-wake-turn.js';
import {
  HostedMonitorWakeScheduler,
  type HostedMonitorWakeTurn,
  MonitorWakeTransientReadError,
  wakeHasPriorAttempt,
} from '../hosted-monitor-wake.js';
import {
  isDurableBlockedVerdict,
  RecoveryDeclined,
  settleInterruptedTurnRuntime,
} from '../hosted-runtime-recovery.js';
import { withSessionMessageConsumption } from '../hosted-session-message-session.js';
import { hasHostedCleanupDebt } from '../hosted-turn-cleanup.js';
import {
  isHostedWakeContinuationId,
  readHostedWakeContinuation,
} from '../hosted-wake-continuation.js';
import { pendingSessionInputs } from '../hosted-wake-intake.js';
import {
  type HostedWorkspaceBrokerOptions,
  HostedWorkspaceBrokerRejection,
} from '../hosted-workspace-broker.js';
import { compressionBusy } from './lifecycle-routes.js';
import {
  type HostedRuntimeOwnership,
  liftRecoveryBlock,
  retryHostedCleanup,
} from './runtime-ownership.js';
import { object } from './session-http.js';
import type { HostedSession } from './session-state.js';
import { executeHostedTurn, hostedOriginalPromptText } from './turn.js';
import {
  attemptedPendingWakeInput,
  isResumableWakeSource,
  isStoppedMessage,
  persistRecoveryUnobserved,
  pickWakeInputs,
  settleCrashedWakeTurnAftermath,
  unsettledInputs,
} from './wake-recovery.js';

export function installHostedWakeScheduler({
  session,
  sessionId,
  cwd,
  brokerOptions,
  instance,
  releaseHeldRuntime,
}: {
  session: HostedSession;
  sessionId: string;
  cwd: string;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  instance: HostedHarnessInstance | undefined;
  releaseHeldRuntime: HostedRuntimeOwnership['releaseHeldRuntime'];
}): void {
  // H3: the embedded wake scheduler of a notification-capable Session.
  // A notification rides its observation revision (H4b: its child
  // acceptance; H6: an automation input rides its run's dispatch
  // revision; H5: a channel input rides its route revision) the same
  // way; the pump delivers it as an ordinary text turn while the
  // Session idles, queues in the journal while a turn runs, and leaves
  // the remainder accurately pending the moment anything is parked or
  // blocked.
  if (
    ((session.monitors || session.childAgents) &&
      brokerOptions &&
      (session.shell || session.backgroundLane)) ||
    session.automations ||
    session.channels
  ) {
    const wakeBusy = () =>
      instance?.accepting === false ||
      session.ownershipRelease !== undefined ||
      compressionBusy(session) ||
      session.active !== undefined ||
      // A recovered-but-undriven Turn holds no live admission, yet its
      // parked checkpoint is what a monitor Turn's commit would
      // supersede: the pump must wait for the continue/cancel drive
      // exactly like the /prompt route does. The journal gate below
      // covers the window the marker cannot: an undrivable redrive
      // disarms the marker while the parked input is still unsettled,
      // and /prompt keeps refusing on exactly that read. Monitor inputs
      // stay excluded — the pump owns their consumption (H3).
      session.recoveredTurn !== undefined ||
      unsettledInputs(session).size !== 0 ||
      session.mcpBusy === true ||
      session.mcpRecovering > 0 ||
      session.hooksBusy === true ||
      session.mcpClosing === true;
    const wakeBlocked = () =>
      session.blocked ||
      session.managed.authority.currentActivation?.phase !== 'active' ||
      (session.mcp?.hasPendingOperations() ?? false) ||
      (session.hooks?.hasPendingOperations ?? false);
    // One deferral log per turn, ever: a transiently faulting
    // recovery retries on the busy cadence, and seven hundred
    // identical lines an hour hide the one that matters.
    const deferredWakeRecovery = new Set<string>();
    const settleInterruptedChannelWake = async (
      turn: HostedMonitorWakeTurn,
    ): Promise<'settled' | 'held' | 'busy' | false> => {
      if (turn.source !== CHANNEL_INPUT_SOURCE || !session.channels)
        return false;
      // F5 follow-up: a turn that died inside a tool call parked
      // its checkpoint in `await_runtime`, where the terminal
      // record cannot advance it — the next wake turn's
      // requireModelStart refuses and the Session wedges. Stop
      // and settle the parked executions first, mirroring the
      // takeover cancellation. A wait that cannot be verified or
      // proven stopped keeps the recovery fleet's freeze; a
      // pending approval holds the turn instead — blocking the
      // Session would refuse the approval's own resolve route.
      let runtime;
      // The same cross-retry honesty carry the takeover cancel
      // drive keeps: a stop that throws after counting unobserved
      // ids must hand them to the busy-cadence retry, or the
      // reclaimed record certifies as a witnessed cancellation.
      const carried = new Set(session.recoveryUnobserved?.get(turn.turnId));
      try {
        runtime = await settleInterruptedTurnRuntime({
          session: session.managed,
          sessionId,
          cwd,
          promptId: turn.turnId,
          brokerOptions,
          toolProfile: session.toolProfile !== undefined,
          shell: session.shell,
          carryUnobservedInto: carried,
          children: session.childAgents,
          consume: (childRunId) => session.childConsumption.add(childRunId),
          teams: session.teams,
          messages: session.messages,
          commands: session.commands,
        });
      } catch (cause) {
        // R6 P1: a durable decline freezes for the fleet, but a
        // transient fault — a faulting Store read, a Broker
        // hiccup behind an otherwise verifiable checkpoint —
        // must stay retryable on the busy cadence instead of
        // latching the Session blocked on the first attempt.
        if (!(cause instanceof RecoveryDeclined)) {
          const retryable = await session.managed.authority
            .harnessRunAuthorization()
            .then(
              (verdict) =>
                verdict.status !== 'blocked' ||
                !isDurableBlockedVerdict(verdict),
            )
            .catch(() => true);
          if (retryable) {
            if (!deferredWakeRecovery.has(turn.turnId)) {
              deferredWakeRecovery.add(turn.turnId);
              writeStderrLineSafe(
                'qwen serve: Interrupted channel wake turn ' +
                  turn.turnId +
                  ' defers its recovery to the next wake attempt: ' +
                  String(cause),
              );
            }
            return 'busy';
          }
        }
        writeStderrLineSafe(
          'qwen serve: Interrupted channel wake turn ' +
            turn.turnId +
            ' keeps its durable wait for the recovery fleet: ' +
            String(cause),
        );
        return false;
      } finally {
        persistRecoveryUnobserved(session, turn.turnId, carried);
      }
      if (runtime.kind === 'held') return 'held';
      // The settle journaled durably, so retries re-derive the
      // outcomes from the journal and the carry has no more work.
      session.recoveryUnobserved?.delete(turn.turnId);
      const settled = await session.channels.settleInterruptedWake(turn.turnId);
      // The recovered lease hands back only once the terminal
      // record is durable: a release persisted earlier would
      // wedge the retry on runtime_session_not_acquirable.
      if (brokerOptions && hasHostedCleanupDebt(session.managed)) {
        try {
          if (
            runtime.broker &&
            (await releaseHeldRuntime(session, brokerOptions, {
              promptId: turn.turnId,
              runtimeSessionId: runtime.broker.runtimeSessionId,
            })) === 'pending'
          )
            return 'busy';
          await retryHostedCleanup(session, brokerOptions);
        } catch (cause) {
          if (!session.blocked) session.cleanupBlocked = true;
          session.blocked = true;
          throw cause;
        }
      } else {
        await runtime.broker?.release().catch((cause: unknown) => {
          if (
            cause instanceof HostedWorkspaceBrokerRejection &&
            cause.status === 404
          )
            return;
          writeStderrLineSafe(
            'qwen serve: Interrupted channel wake turn ' +
              turn.turnId +
              ' could not hand back its recovered Runtime: ' +
              String(cause),
          );
        });
      }
      return settled ? 'settled' : false;
    };
    // The one aftermath of a wake turn that died inside its attempt,
    // serialized per Session: the pump's recovery branch, its blocked
    // retry cycle and the reconcile route may all want it at once.
    let wakeAftermathInFlight = false;
    const wakeAftermath = (session.wakeAftermath = async (turnId) => {
      if (wakeAftermathInFlight) return 'pending';
      wakeAftermathInFlight = true;
      try {
        const authority = session.managed.authority;
        const channelInput = pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        ).find(
          (input) =>
            input.turnId === turnId && input.source === CHANNEL_INPUT_SOURCE,
        );
        if (channelInput !== undefined) {
          if (
            !wakeHasPriorAttempt(await session.managed.sink.project(), turnId)
          ) {
            return 'pending';
          }
          const outcome = await settleInterruptedChannelWake({
            turnId,
            source: CHANNEL_INPUT_SOURCE,
            text: '',
          });
          if (outcome === 'held') liftRecoveryBlock(session);
          return outcome === 'settled' ? 'settled' : 'pending';
        }
        return await settleCrashedWakeTurnAftermath({
          session,
          sessionId,
          cwd,
          brokerOptions,
          turnId,
        });
      } finally {
        wakeAftermathInFlight = false;
      }
    });
    // The earliest future notBefore among the wake inputs the pick
    // below skips as not yet due. The pump's deferUntil reads the value
    // this same journal pass computed, so deferral costs no second read.
    let deferredUntil: number | undefined;
    session.monitorWake = new HostedMonitorWakeScheduler({
      next: async () => {
        // The whole committed prefix, not a bounded page: a notification
        // input lands late in the log, and a default-sized read would
        // hide every one of them once the Session passes that page.
        const { first, earliestDeferred } = pickWakeInputs(session, Date.now());
        deferredUntil = earliestDeferred;
        if (first === undefined) return undefined;
        if (isHostedWakeContinuationId(first.turnId)) {
          return {
            turnId: first.turnId,
            source: first.source,
            ...(await readHostedWakeContinuation(
              session.managed,
              first.turnId,
            )),
          };
        }
        if (first.source === CHANNEL_INPUT_SOURCE) {
          let text: string | undefined;
          try {
            text = await session.channels!.turnText(first.inputId);
          } catch (cause) {
            // A Store fault reading the durable envelope is owed the
            // pump's retry, never a terminal Session lock (R8 P1).
            throw new MonitorWakeTransientReadError(String(cause), {
              cause,
            });
          }
          if (text === undefined)
            throw new Error('Channel wake input has no envelope.');
          return { turnId: first.turnId, text, source: first.source };
        }
        const ref = assertManagedSessionDurableRef(
          first.contentRef,
          'notification wake input',
        );
        if (ref.kind !== 'managed-input')
          throw new Error('Wake input is not an input resource.');
        let bytes: Buffer;
        try {
          bytes = await session.managed.resources.read(ref);
        } catch (cause) {
          throw new MonitorWakeTransientReadError(String(cause), {
            cause,
          });
        }
        const body = object(JSON.parse(bytes.toString('utf8')));
        if (typeof body?.['text'] !== 'string')
          throw new Error('Wake input has no text.');
        return {
          turnId: first.turnId,
          text: body['text'],
          source: first.source,
        };
      },
      deferUntil: () => deferredUntil,
      state: () => (wakeBlocked() ? 'blocked' : wakeBusy() ? 'busy' : 'idle'),
      runTurn: (() => {
        const runWakeTurn = createMonitorWakeRunTurn({
          session,
          sessionId,
          cwd,
          executeHostedTurn: (promptId, text, abort) =>
            executeHostedTurn(
              session,
              sessionId,
              cwd,
              promptId,
              text,
              abort,
              brokerOptions,
            ),
          markLoopDelivered: () => session.loops?.markLoopDelivered(),
          expandLoopFire: (turnId, text) =>
            session.loops
              ? session.loops.expandFireText(turnId, text)
              : Promise.resolve({ text, expanded: false }),
          busy: wakeBusy,
          held: (turn) => isStoppedMessage(session, turn.source),
          cancelled: async (turn) =>
            (turn.source === AUTOMATION_INPUT_SOURCE &&
              session.automations?.cancelRequested(turn.turnId) === true) ||
            (session.publicChildAgentsVersion === 1 &&
              ((await session.childAgents!.cancelledNotification(
                turn.turnId,
              )) ||
                (turn.notificationTurnId !== undefined &&
                  (await session.childAgents!.cancelledNotification(
                    turn.notificationTurnId,
                  ))))),
          needsRecovery: monitorWakeNeedsRecovery,
          // F5/direction (a): channel turns interrupted mid-flight get
          // terminal settlement from their own funnel; monitor turns
          // keep the recovery-blocked freeze their fleet owns.
          settleInterrupted: settleInterruptedChannelWake,
          // A wake turn's native approval wait resumes on the terms the
          // takeover arm applies to a parked prompt's, ahead of a channel
          // turn's own settlement, which keeps every other wait.
          // Session-message turns keep their own settlement.
          resumeInterrupted: async (turn) => {
            if (
              !isResumableWakeSource(turn.source) ||
              hostedApprovalResumeShapeRefusal(session, brokerOptions)
            )
              return undefined;
            const verdict =
              await session.managed.authority.harnessRunAuthorization();
            if (
              verdict.status !== 'runnable' ||
              verdict.checkpoint.identity.turnId !== turn.turnId ||
              verdict.checkpoint.continuation.phase !== 'await_action'
            )
              return undefined;
            let continuation: RestoredHostedApprovalContinuation | undefined;
            try {
              continuation = await findHostedApprovalContinuation(
                session.managed,
                turn.turnId,
              );
            } catch (cause) {
              // A Store fault says nothing about the saved continuation,
              // so the pump retries it. Any other rejection is fixed in
              // the journal and would fail every pass: the Turn takes the
              // crash path instead, as it did before it could resume.
              if (
                cause instanceof ManagedSessionStoreTransportError ||
                (cause instanceof ManagedSessionStoreHttpError &&
                  (cause.status === 429 || cause.status >= 500))
              )
                throw cause;
              writeStderrLineSafe(
                `qwen serve: Interrupted wake turn ${turn.turnId} cannot resume its approval wait: ${String(cause)}`,
              );
              return undefined;
            }
            if (!continuation || continuation.plan.commandStep)
              return undefined;
            const text = await hostedOriginalPromptText(
              session.managed,
              turn.turnId,
            );
            if (text === undefined) return undefined;
            return (abort) =>
              executeHostedTurn(
                session,
                sessionId,
                cwd,
                turn.turnId,
                text,
                abort,
                brokerOptions,
                undefined,
                undefined,
                undefined,
                continuation,
              );
          },
          writeStderr: writeStderrLineSafe,
        });
        // H6c: the automation turn settled; its run settles from the
        // committed result now, and again on the next open if this
        // commit is lost — never twice, never from memory.
        const settleAutomation = async (turnId: string) => {
          try {
            await session.automations?.settleRun(turnId);
          } catch (cause) {
            writeStderrLineSafe(
              `qwen serve: Hosted automation run of turn ${turnId} could not be settled: ${String(cause)}`,
            );
          }
        };
        // H4b: the consumption commits follow the turn's real settle,
        // the acceptance's step before the run's, never before the
        // turn is real.
        const wakeWithConsumption = withSessionMessageConsumption(
          withChildAgentConsumption(runWakeTurn, session, writeStderrLineSafe),
          session,
          writeStderrLineSafe,
        );
        // H5c: the channel turn settled; its reply plans from the
        // committed result now, and again on the next open if this
        // commit is lost — never twice, never from memory. A
        // planning failure only loses the prompt path: while the
        // owner is still resident the retry keeps re-planning with
        // backing-off delays, and a later detach falls back to the
        // open-path reconcile instead of a silent missing reply
        // (R8 P2).
        const replyPlanRetries = (session.replyPlanRetries ??= new Map<
          string,
          NodeJS.Timeout
        >());
        const scheduleReplyPlanRetry = (turnId: string, delayMs: number) => {
          if (replyPlanRetries.has(turnId)) return;
          const timer = setTimeout(() => {
            replyPlanRetries.delete(turnId);
            void session.channels?.planReply(turnId).catch((cause) => {
              writeStderrLineSafe(
                `qwen serve: Hosted channel reply of turn ${turnId} could not be planned: ${String(cause)}`,
              );
              // A sealed Session is nobody else's planner: the
              // open-path reconcile owns the reply from the next
              // detach, not this timer.
              if (!session.managed.authority.writesStopped)
                scheduleReplyPlanRetry(turnId, Math.min(delayMs * 2, 60_000));
            });
          }, delayMs);
          timer.unref();
          replyPlanRetries.set(turnId, timer);
        };
        return async (turn) => {
          let outcome:
            | 'settled'
            | 'busy'
            | 'recovery'
            | 'held'
            | 'settled_incomplete';
          try {
            outcome = await wakeWithConsumption(turn);
          } catch (cause) {
            // The runner wrote the turn's error result before throwing:
            // the run fails from it now rather than on the next open.
            if (turn.source === AUTOMATION_INPUT_SOURCE)
              await settleAutomation(turn.turnId);
            throw cause;
          }
          if (outcome === 'recovery' && turn.source !== CHANNEL_INPUT_SOURCE) {
            // The aftermath is keyed on the journal and the
            // checkpoint, not on which settle ran: an earlier pass
            // (or an earlier load) may have finished any prefix of
            // it. A settled aftermath lifts the block in-process, so
            // the pump continues with the next input at once; a
            // pending one keeps block and input in place, and the
            // blocked pump cycle below — or the next load, whose
            // classification runs the same branch — retries it. A
            // channel turn's recovery is its funnel's and the open
            // path's fleet, never this generic aftermath.
            const aftermath = await wakeAftermath(turn.turnId);
            if (aftermath === 'settled') {
              liftRecoveryBlock(session);
            }
          }
          if (
            turn.source === AUTOMATION_INPUT_SOURCE &&
            (outcome === 'settled' || outcome === 'settled_incomplete')
          ) {
            // Both burned the input: the run settles from the turn's
            // own committed result (completed or errored), never from
            // a re-run of it.
            await settleAutomation(turn.turnId);
          }
          if (
            outcome === 'settled' &&
            turn.source === CHANNEL_INPUT_SOURCE &&
            session.channels
          ) {
            try {
              await session.channels.planReply(turn.turnId);
              const pending = replyPlanRetries.get(turn.turnId);
              if (pending !== undefined) {
                clearTimeout(pending);
                replyPlanRetries.delete(turn.turnId);
              }
            } catch (cause) {
              writeStderrLineSafe(
                `qwen serve: Hosted channel reply of turn ${turn.turnId} could not be planned: ${String(cause)}`,
              );
              scheduleReplyPlanRetry(turn.turnId, 1_000);
            }
          }
          return outcome;
        };
      })(),
      recoverBlocked: async () => {
        // A block with no crash residue (an MCP/Hook wait mid-
        // renewal) no-ops at the aftermath gates; anything else
        // already carries its own retry.
        if (!session.blocked || wakeBusy()) return;
        if (session.cleanupBlocked && brokerOptions) {
          try {
            await retryHostedCleanup(session, brokerOptions);
          } catch {
            return;
          }
          if (!session.blocked) return;
        }
        const target = await attemptedPendingWakeInput(session);
        if (target === undefined) return;
        const aftermath = await wakeAftermath(target.turnId);
        if (aftermath === 'settled') {
          liftRecoveryBlock(session);
        }
      },
      failed: (cause) => {
        session.blocked = true;
        writeStderrLineSafe(
          'qwen serve: Monitor wake pump of session ' +
            sessionId +
            ' failed: ' +
            String(cause),
        );
      },
    });
    if (session.shell)
      session.shell.monitorWakeKick = () => session.monitorWake?.kick();
    if (session.backgroundLane)
      session.backgroundLane.monitorWakeKick = () =>
        session.monitorWake?.kick();
  }
}
