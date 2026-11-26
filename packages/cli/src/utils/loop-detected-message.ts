/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LoopType } from '@qwen-code/qwen-code-core/telemetry/types.js';
import type { LoopStopDetail } from '@qwen-code/qwen-code-core/telemetry/types.js';

/** What the CLI knows about a loop-protection stop. */
export type LoopStop = { loopType?: LoopType } & LoopStopDetail;

/** Shown by the interactive UIs when the stop carries no loop type. */
export const LOOP_DETECTED_FALLBACK_MESSAGE =
  'A potential loop was detected. This can happen due to repetitive tool calls or other model behavior. The request has been halted.';

function hint(stop: LoopStop): string {
  return stop.loopType === LoopType.TURN_TOOL_CALL_CAP
    ? ' Raise `model.maxToolCallsPerTurn`, or set it to 0 to disable the cap.'
    : '';
}

/** The cause of a stop in plain words. Undefined for an unknown loop type. */
export function describeLoopStop(
  stop: LoopStop | undefined,
): string | undefined {
  switch (stop?.loopType) {
    case LoopType.GLOBAL_TOOL_CALL_DUPLICATE:
      return 'the provider replayed a tool call id that had already run';
    case LoopType.TURN_TOOL_CALL_CAP: {
      const limit = stop.toolCallLimit;
      return `the turn reached the per-turn tool-call limit set by \`model.maxToolCallsPerTurn\`${limit !== undefined ? ` (${limit})` : ''}`;
    }
    default:
      return undefined;
  }
}

/** The headless explanation of a loop stop, also reused by the TUIs. */
export function formatLoopDetectedMessage(stop: LoopStop | undefined): string {
  const cause = describeLoopStop(stop);
  const detail = cause ? ` (${stop?.loopType}: ${cause})` : '';
  return `Loop detection halted the run${detail}.${hint(stop ?? {})}`;
}

/** Interactive variant: keeps the generic sentence when the type is unknown. */
export function formatInteractiveLoopDetectedMessage(
  stop: LoopStop | undefined,
): string {
  return stop?.loopType
    ? formatLoopDetectedMessage(stop)
    : LOOP_DETECTED_FALLBACK_MESSAGE;
}
