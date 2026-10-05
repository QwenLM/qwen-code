/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentTerminateMode } from './agent-types.js';
import type { LoopType } from '../../telemetry/types.js';

/**
 * Human-readable wording for a terminate mode. CANCELLED and SHUTDOWN have
 * no wording of their own: the UI suppresses them, and a caller that throws
 * on them is expected to supply its own cancellation text. Undefined for
 * anything else, so callers keep whatever text they were given.
 */
export function describeAgentTerminateReason(
  reason: string | undefined,
  loopType?: LoopType | null,
): string | undefined {
  switch (reason) {
    case AgentTerminateMode.MAX_TURNS:
      return 'Agent stopped: maximum turns reached.';
    case AgentTerminateMode.TIMEOUT:
      return 'Agent stopped: time limit reached.';
    case AgentTerminateMode.ERROR:
      return 'Agent stopped due to an error.';
    case AgentTerminateMode.LOOP_DETECTED:
      return loopType
        ? // Name the exact detector so a stop is attributable (issue #9450)
          // instead of collapsing every loop type into one generic label.
          `Agent stopped: duplicate tool-call loop detected (${loopType}).`
        : 'Agent stopped: duplicate tool-call loop detected.';
    case AgentTerminateMode.CANCELLED:
    case AgentTerminateMode.SHUTDOWN:
    default:
      return undefined;
  }
}

/**
 * Error text for a forked agent that did not reach its goal. A terminate
 * mode never reaches the user as its raw token: it becomes its wording, or
 * the caller's own text for the modes that have none. Anything else is a
 * message the agent itself produced and is passed through unchanged.
 */
export function terminateReasonMessage(
  reason: string | undefined,
  fallback: string,
): string {
  const described = describeAgentTerminateReason(reason);
  if (described) return described;
  // Every AgentTerminateMode member is keyed by its own value, so the enum
  // object doubles as the lookup for "is this an internal token". `hasOwn`
  // rather than `in`, which would also match `toString` and friends.
  if (!reason || Object.hasOwn(AgentTerminateMode, reason)) return fallback;
  return reason;
}
