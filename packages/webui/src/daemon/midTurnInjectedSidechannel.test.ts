/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSidechannelMidTurnInjected,
  consumeSidechannelMidTurnInjected,
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

  it('lifts originatorClientId off the envelope top-level (not data)', () => {
    // The daemon publishes one frame per originator and carries the id on the
    // SSE envelope, not inside `data`, so consumers dedupe only their own queue.
    expect(
      parseSidechannelMidTurnInjected({
        type: 'mid_turn_message_injected',
        originatorClientId: 'client-7',
        data: { sessionId: 's-1', messages: ['hi'] },
      }),
    ).toEqual({
      sessionId: 's-1',
      messages: ['hi'],
      originatorClientId: 'client-7',
    });
  });

  it('omits originatorClientId when absent or non-string (anonymous push)', () => {
    expect(
      parseSidechannelMidTurnInjected({
        type: 'mid_turn_message_injected',
        originatorClientId: 42,
        data: { sessionId: 's-1', messages: ['hi'] },
      }),
    ).toEqual({ sessionId: 's-1', messages: ['hi'] });
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
  it('ACCUMULATES batches across publishes (does not coalesce) and clear resets', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidechannelMidTurnInjected(listener);

    expect(getSidechannelMidTurnInjected()).toEqual([]);

    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['a'] });
    expect(listener).toHaveBeenCalledTimes(1);

    // Critical: a second batch published before the consumer clears must NOT
    // overwrite the first — both are retained so multi-batch turns reconcile in
    // full (a single-slot store would drop 'a' → 'a' resent next turn).
    const afterFirst = getSidechannelMidTurnInjected();
    publishSidechannelMidTurnInjected({
      sessionId: 's-1',
      messages: ['b', 'c'],
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSidechannelMidTurnInjected()).not.toBe(afterFirst); // fresh ref
    expect(getSidechannelMidTurnInjected()).toEqual([
      { sessionId: 's-1', messages: ['a'] },
      { sessionId: 's-1', messages: ['b', 'c'] },
    ]);

    clearSidechannelMidTurnInjected();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getSidechannelMidTurnInjected()).toEqual([]);

    // Clearing an already-empty buffer is a no-op (no spurious notify).
    clearSidechannelMidTurnInjected();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['d'] });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('retains per-batch originatorClientId through publish/accumulate', () => {
    publishSidechannelMidTurnInjected({
      sessionId: 's-1',
      messages: ['a'],
      originatorClientId: 'client-1',
    });
    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['b'] });
    expect(getSidechannelMidTurnInjected()).toEqual([
      { sessionId: 's-1', messages: ['a'], originatorClientId: 'client-1' },
      { sessionId: 's-1', messages: ['b'] },
    ]);
  });

  it('consume removes only the handled batches, leaving a later-arrived frame (race)', () => {
    // Models the render→effect race: the consumer reconciles `snapshot`, then a
    // new frame appends before its consume runs. Identity-removal must drop only
    // the snapshot and leave the new batch (else it is resent next turn).
    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['a'] });
    const snapshot = getSidechannelMidTurnInjected();
    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['b'] }); // races in

    consumeSidechannelMidTurnInjected(snapshot); // drops only ['a']
    expect(getSidechannelMidTurnInjected()).toEqual([
      { sessionId: 's-1', messages: ['b'] },
    ]);

    consumeSidechannelMidTurnInjected(getSidechannelMidTurnInjected());
    expect(getSidechannelMidTurnInjected()).toEqual([]);
  });

  it('consume leaves OTHER-session batches buffered (no cross-session wipe)', () => {
    // A late frame for a previous session must survive an active-session consume,
    // or it is lost on switch-back (resent next turn = double delivery).
    publishSidechannelMidTurnInjected({ sessionId: 's-old', messages: ['x'] });
    publishSidechannelMidTurnInjected({ sessionId: 's-new', messages: ['y'] });
    const all = getSidechannelMidTurnInjected();
    const activeForNew = all.filter((b) => b.sessionId === 's-new');

    consumeSidechannelMidTurnInjected(activeForNew); // only the s-new batch
    expect(getSidechannelMidTurnInjected()).toEqual([
      { sessionId: 's-old', messages: ['x'] },
    ]);
  });

  it('consume is a no-op for batches not in the buffer (already evicted/cleared)', () => {
    publishSidechannelMidTurnInjected({ sessionId: 's-1', messages: ['a'] });
    const snapshot = getSidechannelMidTurnInjected();
    clearSidechannelMidTurnInjected(); // wipe out from under it
    const listener = vi.fn();
    subscribeSidechannelMidTurnInjected(listener);
    consumeSidechannelMidTurnInjected(snapshot); // nothing matches ⇒ no notify
    expect(listener).not.toHaveBeenCalled();
    expect(getSidechannelMidTurnInjected()).toEqual([]);
  });

  it('caps the buffer, evicting oldest batches past the limit', () => {
    for (let i = 0; i < 70; i++) {
      publishSidechannelMidTurnInjected({
        sessionId: 's-1',
        messages: [`m${i}`],
      });
    }
    const buf = getSidechannelMidTurnInjected();
    expect(buf).toHaveLength(64); // MAX_PENDING_BATCHES
    // Oldest (m0..m5) evicted; newest retained.
    expect(buf[0].messages).toEqual(['m6']);
    expect(buf[buf.length - 1].messages).toEqual(['m69']);
  });
});
