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
    let acquired = false;
    let started = false;
    try {
      // The occurrence's receipt is asked for before anything is acquired:
      // the Broker answers a terminal receipt under the derived key after
      // the Runtime Session that ran the probe was released — a release is
      // final, so re-acquiring that Session would be refused — and only
      // the absence of a receipt costs an acquisition.
      let prepared = await replayableWithoutSession(broker, callId, digest);
      if (prepared === 'held') {
        return {
          kind: 'unknown',
          reason: "the occurrence's Runtime Session is held by another attempt",
        };
      }
      if (prepared?.settled === undefined) {
        await broker.acquire();
        acquired = true;
        prepared ??= await broker.prepareReplayable(callId, digest);
      }
      let result = prepared.settled;
      if (result === undefined) {
        started = true;
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
      const parsed = parseManagedAutomationGateResult(result.responseParts);
      if (parsed === null) {
        return {
          kind: 'failed',
          detail: 'could not start: the Runtime answered no gate result',
          stderr: '',
          durationMs: 0,
        };
      }
      return parsed;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Once the start left, the command may have run: only a settled
      // answer could say; everything else is unknown, never a second start.
      if (
        started ||
        cause instanceof HostedWorkspaceBrokerExecutionUnresolved
      ) {
        return { kind: 'unknown', reason: message };
      }
      return {
        kind: 'failed',
        detail: `could not start: ${message}`,
        stderr: '',
        durationMs: 0,
      };
    } finally {
      if (acquired) {
        try {
          await broker.release();
        } catch {
          // The Runtime Session is derived: a later probe re-acquires it,
          // and the Broker's own sweeps reclaim a release that was lost.
        }
      }
    }
  };
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
