/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { MAX_BRIDGE_FRAME_BYTES } from '../protocol.js';
import { encodeFrame, FrameDecoder } from './framing.js';

describe('FrameDecoder', () => {
  it('reassembles a frame split across chunks', () => {
    const message = { type: 'event', tabId: 7, method: 'Page.loadEventFired' };
    const frame = encodeFrame(message);
    const decoder = new FrameDecoder();
    // Cut inside the length header and again inside the payload.
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 6))).toEqual([]);
    expect(decoder.push(frame.subarray(6))).toEqual([message]);
  });

  it('yields every frame packed into one chunk', () => {
    const decoder = new FrameDecoder();
    const third = encodeFrame({ id: 'c' });
    const packed = Buffer.concat([
      encodeFrame({ id: 'a' }),
      encodeFrame({ id: 'b' }),
      third.subarray(0, 3),
    ]);
    expect(decoder.push(packed)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(decoder.push(third.subarray(3))).toEqual([{ id: 'c' }]);
  });

  it('rejects a header above the frame ceiling but decodes one exactly at it', () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(MAX_BRIDGE_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(oversized)).toThrow(
      `Bridge frame declares ${MAX_BRIDGE_FRAME_BYTES + 1} bytes; maximum is ${MAX_BRIDGE_FRAME_BYTES}`,
    );

    // The JSON string quotes account for the remaining two bytes.
    const atCeiling = encodeFrame('x'.repeat(MAX_BRIDGE_FRAME_BYTES - 2));
    expect(atCeiling.byteLength).toBe(MAX_BRIDGE_FRAME_BYTES + 4);
    const [decoded] = new FrameDecoder().push(atCeiling);
    expect(typeof decoded).toBe('string');
    expect(decoded).toHaveLength(MAX_BRIDGE_FRAME_BYTES - 2);
  });
});
