/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentTerminateMode } from './agent-types.js';
import type { LoopType } from '../../telemetry/types.js';

/**
 * Human-readable wording for a terminate mode, or undefined when the reason
 * is not a known mode (callers then keep whatever text they were given).
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
      return 'Agent stopped: cancelled before completion.';
    case AgentTerminateMode.SHUTDOWN:
      return 'Agent stopped: shutting down.';
    default:
      return undefined;
  }
}

/**
 * Error text for a forked agent that did not reach its goal. A known
 * terminate mode becomes its wording, an unrecognized reason is passed
 * through unchanged, and an absent reason falls back to the caller's text.
 */
export function terminateReasonMessage(
  reason: string | undefined,
  fallback: string,
): string {
  return describeAgentTerminateReason(reason) ?? reason ?? fallback;
}
