/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  AutomationGateInvalidError,
  automationInputId,
  automationRunId,
  MANAGED_AUTOMATION_LIMITS,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import type {
  AutomationRun,
  Schedule,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-record.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  ManagedSessionAppendUnsettledError,
  ManagedSessionJournalFencedError,
  ManagedSessionModeGateError,
  ManagedSessionRecordError,
  ManagedSessionWritesStoppedError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { Application } from 'express';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import {
  AutomationGateUnsupportedError,
  AutomationNotFoundError,
  AutomationOperationConflictError,
  AutomationQuotaError,
  AutomationRetiredError,
  AutomationRevisionStaleError,
  isAutomationScheduleId,
  isAutomationTrigger,
} from '../hosted-automation-session.js';
import { HOSTED_UUID } from '../hosted-file-history.js';
import { noteSessionActivity } from './lifecycle-routes.js';
import { liftRecoveryBlock } from './runtime-ownership.js';
import { error, identity, object } from './session-http.js';
import type { HostedSession } from './session-state.js';
import {
  attemptedPendingWakeInput,
  firstPendingWakeInput,
  HOSTED_WAKE_PASS_WAIT_MS,
} from './wake-recovery.js';

export function registerHostedAutomationRoutes(
  app: Application,
  sessions: Map<string, HostedSession>,
): void {
  /**
   * H6b/H6c: the control plane's automation operations onto this Session's
   * journal. Each verb maps to one funnel act; replay-safety rides the
   * funnel's derived command ids, so a redriven scanner or route request
   * never mints a second definition revision, run or input. A turn in
   * flight is not a refusal: a run's input queues behind it in the journal.
   */
  app.post('/session/:id/automations/operations', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.automations)
      return error(res, 409, 'hosted_automations_unavailable');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const kind = body?.['kind'];
    const scheduleId = body?.['scheduleId'];
    if (
      typeof operationId !== 'string' ||
      !HOSTED_UUID.test(operationId) ||
      !isAutomationScheduleId(scheduleId)
    ) {
      return error(res, 400, 'invalid_automation_operation');
    }
    const automations = session.automations;
    const scheduleSummary = (schedule: Schedule, revision: number) => ({
      scheduleId: schedule.scheduleId,
      revision,
      definitionRevision: schedule.definitionRevision,
      definitionDigest: schedule.definitionDigest,
      goal: schedule.goal,
      cron: schedule.cron,
      timezone: schedule.timezone,
      sessionMode: schedule.sessionMode,
      targetSessionId: schedule.targetSessionId,
      overlap: schedule.overlap,
      catchUp: schedule.catchUp,
      catchUpLimit: schedule.catchUpLimit,
      enabled: schedule.enabled,
      gate: schedule.gate,
      state: schedule.run.state,
    });
    const runSummary = (run: AutomationRun) => ({
      automationRunId: run.automationRunId,
      scheduleId: run.scheduleId,
      definitionRevision: run.definitionRevision,
      occurrenceKey: run.occurrenceKey,
      state: run.run.state,
      execution: run.run.execution,
    });
    let result: Record<string, unknown>;
    try {
      switch (kind) {
        case 'define_schedule': {
          const definition = object(body?.['definition']);
          if (definition === null)
            return error(res, 400, 'invalid_automation_operation');
          const defined = await automations.define({
            scheduleId,
            operationId,
            definition,
          });
          result = {
            schedule: scheduleSummary(defined.schedule, defined.revision),
            replayed: defined.replayed,
          };
          break;
        }
        case 'retire_schedule': {
          const retired = await automations.retire(scheduleId, operationId);
          result = {
            schedule: scheduleSummary(retired.schedule, retired.revision),
            replayed: retired.replayed,
          };
          break;
        }
        case 'fire_run': {
          const definitionRevision = body?.['definitionRevision'];
          const occurrenceKey = body?.['occurrenceKey'];
          const trigger = body?.['trigger'];
          const firedAt = body?.['firedAt'];
          if (
            !Number.isSafeInteger(definitionRevision) ||
            (definitionRevision as number) < 1 ||
            typeof occurrenceKey !== 'string' ||
            occurrenceKey.length < 1 ||
            occurrenceKey.length > 512 ||
            !isAutomationTrigger(trigger) ||
            !Number.isSafeInteger(firedAt) ||
            (firedAt as number) < 0 ||
            (firedAt as number) > MANAGED_AUTOMATION_LIMITS.maxFiredAtMs
          ) {
            return error(res, 400, 'invalid_automation_operation');
          }
          // A recovery-blocked Session cannot run what a fire dispatches:
          // refuse anything that would commit a new fact into it. The one
          // answer that carries none is the replay of a dispatched run.
          if (session.blocked) {
            const committed = automations.run(
              automationRunId(scheduleId, occurrenceKey as string),
            );
            if (
              committed === undefined ||
              committed.run.execution === 'intent'
            ) {
              return error(res, 409, 'hosted_session_blocked');
            }
          }
          const fired = await automations.fire({
            scheduleId,
            definitionRevision: definitionRevision as number,
            occurrenceKey,
            trigger,
            firedAt: firedAt as number,
          });
          result = {
            // A gate that withheld the fire claimed nothing: no run.
            ...(fired.run === undefined
              ? { run: null }
              : { run: runSummary(fired.run), inputId: fired.inputId }),
            replayed: fired.replayed,
            ...(fired.gate === undefined ? {} : { gate: fired.gate }),
          };
          break;
        }
        case 'cancel_run': {
          const occurrenceKey = body?.['occurrenceKey'];
          if (
            typeof occurrenceKey !== 'string' ||
            occurrenceKey.length < 1 ||
            occurrenceKey.length > 512 ||
            body?.['automationRunId'] !==
              automationRunId(scheduleId, occurrenceKey)
          ) {
            return error(res, 400, 'invalid_automation_operation');
          }
          const runId = automationRunId(scheduleId, occurrenceKey);
          const run = await automations.requestCancel(runId);
          const turnId = automationInputId(runId);
          if (
            automations.cancelRequested(turnId) &&
            session.active?.promptId === turnId
          ) {
            session.active.abort.abort();
          }
          result = { run: runSummary(run) };
          break;
        }
        case 'reconcile_run': {
          const occurrenceKey = body?.['occurrenceKey'];
          if (
            typeof occurrenceKey !== 'string' ||
            occurrenceKey.length < 1 ||
            occurrenceKey.length > 512
          ) {
            return error(res, 400, 'invalid_automation_operation');
          }
          // The control plane's answer to a run whose Harness died mid-
          // turn with nothing left to load the Session (an overlap `skip`
          // definition skips every later slot): this route's own load is
          // what lets the crash be classified at all, so it must not sit
          // behind the blocked guard — it is how the block ends. The
          // aftermath settles the crashed run, the parked executions and
          // the lease, then consumes the input; a live turn owns the
          // pump slot instead, and the answer reports rather than
          // touches it.
          let repaired = false;
          const repairable = () =>
            session.wakeAftermath !== undefined &&
            session.active === undefined &&
            !session.mcpBusy &&
            !session.mcpRecovering &&
            !session.hooksBusy &&
            !session.mcpClosing &&
            firstPendingWakeInput(session) !== undefined;
          const repair = async () => {
            // Re-read after any wait: the pass may have settled the crash
            // itself, and a prompt or a close may have claimed the Session
            // meanwhile.
            const aftermathOf = session.wakeAftermath;
            if (aftermathOf === undefined || !repairable()) return;
            // Claim the turn slot for the repair, exactly like a turn
            // start: a prompt or a lifecycle close reads it as busy
            // instead of starting mid-aftermath.
            session.active = {
              promptId: `wake-reconcile:${operationId}`,
              digest: '',
              abort: new AbortController(),
            };
            try {
              const first = await attemptedPendingWakeInput(session);
              if (first !== undefined) {
                const aftermath = await aftermathOf(first.turnId);
                if (aftermath === 'settled') {
                  liftRecoveryBlock(session);
                  repaired = true;
                }
              }
            } finally {
              session.active = undefined;
              noteSessionActivity(session);
            }
          };
          // A wake pump pass holds no turn slot while it reads, projects
          // and classifies the crashed input, so the repair runs with the
          // pump held: it waits for the load's pass to settle the crash
          // first (the run then answers failed, and the occurrence
          // resolves), and repairs only what that pass left blocked
          // (#14538).
          if (repairable())
            await session.monitorWake?.exclusive(
              repair,
              HOSTED_WAKE_PASS_WAIT_MS,
            );
          const reconciled = automations.run(
            automationRunId(scheduleId, occurrenceKey as string),
          );
          result = {
            run: reconciled === undefined ? null : runSummary(reconciled),
            repaired,
          };
          break;
        }
        default:
          return error(res, 400, 'invalid_automation_operation');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof AutomationRevisionStaleError)
        return error(res, 409, 'automation_revision_stale', undefined, message);
      if (cause instanceof AutomationOperationConflictError)
        return error(
          res,
          409,
          'automation_operation_conflict',
          undefined,
          message,
        );
      if (cause instanceof AutomationRetiredError)
        return error(res, 409, 'automation_retired', undefined, message);
      if (cause instanceof AutomationNotFoundError)
        return error(res, 404, 'automation_not_found', undefined, message);
      if (cause instanceof AutomationQuotaError)
        return error(res, 409, 'automation_count_limit', undefined, message);
      if (cause instanceof AutomationGateUnsupportedError)
        return error(
          res,
          409,
          'automation_gate_unsupported',
          undefined,
          message,
        );
      if (cause instanceof AutomationGateInvalidError)
        return error(res, 400, 'automation_gate_invalid', undefined, message);
      if (cause instanceof ManagedSessionModeGateError)
        return error(res, 409, 'automation_mode_disabled', undefined, message);
      // Typed classification, no message substrings: a dead writer is not a
      // client address error, every other conflict class is a conflict, and
      // a plain record error is the request's shape.
      if (cause instanceof ManagedSessionWritesStoppedError) {
        writeStderrLineSafe(
          `qwen serve: Hosted automation operation ${String(kind)} of session ${req.params['id']} found the journal dead: ${message}`,
        );
        return error(
          res,
          503,
          'automation_operation_failed',
          undefined,
          message,
        );
      }
      // A store HTTP or transport fault is infrastructure, not the
      // request's shape: answer a retryable 503 — settling it as a 4xx
      // would skip the occurrence while the fault is quite recoverable.
      if (
        cause instanceof ManagedSessionStoreHttpError ||
        cause instanceof ManagedSessionStoreTransportError ||
        cause instanceof ManagedSessionAppendUnsettledError ||
        cause instanceof ManagedSessionJournalFencedError
      ) {
        writeStderrLineSafe(
          `qwen serve: Hosted automation operation ${String(kind)} of session ${req.params['id']} lost its store: ${message}`,
        );
        return error(
          res,
          503,
          'automation_operation_failed',
          undefined,
          message,
        );
      }
      if (cause instanceof ManagedSessionConflictError)
        return error(
          res,
          409,
          'automation_operation_conflict',
          undefined,
          message,
        );
      if (cause instanceof ManagedSessionRecordError)
        return error(
          res,
          400,
          'invalid_automation_operation',
          undefined,
          message,
        );
      writeStderrLineSafe(
        `qwen serve: Hosted automation operation ${String(kind)} of session ${req.params['id']} failed: ${message}`,
      );
      return error(res, 503, 'automation_operation_failed', undefined, message);
    }
    session.monitorWake?.kick();
    res.status(202).json({ operationId, state: 'settled', ...result });
  });
}
