/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { getReplayTokenCount, getReplayTokenUsage } from './mappers.js';

function usageEvent(
  id: number,
  usage: Record<string, unknown>,
  text = '',
): DaemonEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { usage },
      },
    },
  };
}

const turnComplete: DaemonEvent = {
  id: 99,
  v: 1,
  type: 'turn_complete',
  data: { stopReason: 'end_turn' },
};

describe('getReplayTokenCount', () => {
  it('returns undefined for an empty array', () => {
    expect(getReplayTokenCount([])).toBeUndefined();
  });

  it('returns undefined when no event carries usage', () => {
    const plainChunk: DaemonEvent = {
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'no usage here' },
        },
      },
    };
    expect(getReplayTokenCount([plainChunk, turnComplete])).toBeUndefined();
  });

  it('returns the latest usage, not the first', () => {
    expect(
      getReplayTokenCount([
        usageEvent(1, { inputTokens: 11_000 }),
        turnComplete,
        usageEvent(3, { inputTokens: 23_000 }),
        turnComplete,
      ]),
    ).toBe(23_000);
  });

  it('returns the latest structured usage fields', () => {
    expect(
      getReplayTokenUsage([
        usageEvent(1, {
          cachedReadTokens: 10,
          inputTokens: 11_000,
          outputTokens: 100,
          thoughtTokens: 5,
          totalTokens: 11_105,
        }),
        turnComplete,
        usageEvent(3, {
          cachedReadTokens: 0,
          inputTokens: 23_279,
          outputTokens: 182,
          thoughtTokens: 0,
          totalTokens: 23_461,
        }),
      ]),
    ).toEqual({
      cachedReadTokens: 0,
      inputTokens: 23_279,
      outputTokens: 182,
      thoughtTokens: 0,
      totalTokens: 23_461,
    });
  });

  it('prefers inputTokens over totalTokens and falls back to totalTokens', () => {
    expect(
      getReplayTokenCount([
        usageEvent(1, { inputTokens: 7_000, totalTokens: 7_500 }),
      ]),
    ).toBe(7_000);
    expect(getReplayTokenCount([usageEvent(1, { totalTokens: 7_500 })])).toBe(
      7_500,
    );
  });

  it('ignores non-positive and non-numeric usage values', () => {
    expect(
      getReplayTokenCount([
        usageEvent(1, { inputTokens: 5_000 }),
        usageEvent(2, { inputTokens: 0 }),
        usageEvent(3, { inputTokens: 'NaN-ish' }),
      ]),
    ).toBe(5_000);
  });

  it('skips events with non-record payloads and keeps scanning', () => {
    const nullData = {
      id: 2,
      v: 1,
      type: 'session_update',
      data: null,
    } as unknown as DaemonEvent;
    expect(
      getReplayTokenCount([usageEvent(1, { inputTokens: 500 }), nullData]),
    ).toBe(500);
  });

  it('skips events whose payload getter throws and keeps scanning', () => {
    const throwing = {
      id: 2,
      v: 1,
      type: 'session_update',
    } as DaemonEvent;
    Object.defineProperty(throwing, 'data', {
      get() {
        throw new Error('bad replay payload');
      },
    });
    expect(
      getReplayTokenCount([usageEvent(1, { inputTokens: 500 }), throwing]),
    ).toBe(500);
  });
});
