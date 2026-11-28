/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { LlmEventType, type ServerLlmStreamEvent } from '../core/turn.js';
import { logLoopDetected } from '../telemetry/loggers.js';
import { LoopReason, LoopType } from '../telemetry/types.js';
import { TurnToolCallCap } from './turn-tool-call-cap.js';

vi.mock('../telemetry/loggers.js', () => ({ logLoopDetected: vi.fn() }));

const call = (id: string) =>
  ({
    type: LlmEventType.ToolCallRequest,
    value: { callId: id, name: 'read_file', args: {} },
  }) as ServerLlmStreamEvent;
const finished = { type: LlmEventType.Finished } as ServerLlmStreamEvent;
const retry = { type: LlmEventType.Retry } as ServerLlmStreamEvent;

function cap(limit: number) {
  const config = {
    getMaxToolCallsPerTurn: () => limit,
  } as unknown as Config;
  const counter = new TurnToolCallCap(config);
  counter.reset('prompt');
  return counter;
}

describe('TurnToolCallCap', () => {
  it('never stops without a cap', () => {
    const counter = cap(Number.POSITIVE_INFINITY);
    for (let i = 0; i < 2000; i++) {
      expect(counter.check(call(`c${i}`))).toBe(false);
    }
    expect(counter.getStop()).toBeUndefined();
  });

  it('stops on the first call past the cap and stays stopped', () => {
    const counter = cap(2);
    expect(counter.check(call('a'))).toBe(false);
    expect(counter.check(call('b'))).toBe(false);
    expect(counter.check(call('c'))).toBe(true);
    expect(counter.check(finished)).toBe(true);
    expect(counter.getStop()).toEqual({
      loopReason: LoopReason.EXPLICIT_CAP,
      toolCallCount: 3,
      toolCallLimit: 2,
    });
    expect(vi.mocked(logLoopDetected)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ loop_type: LoopType.TURN_TOOL_CALL_CAP }),
    );
  });

  it('rolls a retry back to the last finished response', () => {
    const counter = cap(3);
    counter.check(call('a'));
    counter.check(finished);
    counter.check(call('b'));
    counter.check(call('c'));
    counter.check(retry);
    expect(counter.check(call('b'))).toBe(false);
    expect(counter.check(call('c'))).toBe(false);
    expect(counter.check(call('d'))).toBe(true);
  });

  it('starts a fresh count on reset', () => {
    const counter = cap(1);
    counter.check(call('a'));
    expect(counter.check(call('b'))).toBe(true);
    counter.reset('next');
    expect(counter.check(call('c'))).toBe(false);
    expect(counter.getStop()).toBeUndefined();
  });
});
