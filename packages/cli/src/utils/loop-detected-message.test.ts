/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LoopReason,
  LoopType,
} from '@qwen-code/qwen-code-core/telemetry/types.js';
import {
  LOOP_DETECTED_FALLBACK_MESSAGE,
  describeLoopStop,
  formatInteractiveLoopDetectedMessage,
  formatLoopDetectedMessage,
} from './loop-detected-message.js';

describe('formatLoopDetectedMessage', () => {
  it('names the governing setting for a loop type without a reason', () => {
    expect(
      formatLoopDetectedMessage({
        loopType: LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      }),
    ).toBe(
      'Loop detection halted the run (consecutive_identical_tool_calls: the model repeated the same tool call with identical arguments). Set `model.loopProtection` to "warn" to remind the model instead of stopping, or to "off" to disable this guard.',
    );
    expect(formatLoopDetectedMessage(undefined)).toBe(
      'Loop detection halted the run. Set the `model.skipLoopDetection` setting to true to disable.',
    );
  });

  it('keeps the hedged cap hint when the cap stop names no reason', () => {
    expect(
      formatLoopDetectedMessage({ loopType: LoopType.TURN_TOOL_CALL_CAP }),
    ).toContain(
      '(turn_tool_call_cap: the turn reached the per-turn tool-call limit). A per-turn tool-call cap was reached. The default is adaptive',
    );
  });

  it('names an explicit cap and its value', () => {
    expect(
      formatLoopDetectedMessage({
        loopType: LoopType.TURN_TOOL_CALL_CAP,
        loopReason: LoopReason.EXPLICIT_CAP,
        toolCallCount: 4,
        toolCallLimit: 3,
      }),
    ).toBe(
      'Loop detection halted the run (turn_tool_call_cap: the turn reached the per-turn tool-call limit set by `model.maxToolCallsPerTurn` (3)). Raise `model.maxToolCallsPerTurn`, or set it to 0 to disable the cap.',
    );
  });

  it('names the adaptive backstop', () => {
    expect(
      formatLoopDetectedMessage({
        loopType: LoopType.TURN_TOOL_CALL_CAP,
        loopReason: LoopReason.BACKSTOP,
        toolCallCount: 1001,
        toolCallLimit: 1000,
      }),
    ).toBe(
      'Loop detection halted the run (turn_tool_call_cap: the turn reached the 1000-call backstop of the adaptive per-turn cap). Set `model.maxToolCallsPerTurn` to choose a fixed cap instead (0 disables it).',
    );
  });

  it('names a stuck halt past the soft cap', () => {
    expect(
      formatLoopDetectedMessage({
        loopType: LoopType.TURN_TOOL_CALL_CAP,
        loopReason: LoopReason.STUCK_REPETITION,
        toolCallCount: 101,
        toolCallLimit: 100,
      }),
    ).toBe(
      'Loop detection halted the run (turn_tool_call_cap: past 100 tool calls the model kept repeating the same tool call). Give the model a more specific instruction, or set `model.loopProtection` to "warn" to remind it instead of stopping. An explicit `model.maxToolCallsPerTurn` replaces this repetition check with a fixed cap (0 disables it).',
    );
  });

  it('tells the heuristic global duplicate apart from the provider id breaker', () => {
    expect(
      formatLoopDetectedMessage({
        loopType: LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
        loopReason: LoopReason.REPEATED_CALL,
      }),
    ).toBe(
      'Loop detection halted the run (global_tool_call_duplicate: the model repeated the same tool call across the turn, even when not back-to-back). Set `model.loopProtection` to "warn" to remind the model instead of stopping, or `model.skipLoopDetection` to true to disable this check.',
    );
    expect(
      formatLoopDetectedMessage({
        loopType: LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
        loopReason: LoopReason.PROVIDER_DUPLICATE_ID,
      }),
    ).toBe(
      'Loop detection halted the run (global_tool_call_duplicate: the provider replayed a tool call id that had already run). This is an always-on guard and cannot be disabled via `model.skipLoopDetection`.',
    );
  });

  it('drops the number from a cap label when the limit is missing', () => {
    expect(
      describeLoopStop({
        loopType: LoopType.TURN_TOOL_CALL_CAP,
        loopReason: LoopReason.EXPLICIT_CAP,
      }),
    ).toBe(
      'the turn reached the per-turn tool-call limit set by `model.maxToolCallsPerTurn`',
    );
  });
});

describe('describeLoopStop', () => {
  it('needs a loop type', () => {
    expect(describeLoopStop(undefined)).toBeUndefined();
    expect(
      describeLoopStop({ loopReason: LoopReason.EXPLICIT_CAP }),
    ).toBeUndefined();
  });

  it('prefers the reason over the loop type label', () => {
    expect(
      describeLoopStop({
        loopType: LoopType.TURN_TOOL_CALL_CAP,
        loopReason: LoopReason.STUCK_REPETITION,
        toolCallLimit: 100,
      }),
    ).toBe('past 100 tool calls the model kept repeating the same tool call');
    expect(
      describeLoopStop({ loopType: LoopType.SHELL_COMMAND_STAGNATION }),
    ).toBe(
      'the model repeated similar shell inspection commands without making progress',
    );
  });
});

describe('formatInteractiveLoopDetectedMessage', () => {
  it('keeps the generic sentence without a loop type', () => {
    expect(formatInteractiveLoopDetectedMessage(undefined)).toBe(
      LOOP_DETECTED_FALLBACK_MESSAGE,
    );
  });

  it('uses the headless explanation when the loop type is known', () => {
    const stop = {
      loopType: LoopType.TURN_TOOL_CALL_CAP,
      loopReason: LoopReason.EXPLICIT_CAP,
      toolCallLimit: 3,
    };
    expect(formatInteractiveLoopDetectedMessage(stop)).toBe(
      formatLoopDetectedMessage(stop),
    );
  });
});
