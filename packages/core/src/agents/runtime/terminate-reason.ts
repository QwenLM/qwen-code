/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentTerminateMode } from './agent-types.js';
import type { LoopType } from '../../telemetry/types.js';

const LOOP_DETECTED_WORDING =
  'Agent stopped: duplicate tool-call loop detected';

// Total on purpose, like the severity table in agent-interactive.ts: a new
// AgentTerminateMode has to choose its wording here or `tsc` fails. `null`
// means "no wording", which suppresses the UI message and leaves each
// throwing caller its own text.
const TERMINATE_MODE_WORDING: Record<AgentTerminateMode, string | null> = {
  [AgentTerminateMode.MAX_TURNS]: 'Agent stopped: maximum turns reached.',
  [AgentTerminateMode.TIMEOUT]: 'Agent stopped: time limit reached.',
  [AgentTerminateMode.ERROR]: 'Agent stopped due to an error.',
  [AgentTerminateMode.LOOP_DETECTED]: `${LOOP_DETECTED_WORDING}.`,
  [AgentTerminateMode.GOAL]: null,
  [AgentTerminateMode.CANCELLED]: null,
  [AgentTerminateMode.SHUTDOWN]: null,
};

/**
 * Human-readable wording for a terminate mode. CANCELLED and SHUTDOWN have
 * no wording of their own: the UI suppresses them, and a caller that throws
 * on them is expected to supply its own text. Undefined for anything else,
 * so callers keep whatever text they were given.
 */
export function describeAgentTerminateReason(
  reason: string | undefined,
  loopType?: LoopType | null,
): string | undefined {
  if (!reason || !Object.hasOwn(TERMINATE_MODE_WORDING, reason)) {
    return undefined;
  }
  if (reason === AgentTerminateMode.LOOP_DETECTED && loopType) {
    // Name the exact detector so a stop is attributable (issue #9450)
    // instead of collapsing every loop type into one generic label.
    return `${LOOP_DETECTED_WORDING} (${loopType}).`;
  }
  return TERMINATE_MODE_WORDING[reason as AgentTerminateMode] ?? undefined;
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
