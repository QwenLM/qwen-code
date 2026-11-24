/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LoopReason,
  LoopType,
} from '@qwen-code/qwen-code-core/telemetry/types.js';
import type { LoopStopDetail } from '@qwen-code/qwen-code-core/telemetry/types.js';

/** What the CLI knows about a loop-protection stop. */
export type LoopStop = { loopType?: LoopType } & LoopStopDetail;

/** Shown by the interactive UIs when the stop carries no loop type. */
export const LOOP_DETECTED_FALLBACK_MESSAGE =
  'A potential loop was detected. This can happen due to repetitive tool calls or other model behavior. The request has been halted.';

// Human-readable labels for the detectors that can fire mid-stream.
// Surfaced to stderr in TEXT mode so a headless run that halts on a loop
// doesn't exit with empty stdout and no explanation — see PR #3236 review.
const LOOP_TYPE_LABELS: Record<LoopType, string> = {
  [LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS]:
    'the model repeated the same tool call with identical arguments',
  // Reasoning-stream chants fire this type too (checkReasoningContentLoop),
  // and getResponseText filters reasoning out of visible output — the label
  // must name both channels so a headless halt on an empty stdout is not
  // mistaken for a detector misfire.
  [LoopType.CHANTING_IDENTICAL_SENTENCES]:
    'the model repeated the same sentence in its output or reasoning',
  [LoopType.REPETITIVE_THOUGHTS]:
    'the model repeated the same reasoning thought',
  [LoopType.READ_FILE_LOOP]:
    'the model spent too many consecutive calls reading files without making progress',
  [LoopType.ACTION_STAGNATION]:
    'the model kept calling the same tool without making progress',
  [LoopType.SHELL_COMMAND_STAGNATION]:
    'the model repeated similar shell inspection commands without making progress',
  [LoopType.GLOBAL_TOOL_CALL_DUPLICATE]:
    'the model repeated the same tool call across the turn, even when not back-to-back',
  [LoopType.ALTERNATING_TOOL_CALL_PATTERN]:
    'the model alternated between the same two tool calls in a repeating pattern',
  [LoopType.TURN_TOOL_CALL_CAP]:
    'the turn reached the per-turn tool-call limit',
  [LoopType.INVALID_TOOL_PARAMS_STAGNATION]:
    'the model repeatedly sent invalid tool parameters without correcting them',
  [LoopType.REPEATED_TOOL_EXECUTION_FAILURE]:
    'the same tool execution failure continued after a corrective reminder',
};

const ALWAYS_ON_HINT =
  ' This is an always-on guard and cannot be disabled via `model.skipLoopDetection`.';
// Guards that follow `model.loopProtection` (#14828).
const GOVERNED_HINT =
  ' Set `model.loopProtection` to "warn" to remind the model instead of stopping, or to "off" to disable this guard.';
const HEURISTIC_HINT =
  ' Set `model.loopProtection` to "warn" to remind the model instead of stopping, or `model.skipLoopDetection` to true to disable this check.';
// For content and thought repetition, which stops under "warn" too, and for
// a stop of unknown type.
const SKIP_HINT =
  ' Set the `model.skipLoopDetection` setting to true to disable.';

function reasonLabel(stop: LoopStop): string | undefined {
  const limit = stop.toolCallLimit;
  switch (stop.loopReason) {
    case LoopReason.EXPLICIT_CAP:
      return `the turn reached the per-turn tool-call limit set by \`model.maxToolCallsPerTurn\`${limit !== undefined ? ` (${limit})` : ''}`;
    case LoopReason.BACKSTOP:
      return limit !== undefined
        ? `the turn reached the ${limit}-call backstop of the adaptive per-turn cap`
        : 'the turn reached the backstop of the adaptive per-turn cap';
    case LoopReason.STUCK_REPETITION:
      return limit !== undefined
        ? `past ${limit} tool calls the model kept repeating the same tool call`
        : 'past the per-turn soft cap the model kept repeating the same tool call';
    case LoopReason.PROVIDER_DUPLICATE_ID:
      return 'the provider replayed a tool call id that had already run';
    default:
      return undefined;
  }
}

function hint(stop: LoopStop): string {
  switch (stop.loopReason) {
    case LoopReason.EXPLICIT_CAP:
      return ' Raise `model.maxToolCallsPerTurn`, or set it to 0 to disable the cap.';
    case LoopReason.BACKSTOP:
      return ' Set `model.maxToolCallsPerTurn` to choose a fixed cap instead (0 disables it).';
    case LoopReason.STUCK_REPETITION:
      return ' Give the model a more specific instruction, or set `model.loopProtection` to "warn" to remind it instead of stopping. An explicit `model.maxToolCallsPerTurn` replaces this repetition check with a fixed cap (0 disables it).';
    case LoopReason.REPEATED_CALL:
      return HEURISTIC_HINT;
    case LoopReason.PROVIDER_DUPLICATE_ID:
      return ALWAYS_ON_HINT;
    default:
      break;
  }
  switch (stop.loopType) {
    case LoopType.TURN_TOOL_CALL_CAP:
      return ' A per-turn tool-call cap was reached. The default is adaptive (allows up to 1000 diverse calls, halting only on repeated calls); an explicitly set `model.maxToolCallsPerTurn` is a hard cap. If the model was repeating the same call, investigate the repetition; otherwise unset the value to use the adaptive default, or raise it (set 0 to disable).';
    // The always-on guards run before the skipLoopDetection gate, so that
    // setting can't disable them; `model.loopProtection` governs them.
    case LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS:
    case LoopType.SHELL_COMMAND_STAGNATION:
    case LoopType.INVALID_TOOL_PARAMS_STAGNATION:
      return GOVERNED_HINT;
    case LoopType.REPEATED_TOOL_EXECUTION_FAILURE:
      return ALWAYS_ON_HINT;
    case LoopType.CHANTING_IDENTICAL_SENTENCES:
    case LoopType.REPETITIVE_THOUGHTS:
    case undefined:
      return SKIP_HINT;
    default:
      return HEURISTIC_HINT;
  }
}

/**
 * The cause of a stop in plain words, refined by its reason when the loop
 * type covers several causes. Undefined without a loop type.
 */
export function describeLoopStop(
  stop: LoopStop | undefined,
): string | undefined {
  if (!stop?.loopType) return undefined;
  return reasonLabel(stop) ?? LOOP_TYPE_LABELS[stop.loopType];
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
