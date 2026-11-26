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
  it('names the explicit cap and its value', () => {
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

  it('names the provider id breaker', () => {
    expect(
      formatLoopDetectedMessage({
        loopType: LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
        loopReason: LoopReason.PROVIDER_DUPLICATE_ID,
      }),
    ).toBe(
      'Loop detection halted the run (global_tool_call_duplicate: the provider replayed a tool call id that had already run).',
    );
  });

  it('gives no cause for a stop of unknown type', () => {
    expect(formatLoopDetectedMessage(undefined)).toBe(
      'Loop detection halted the run.',
    );
    expect(
      formatLoopDetectedMessage({
        loopType: 'consecutive_identical_tool_calls' as LoopType,
      }),
    ).toBe('Loop detection halted the run.');
  });
});

describe('describeLoopStop', () => {
  it('needs a known loop type', () => {
    expect(describeLoopStop(undefined)).toBeUndefined();
    expect(
      describeLoopStop({ loopReason: LoopReason.EXPLICIT_CAP }),
    ).toBeUndefined();
  });

  it('drops the number from the cap label when the limit is missing', () => {
    expect(describeLoopStop({ loopType: LoopType.TURN_TOOL_CALL_CAP })).toBe(
      'the turn reached the per-turn tool-call limit set by `model.maxToolCallsPerTurn`',
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
