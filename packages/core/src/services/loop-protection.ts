/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LoopType } from '../telemetry/types.js';

/**
 * What a loop detector does when it fires (`model.loopProtection`, #14828).
 * `warn` (default) only reminds; `stop` keeps every stop point and reminds
 * first; `off` only records telemetry. Budgets stop in every mode.
 */
export type LoopProtectionMode = 'off' | 'warn' | 'stop';

export const LOOP_PROTECTION_MODES: readonly LoopProtectionMode[] = [
  'off',
  'warn',
  'stop',
];

export const DEFAULT_LOOP_PROTECTION: LoopProtectionMode = 'warn';

export function isLoopProtectionMode(
  value: unknown,
): value is LoopProtectionMode {
  return (
    typeof value === 'string' &&
    (LOOP_PROTECTION_MODES as readonly string[]).includes(value)
  );
}

// Reminder points of the always-on detectors, each below its stop point.
export const IDENTICAL_CALL_REMINDER_AT = 3; // stop at 5
export const SHELL_INSPECTION_REMINDER_AT = 6; // stop at 8
export const CAP_REPEAT_REMINDER_AT = 4; // stop at GLOBAL_DUPLICATE_THRESHOLD
export const INVALID_PARAMS_REMINDER_AT = 2; // daemon stop at 3

const STOP_SUFFIX: Partial<Record<LoopType, string>> = {
  [LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS]:
    ' Repeating the same call stops this turn.',
  [LoopType.SHELL_COMMAND_STAGNATION]:
    ' More of the same inspection stops this turn.',
  [LoopType.TURN_TOOL_CALL_CAP]: ' Repeating it further stops this turn.',
  [LoopType.INVALID_TOOL_PARAMS_STAGNATION]:
    ' Another invalid call stops this turn.',
};

const HEURISTIC_CAUSE: Partial<Record<LoopType, string>> = {
  [LoopType.GLOBAL_TOOL_CALL_DUPLICATE]:
    'the same tool call keeps repeating in this turn',
  [LoopType.ALTERNATING_TOOL_CALL_PATTERN]:
    'the turn keeps alternating between the same two tool calls',
  [LoopType.READ_FILE_LOOP]:
    'the turn keeps reading files without making progress',
  [LoopType.ACTION_STAGNATION]:
    'the same tool keeps being called without making progress',
};

export interface LoopReminderInput {
  loopType: LoopType;
  /** Tool the reminder is about, when the detector tracks one. */
  toolName?: string;
  /** How often the pattern has repeated so far. */
  count?: number;
  /** Soft cap the turn passed, for the cap reminder. */
  softCap?: number;
  /** Whether continuing will stop the turn (`stop` mode). */
  stops: boolean;
}

/**
 * Model-facing text of a loop-protection reminder. It names the pattern, the
 * tool and what to change; under `stop` it also says that continuing stops
 * the turn.
 */
export function buildLoopReminder(input: LoopReminderInput): string {
  const tool = input.toolName ? `\`${input.toolName}\`` : 'the same tool';
  let text: string;
  switch (input.loopType) {
    case LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS:
      text = `${tool} has been called ${input.count} times in a row with identical arguments, so its result will not change. Use the result you already have, or change the approach.`;
      break;
    case LoopType.SHELL_COMMAND_STAGNATION:
      text = `The last ${input.count} shell commands only inspected the repository (git status, diff or ls-files) without acting on the result. Act on what they showed, or explain what is blocking you.`;
      break;
    case LoopType.TURN_TOOL_CALL_CAP:
      text = `This turn has made more than ${input.softCap} tool calls and has called ${tool} ${input.count} times with identical arguments. Stop repeating it: use the results you have, change the approach, or explain what is blocking you.`;
      break;
    case LoopType.INVALID_TOOL_PARAMS_STAGNATION:
      text = `${tool} has rejected its arguments ${input.count} times in this turn. Check the tool's parameter schema before calling it again, or use a different approach.`;
      break;
    default:
      text = `Loop protection noticed that ${HEURISTIC_CAUSE[input.loopType] ?? 'the turn is repeating itself'}. Change the approach, or explain what is blocking you.`;
      break;
  }
  const suffix = input.stops ? (STOP_SUFFIX[input.loopType] ?? '') : '';
  return `System: ${text}${suffix}`;
}
