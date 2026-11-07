/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Single source of user-facing wording for an agent's terminate
 * mode. Both the interactive path and the background memory agents render the
 * same reason, so the mapping lives here instead of in either caller.
 */

import type { LoopType } from '../../telemetry/types.js';
import { AgentTerminateMode } from './agent-types.js';

export interface TerminateModeMessage {
  text: string;
  level: 'info' | 'warning' | 'error';
}

/**
 * Map a non-GOAL terminate mode to a visible status message for the UI,
 * or return null to suppress the message entirely.
 *
 * CANCELLED is suppressed here because cancelCurrentRound() already emits
 * its own warning. SHUTDOWN is suppressed as a normal lifecycle end.
 *
 * `mode` is a raw string because forked-agent results report the terminate
 * reason as a string; an unknown or missing value is suppressed the same way
 * as GOAL.
 */
export function terminateModeMessage(
  mode: AgentTerminateMode | string | undefined,
  loopType?: LoopType | null,
): TerminateModeMessage | null {
  switch (mode) {
    case AgentTerminateMode.MAX_TURNS:
      return {
        text: 'Agent stopped: maximum turns reached.',
        level: 'warning',
      };
    case AgentTerminateMode.TIMEOUT:
      return { text: 'Agent stopped: time limit reached.', level: 'warning' };
    case AgentTerminateMode.ERROR:
      return { text: 'Agent stopped due to an error.', level: 'error' };
    case AgentTerminateMode.LOOP_DETECTED:
      return {
        // Name the exact detector so a stop is attributable (issue #9450)
        // instead of collapsing every loop type into one generic label.
        text: loopType
          ? `Agent stopped: duplicate tool-call loop detected (${loopType}).`
          : 'Agent stopped: duplicate tool-call loop detected.',
        level: 'error',
      };
    case AgentTerminateMode.CANCELLED:
    case AgentTerminateMode.SHUTDOWN:
      return null;
    default:
      return null;
  }
}

function isTerminateMode(value: string): value is AgentTerminateMode {
  return (Object.values(AgentTerminateMode) as string[]).includes(value);
}

/**
 * User-facing error text for a background agent that stopped early.
 *
 * Known terminate modes get the shared wording above instead of leaking the
 * raw enum token (`MAX_TURNS`) into an error message. A mode this module
 * deliberately suppresses falls back to the caller's own wording, and a
 * free-form reason is passed through because it was already written for
 * humans.
 */
export function describeTerminateReason(
  reason: string | undefined,
  fallback: string,
): string {
  const message = terminateModeMessage(reason);
  if (message) {
    return message.text;
  }
  if (!reason || isTerminateMode(reason)) {
    return fallback;
  }
  return reason;
}
