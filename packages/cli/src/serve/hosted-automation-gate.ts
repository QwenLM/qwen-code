/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The hosted Harness's side of a managed automation gate: before the
// funnel claims a run of a gated definition, the probe runs in the
// Workspace Runtime as one Tool v2 execution whose every identity is
// derived from the occurrence — the Runtime Session, the call id and the
// reservation reference — so a lost reply, a scanner re-drive or a Harness
// restart meets the Broker's receipt of the first execution instead of
// running the command again. See
// docs/design/2026-10-22-managed-automation-gate.md.

import { createHash } from 'node:crypto';
import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { CronGateResult } from '@qwen-code/qwen-code-core/services/cron-gate.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerExecutionUnresolved,
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { isHostedWorkspaceShellProfile } from './hosted-workspace-profiles.js';
import {
  MANAGED_AUTOMATION_GATE_TIMEOUT_MS,
  MANAGED_AUTOMATION_GATE_TOOL,
  parseManagedAutomationGateResult,
} from './managed-automation-gate-tool.js';

/** The Runtime's answer, or `unknown` when it could not say either way. */
export type HostedAutomationGateResult =
  | CronGateResult
  | { kind: 'unknown'; reason: string };

export interface HostedAutomationGateRequest {
  readonly automationRunId: string;
  /** The definition revision the occurrence is pinned to. */
  readonly definitionRevision: number;
  readonly gate: string;
  readonly signal: AbortSignal;
}

/** A fire whose occurrence's Session is mid-flight: the scanner retries it. */
export class HostedAutomationGateHeld extends Error {}

export type HostedAutomationGateRunner = (
  request: HostedAutomationGateRequest,
) => Promise<HostedAutomationGateResult>;

/** Probe starts remembered at most, oldest forgotten first. */
const STARTED_CALLS_LIMIT = 1024;

function rememberStart(
  started: Map<string, string>,
  callId: string,
  executionCallId: string,
): void {
  started.delete(callId);
  started.set(callId, executionCallId);
  if (started.size > STARTED_CALLS_LIMIT) {
    started.delete(started.keys().next().value!);
  }
}

/**
 * The derived call id of one occurrence's probe under one definition
 * revision; path-safe for the Broker. A revision gets its own Session and
 * reservation, so an occurrence whose definition changed before it was
 * answered probes the command the definition now names, and the attempt
 * that finds its revision stale knows which Session to release.
 */
export function automationGateCallId(
  automationRunId: string,
  definitionRevision: number,
): string {
  return `${automationRunId}:gate:${definitionRevision}`;
}

export interface HostedAutomationGateRunnerOptions {
  readonly broker: HostedWorkspaceBrokerOptions;
  readonly sessionKey: ManagedSessionKey;
  /** The Session's tool profile as it stands when the probe is asked for. */
  readonly toolProfile: () => unknown;
  /**
   * Probes started and not yet answered by a receipt, by derived call id,
   * with their execution. One map serves a Session's runner and release, so
   * a release can ask the Runtime about a record its probe left UNKNOWN.
   */
  readonly startedProbes?: Map<string, string>;
}

function derivedBroker(
  options: HostedAutomationGateRunnerOptions,
  callId: string,
): HostedWorkspaceBroker {
  return new HostedWorkspaceBroker(
    options.broker,
    options.sessionKey,
    hostedRuntimeSessionId(callId),
  );
}

/**
 * Releases the derived Runtime Session of an occurrence's probe under one
 * revision, for a fire that ends without asking the runner again: the
 * revision went stale, or the definition retired or is gone. A failed
 * attempt left that release to the next attempt, which now never comes
 * back through the runner. Throws when the release fails, so the fire is
 * retried; a Session the Broker does not know is gone.
 */
export function createHostedAutomationGateRelease(
  options: HostedAutomationGateRunnerOptions,
): (automationRunId: string, definitionRevision: number) => Promise<void> {
  const startedCalls = options.startedProbes ?? new Map<string, string>();
  return async (automationRunId, definitionRevision) => {
    const callId = automationGateCallId(automationRunId, definitionRevision);
    const broker = derivedBroker(options, callId);
    const executionCallId = startedCalls.get(callId);
    if (executionCallId !== undefined) {
      // A probe this process started may have left its record UNKNOWN,
      // which holds the Session, and no runner asks about it now: ask its
      // Runtime first. A record it settles or fences releases at once; one
      // it still cannot settle keeps the release refused, and the fire is
      // retried.
      await broker
        .status(executionCallId, { reconcile: true })
        .catch(() => undefined);
    }
    // The start stays remembered: this may be the owed release after an
    // answer the runner gave without a receipt, and a re-drive of the same
    // revision must still answer unknown. Only a receipt forgets it.
    await releaseDerivedSession(broker, {
      notFoundIsFinal: true,
      reconciliationIsFinal: true,
    });
  };
}

/** The observation window: the probe's own timeout plus Runtime slack. */
const GATE_OBSERVATION_MS = MANAGED_AUTOMATION_GATE_TIMEOUT_MS + 40_000;

export function createHostedAutomationGateRunner(
  options: HostedAutomationGateRunnerOptions,
): HostedAutomationGateRunner {
  // Probes an attempt of this process started and no receipt has answered
  // yet: a later attempt that cannot read the probe back may say it is
  // unknown, never that it could not start. Kept after such an answer too,
  // since the answer can be lost and the fire driven again; bounded, oldest
  // first, for occurrences that never come back. Each names its execution,
  // so a later attempt can ask the Runtime about a record left UNKNOWN.
  const startedCalls = options.startedProbes ?? new Map<string, string>();
  return async ({ automationRunId, definitionRevision, gate, signal }) => {
    if (!isHostedWorkspaceShellProfile(options.toolProfile())) {
      return {
        kind: 'blocked',
        reason: "the Session's tool profile declares no Shell",
      };
    }
    const callId = automationGateCallId(automationRunId, definitionRevision);
    const broker = derivedBroker(options, callId);
    const payloadJson = JSON.stringify({
      toolName: MANAGED_AUTOMATION_GATE_TOOL,
      input: { gate },
    });
    const digest = `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`;
    // Whether this attempt may hold the derived Runtime Session, so owes its
    // release: an acquisition, one whose answer never arrived, or a Session
    // the Broker already holds live for the occurrence.
    let mayHold = false;
    // An acquisition whose answer never arrived may still be admitted after
    // a release finds nothing: until a later attempt sees the Broker settle
    // it, "not found" proves nothing.
    let unconfirmed = false;
    let replayed = false;
    let started = false;
    // Whether the answer is the probe's own (its receipt) rather than a
    // guess; only then is the start forgotten.
    let answered = false;
    let result: HostedAutomationGateResult;
    try {
      // The occurrence's receipt is asked for before anything is acquired:
      // the Broker answers a terminal receipt under the derived key after
      // the Runtime Session that ran the probe was released — a release is
      // final, so re-acquiring that Session would be refused — and only
      // the absence of a receipt costs an acquisition.
      const answer = await reservationAnswer(broker, callId, digest);
      if (answer === 'held') throw heldByAnotherAttempt();
      if (answer === 'unknown' || answer === 'superseded') {
        // The probe may have run under this Session and its outcome cannot
        // be read back; the Session is released before the answer. A probe
        // this process started is asked of its Runtime first: until then the
        // record stays UNKNOWN, and the Broker refuses the release.
        mayHold = true;
        const executionCallId = startedCalls.get(callId);
        const read =
          answer === 'unknown' && executionCallId !== undefined
            ? await reconciledReceipt(broker, callId, digest, executionCallId)
            : undefined;
        answered = read !== undefined;
        result = read ?? unreadable(answer);
      } else {
        let prepared: Reservation | 'unknown' | 'superseded' | undefined =
          answer;
        // A live reservation means the Session exists: whatever this
        // attempt's own acquire answers, the Session is released at the end.
        if (prepared !== undefined && prepared.settled === undefined) {
          mayHold = true;
        }
        if (prepared?.settled === undefined) {
          try {
            await broker.acquire();
          } catch (cause) {
            // Even a refusal may leave the Session's row behind (the Broker
            // records the acquisition before the Workspace refuses it), so
            // the attempt releases whatever the answer. Only the Broker's own
            // refusal proves nothing was acquired; a lost or unreadable
            // answer may follow a committed acquisition still being admitted.
            mayHold = true;
            if (
              !(cause instanceof HostedWorkspaceBrokerRejection) ||
              cause.status >= 500
            ) {
              unconfirmed = true;
            }
            throw cause;
          }
          mayHold = true;
          if (prepared === undefined) {
            // Asked again under the acquired Session, the key may now name
            // an earlier attempt's execution (a Broker that restarted knew
            // no Session at the first ask): read it like the first answer.
            const again = await reservationAnswer(broker, callId, digest);
            if (again === 'held') throw heldByAnotherAttempt();
            if (again === undefined) {
              throw new Error(
                "the Broker knows no Runtime Session for the occurrence's probe after acquiring it",
              );
            }
            prepared = again;
          }
        } else {
          replayed = true;
        }
        if (prepared === 'unknown' || prepared === 'superseded') {
          result = unreadable(prepared);
        } else {
          const reservation = prepared;
          try {
            result = await settle(
              broker,
              reservation,
              payloadJson,
              signal,
              () => {
                started = true;
                rememberStart(
                  startedCalls,
                  callId,
                  reservation.executionCallId,
                );
              },
            );
            answered = true;
          } catch (cause) {
            if (
              !started ||
              cause instanceof HostedWorkspaceBrokerExecutionUnresolved
            ) {
              throw cause;
            }
            result = await afterLostWatch(
              broker,
              callId,
              digest,
              reservation.executionCallId,
              cause,
            );
            // A receipt, or a cancel that proved the probe never started.
            answered = result.kind !== 'unknown';
          }
        }
      }
    } catch (cause) {
      if (cause instanceof HostedAutomationGateHeld) throw cause;
      // A Workspace refusal may also come back on a prepare that joined an
      // acquisition still being provisioned: that acquisition's row may
      // exist, so it is released like a refused acquire's.
      if (
        cause instanceof HostedWorkspaceBrokerRejection &&
        cause.status === 409 &&
        (cause.code === 'workspace_busy' ||
          cause.code === 'workspace_unavailable')
      ) {
        mayHold = true;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      // Once the start left, the command may have run: only a settled
      // answer could say; everything else is unknown, never a second start.
      result =
        started || cause instanceof HostedWorkspaceBrokerExecutionUnresolved
          ? { kind: 'unknown', reason: message }
          : startedCalls.has(callId)
            ? {
                kind: 'unknown',
                reason: `an earlier attempt started the probe, and this one cannot read it back: ${message}`,
              }
            : {
                kind: 'failed',
                detail: `could not start: ${message}`,
                stderr: '',
                durationMs: 0,
              };
    }
    // A replayed receipt may be all that is left of an attempt that settled
    // the probe and then failed to release, or died before it could: this
    // attempt inherits that release. A Broker that restarted may leave a
    // Session to its cascade, unless this attempt's own acquisition is
    // unconfirmed: then the Broker is still sorting the Runtime out, and a
    // later attempt reads the receipt it settles.
    if (mayHold || replayed) {
      await releaseDerivedSession(broker, {
        notFoundIsFinal: !unconfirmed,
        reconciliationIsFinal: !unconfirmed,
      });
    }
    if (answered) startedCalls.delete(callId);
    return result;
  };
}

/** The probe's answer from a reservation: its receipt, or a start. */
async function settle(
  broker: HostedWorkspaceBroker,
  prepared: Awaited<ReturnType<HostedWorkspaceBroker['prepareReplayable']>>,
  payloadJson: string,
  signal: AbortSignal,
  onStart: () => void,
): Promise<HostedAutomationGateResult> {
  let result = prepared.settled;
  if (result === undefined) {
    onStart();
    // A record left UNKNOWN (the Broker lost its worker's answer) is asked
    // of the original Runtime once: a Tool v2 record is not refreshed
    // otherwise, and the Session cannot be released while it is UNKNOWN.
    result = await broker.execute(
      prepared.executionCallId,
      payloadJson,
      signal,
      GATE_OBSERVATION_MS,
      false,
      true,
    );
  }
  if (result.executionStatus === 'cancelled') {
    return {
      kind: 'failed',
      detail: 'was cancelled',
      stderr: '',
      durationMs: 0,
    };
  }
  if (result.executionStatus !== 'success') {
    const message = result.error?.message ?? result.executionStatus;
    return {
      kind: 'failed',
      // `not_started` never ran; an error may have come from a run, or
      // from a worker that refused the call before running it.
      detail:
        result.executionStatus === 'not_started'
          ? `could not start: ${message}`
          : `the Runtime reported an error: ${message}`,
      stderr: '',
      durationMs: 0,
    };
  }
  return (
    parseManagedAutomationGateResult(result.responseParts) ?? {
      kind: 'failed',
      detail: 'could not start: the Runtime answered no gate result',
      stderr: '',
      durationMs: 0,
    }
  );
}

/**
 * Releases the occurrence's derived Runtime Session before the answer goes
 * out. A Session left behind stays a member of the Workspace execution and
 * blocks its rewind, and once the scanner settles the occurrence nothing
 * comes back for it: a release that fails therefore fails the fire, so the
 * scanner re-drives it and the replay, which reads the settled receipt and
 * runs nothing, releases again. A Session the Broker does not know is gone,
 * except after an acquisition whose answer was lost: the Broker may still be
 * admitting it, so the fire is retried and the next attempt finds it.
 */
async function releaseDerivedSession(
  broker: HostedWorkspaceBroker,
  {
    notFoundIsFinal,
    reconciliationIsFinal,
  }: { notFoundIsFinal: boolean; reconciliationIsFinal: boolean },
): Promise<void> {
  try {
    await broker.release();
  } catch (cause) {
    if (
      notFoundIsFinal &&
      cause instanceof HostedWorkspaceBrokerRejection &&
      cause.status === 404 &&
      cause.code === 'runtime_session_not_found'
    ) {
      return;
    }
    // A Broker that restarted holds the Session only on record and cannot
    // prove its release; as on the Harness's close path, the Workspace-level
    // cascade owns that Runtime from here. Acquiring it to release it could
    // provision a Runtime nobody asked for.
    if (
      reconciliationIsFinal &&
      cause instanceof HostedWorkspaceBrokerRejection &&
      cause.status === 503 &&
      cause.code === 'runtime_reconciliation_required'
    ) {
      return;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `The gate's Runtime Session was not released, so the fire is retried to release it: ${message}`,
    );
  }
}

type Reservation = Awaited<
  ReturnType<HostedWorkspaceBroker['prepareReplayable']>
>;

/**
 * What an attempt answers once it lost sight of an execution it started (a
 * poll that failed, an observation window that ran out): the reservation as
 * the Broker now holds it. A settled receipt is the probe's answer; an
 * execution still running or a Broker that cannot say is retried, so a
 * later attempt reads the real receipt; a reservation still only prepared
 * means the start never arrived, so it is cancelled — it cannot run after
 * this answer — and the probe did not run.
 */
async function afterLostWatch(
  broker: HostedWorkspaceBroker,
  callId: string,
  digest: string,
  executionCallId: string,
  cause: unknown,
): Promise<HostedAutomationGateResult> {
  const now = await reservationAnswer(broker, callId, digest).catch(
    () => 'held' as const,
  );
  if (now === 'held') {
    throw new HostedAutomationGateHeld(
      `the occurrence's probe has not settled: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (now === 'unknown') {
    return (
      (await reconciledReceipt(broker, callId, digest, executionCallId)) ??
      unreadable(now)
    );
  }
  if (now === 'superseded') return unreadable(now);
  if (now === undefined || now.executionCallId !== executionCallId) {
    // A Broker that restarted knows no live Session yet still holds the
    // probe's record: a later attempt acquires, which reconciles it, and
    // reads how it ended.
    throw new HostedAutomationGateHeld(
      "the Broker no longer holds the occurrence's Session live",
    );
  }
  if (now.settled !== undefined) return fromReceipt(broker, now);
  const after = await broker
    .cancelReading(executionCallId)
    .catch(() => undefined);
  if (after === undefined) {
    // The cancel's answer is unknown: a late start may have run the probe
    // to its end meanwhile, so a later attempt reads it.
    throw new HostedAutomationGateHeld(
      "the cancel of the occurrence's prepared probe went unanswered",
    );
  }
  if (after.settled === undefined) {
    // The start landed after all, and the probe was running when the
    // cancel reached it: a later attempt reads how it ended.
    throw new HostedAutomationGateHeld(
      "the occurrence's probe started late and has not settled",
    );
  }
  if (
    after.settled.executionStatus !== 'cancelled' &&
    after.settled.executionStatus !== 'not_started'
  ) {
    // The start landed after all and the probe settled first: the cancel
    // left its receipt as it was, and that is the answer.
    return fromReceipt(broker, { executionCallId, settled: after.settled });
  }
  return {
    kind: 'failed',
    detail: 'could not start: the Runtime never started the probe',
    stderr: '',
    durationMs: 0,
  };
}

/**
 * The receipt of an UNKNOWN probe this process started, once its original
 * Runtime is asked: the Broker leaves a Tool v2 record UNKNOWN until someone
 * asks, and refuses to release its Session meanwhile. Undefined only when
 * the Broker answers that the record is still UNKNOWN, or fenced for good;
 * the release then fails, or the answer is honestly unknown. This ask may
 * itself settle the record, so a reply or a read that goes missing after
 * it retries the fire: the receipt is there for the next attempt to read.
 */
async function reconciledReceipt(
  broker: HostedWorkspaceBroker,
  callId: string,
  digest: string,
  executionCallId: string,
): Promise<HostedAutomationGateResult | undefined> {
  const status = await broker
    .status(executionCallId, { reconcile: true })
    .catch((cause: unknown) => {
      // The Runtime generation that ran it is gone, or its records disagree:
      // no retry gets an answer, so the probe's outcome is unknown.
      if (
        cause instanceof HostedWorkspaceBrokerRejection &&
        cause.status === 409 &&
        (cause.code === 'runtime_execution_evidence_unavailable' ||
          cause.code === 'runtime_execution_conflict')
      ) {
        return { state: 'unknown' as const };
      }
      throw new HostedAutomationGateHeld(
        `the Runtime was asked how the occurrence's probe ended and the answer was lost: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });
  if (status?.state === 'unknown' || status?.state === 'abandoned') {
    return undefined;
  }
  if (status?.state !== 'settled') {
    throw new HostedAutomationGateHeld(
      "the occurrence's probe has not settled after its Runtime was asked",
    );
  }
  const now = await reservationAnswer(broker, callId, digest).catch(
    () => 'held' as const,
  );
  if (
    typeof now !== 'object' ||
    now.settled === undefined ||
    now.executionCallId !== executionCallId
  ) {
    throw new HostedAutomationGateHeld(
      "the occurrence's probe settled, but its receipt could not be read yet",
    );
  }
  return fromReceipt(broker, now);
}

function fromReceipt(
  broker: HostedWorkspaceBroker,
  receipt: Reservation,
): Promise<HostedAutomationGateResult> {
  return settle(broker, receipt, '', new AbortController().signal, () => {
    throw new Error('a settled receipt never starts');
  });
}

function heldByAnotherAttempt(): HostedAutomationGateHeld {
  // The Session exists but is not ready: an attempt still running, or an
  // acquisition whose answer was lost still being admitted. Neither outcome
  // is known yet, and settling the occurrence now would leave a late
  // acquisition with nobody to release it: retry instead.
  return new HostedAutomationGateHeld(
    "the occurrence's Runtime Session is held by another attempt",
  );
}

function unreadable(
  answer: 'unknown' | 'superseded',
): HostedAutomationGateResult {
  return {
    kind: 'unknown',
    reason:
      answer === 'unknown'
        ? "the Runtime lost the occurrence's probe before it settled"
        : 'this occurrence was already probed under another request',
  };
}

/**
 * The occurrence's reservation as the Broker answers it: the settled
 * receipt of an earlier attempt, a fresh reservation when the derived
 * Session is live in the Broker, `undefined` when the Session is not active
 * there (the first attempt, or one whose predecessor never reserved),
 * `held` when the outcome is not known yet (a Session not ready, an
 * execution not settled, a Broker fault), `unknown` when the Runtime lost
 * an execution that may have run, or `superseded` when the key holds
 * another request's execution.
 */
async function reservationAnswer(
  broker: HostedWorkspaceBroker,
  callId: string,
  digest: string,
): Promise<
  | Awaited<ReturnType<HostedWorkspaceBroker['prepareReplayable']>>
  | 'held'
  | 'unknown'
  | 'superseded'
  | undefined
> {
  try {
    return await broker.prepareReplayable(callId, digest);
  } catch (cause) {
    // An execution under the key that has not settled (the client throws a
    // plain error for it), a transport failure or a Broker fault: the probe
    // may still be running, or a Session may still be held. A later attempt
    // reads the settled receipt and releases.
    if (!(cause instanceof HostedWorkspaceBrokerRejection)) return 'held';
    if (cause.status >= 500) return 'held';
    if (cause.status === 404 && cause.code === 'runtime_session_not_found') {
      return undefined;
    }
    if (cause.status === 409 && cause.code === 'runtime_session_not_ready') {
      return 'held';
    }
    // The Runtime lost an execution that may have run.
    if (
      cause.status === 409 &&
      (cause.code === 'runtime_broker_execution_unknown' ||
        cause.code === 'runtime_admission_closed')
    ) {
      return 'unknown';
    }
    // The key holds an execution of another request. Keys are per revision,
    // so only a reservation reference that changed shape gets here.
    if (cause.status === 409 && cause.code === 'runtime_idempotency_conflict') {
      return 'superseded';
    }
    throw cause;
  }
}
