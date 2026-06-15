/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSidechannelMidTurnInjected,
  getSidechannelMidTurnInjected,
  parseSidechannelMidTurnInjected,
  publishSidechannelMidTurnInjected,
  subscribeSidechannelMidTurnInjected,
} from './midTurnInjectedSidechannel.js';

afterEach(() => {
  clearSidechannelMidTurnInjected();
});

describe('parseSidechannelMidTurnInjected', () => {
  it('parses a well-formed frame', () => {
    expect(
      parseSidechannelMidTurnInjected({
        type: 'mid_turn_message_injected',
        data: { sessionId: 's-1', messages: ['hi', 'there'] },
      }),
    ).toEqual({ sessionId: 's-1', messages: ['hi', 'there'] });
  });

  it('filters non-string and empty entries', () => {
    expect(
      parseSidechannelMidTurnInjected({
        type: 'mid_turn_message_injected',
        data: { sessionId: 's-1', messages: ['keep', '', 42, 'also'] },
      }),
    ).toEqual({ sessionId: 's-1', messages: ['keep', 'also'] });
  });

  it('returns undefined for wrong type, missing data, or no usable messages', () => {
    expect(
      parseSidechannelMidTurnInjected({ type: 'other', data: {} }),
    ).toBeUndefined();
    expect(
      parseSidechannelMidTurnInjected({ type: 'mid_turn_message_injected' }),
    ).toBeUndefined();
    expect(
      parseSidechannelMidTurnInjected({
        type: 'mid_turn_message_injected',
        data: { sessionId: 's-1', messages: [''] },
      }),
    ).toBeUndefined();
    expect(
      parseSidechannelMidTurnInjected({
        type: 'mid_turn_message_injected',
        data: { messages: ['x'] },
      }),
    ).toBeUndefined();
    expect(parseSidechannelMidTurnInjected(null)).toBeUndefined();
  });
});

describe('mid-turn injected sidechannel pub/sub', () => {
  it('notifies listeners, exposes the latest batch, and clear resets', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidechannelMidTurnInjected(listener);

    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['a'] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSidechannelMidTurnInjected()).toEqual({
      sessionId: 's-1',
      messages: ['a'],
    });

    // A fresh reference every publish so `useSyncExternalStore` re-fires even
    // for identical text.
    const first = getSidechannelMidTurnInjected();
    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['a'] });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSidechannelMidTurnInjected()).not.toBe(first);

    clearSidechannelMidTurnInjected();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getSidechannelMidTurnInjected()).toBeUndefined();

    unsubscribe();
    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['b'] });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
