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
  readonly gate: string;
  readonly signal: AbortSignal;
}

/** A fire whose occurrence's Session is mid-flight: the scanner retries it. */
export class HostedAutomationGateHeld extends Error {}

export type HostedAutomationGateRunner = (
  request: HostedAutomationGateRequest,
) => Promise<HostedAutomationGateResult>;

/** The derived call id of one occurrence's probe; path-safe for the Broker. */
export function automationGateCallId(automationRunId: string): string {
  return `${automationRunId}:gate`;
}

/** The observation window: the probe's own timeout plus Runtime slack. */
const GATE_OBSERVATION_MS = MANAGED_AUTOMATION_GATE_TIMEOUT_MS + 40_000;

export function createHostedAutomationGateRunner(options: {
  readonly broker: HostedWorkspaceBrokerOptions;
  readonly sessionKey: ManagedSessionKey;
  /** The Session's tool profile as it stands when the probe is asked for. */
  readonly toolProfile: () => unknown;
}): HostedAutomationGateRunner {
  return async ({ automationRunId, gate, signal }) => {
    if (!isHostedWorkspaceShellProfile(options.toolProfile())) {
      return {
        kind: 'blocked',
        reason: "the Session's tool profile declares no Shell",
      };
    }
    const callId = automationGateCallId(automationRunId);
    const broker = new HostedWorkspaceBroker(
      options.broker,
      options.sessionKey,
      hostedRuntimeSessionId(callId),
    );
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
    let result: HostedAutomationGateResult;
    try {
      // The occurrence's receipt is asked for before anything is acquired:
      // the Broker answers a terminal receipt under the derived key after
      // the Runtime Session that ran the probe was released — a release is
      // final, so re-acquiring that Session would be refused — and only
      // the absence of a receipt costs an acquisition.
      let prepared = await replayableWithoutSession(broker, callId, digest);
      if (prepared === 'held') {
        // The Session exists but is not ready: an attempt still running, or
        // an acquisition whose answer was lost still being admitted. Neither
        // outcome is known yet, and settling the occurrence now would leave
        // a late acquisition with nobody to release it: retry instead.
        throw new HostedAutomationGateHeld(
          "the occurrence's Runtime Session is held by another attempt",
        );
      }
      // A live reservation means the Session exists: whatever this attempt's
      // own acquire answers, the Session is released at the end.
      if (prepared !== undefined && prepared.settled === undefined) {
        mayHold = true;
      }
      if (prepared?.settled === undefined) {
        try {
          await broker.acquire();
        } catch (cause) {
          // Only the Broker's own refusal proves nothing was acquired. A lost
          // or unreadable answer may follow a committed acquisition, whose
          // Session would stay a Workspace execution member with nobody left
          // to release it.
          if (
            !(cause instanceof HostedWorkspaceBrokerRejection) ||
            cause.status >= 500
          ) {
            mayHold = true;
            unconfirmed = true;
          }
          throw cause;
        }
        mayHold = true;
        prepared ??= await broker.prepareReplayable(callId, digest);
      } else {
        replayed = true;
      }
      result = await settle(broker, prepared, payloadJson, signal, () => {
        started = true;
      });
    } catch (cause) {
      if (cause instanceof HostedAutomationGateHeld) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      // Once the start left, the command may have run: only a settled
      // answer could say; everything else is unknown, never a second start.
      result =
        started || cause instanceof HostedWorkspaceBrokerExecutionUnresolved
          ? { kind: 'unknown', reason: message }
          : {
              kind: 'failed',
              detail: `could not start: ${message}`,
              stderr: '',
              durationMs: 0,
            };
    }
    // A replayed receipt may be all that is left of an attempt that settled
    // the probe and then failed to release, or died before it could: this
    // attempt inherits that release.
    if (mayHold || replayed) {
      await releaseDerivedSession(broker, { notFoundIsFinal: !unconfirmed });
    }
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
    result = await broker.execute(
      prepared.executionCallId,
      payloadJson,
      signal,
      GATE_OBSERVATION_MS,
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
    return {
      kind: 'failed',
      detail: `could not start: ${result.error?.message ?? result.executionStatus}`,
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
  { notFoundIsFinal }: { notFoundIsFinal: boolean },
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
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `The gate's Runtime Session was not released, so the fire is retried to release it: ${message}`,
    );
  }
}

/**
 * The occurrence's reservation as the Broker answers it without an acquired
 * Session: the settled receipt of an earlier attempt, a fresh reservation
 * when the derived Session is still live in the Broker, `undefined` when
 * the Session is not active there (the first attempt, or one whose
 * predecessor never reserved), or `held` when the Session exists but is not
 * ready — an attempt still in flight, whose outcome this one cannot know.
 */
async function replayableWithoutSession(
  broker: HostedWorkspaceBroker,
  callId: string,
  digest: string,
): Promise<
  | Awaited<ReturnType<HostedWorkspaceBroker['prepareReplayable']>>
  | 'held'
  | undefined
> {
  try {
    return await broker.prepareReplayable(callId, digest);
  } catch (cause) {
    if (!(cause instanceof HostedWorkspaceBrokerRejection)) throw cause;
    if (cause.status === 404 && cause.code === 'runtime_session_not_found') {
      return undefined;
    }
    if (cause.status === 409 && cause.code === 'runtime_session_not_ready') {
      return 'held';
    }
    throw cause;
  }
}
