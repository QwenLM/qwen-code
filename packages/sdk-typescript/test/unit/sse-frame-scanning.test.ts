/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { consumeFrames } from '../../src/daemon/sse.js';

describe('SSE frame scanning', () => {
  it.each(['\n\n', '\r\n\r\n'])(
    'preserves every frame in a large batch (%j)',
    (separator) => {
      const frames = Array.from({ length: 16_000 }, (_, id) => `data: ${id}`);
      expect(
        consumeFrames(frames.join(separator) + separator + 'partial'),
      ).toEqual({
        frames,
        tail: 'partial',
      });
    },
  );

  it('keeps mixed complete frames and an unfinished CRLF separator', () => {
    expect(consumeFrames('one\r\n\r\ntwo\n\nthree\r\n\r')).toEqual({
      frames: ['one', 'two'],
      tail: 'three\r\n\r',
    });
  });

  it('consumes the first complete separator before an overlapping LF pair', () => {
    expect(consumeFrames('one\r\n\r\n\ntwo\n\n')).toEqual({
      frames: ['one', '\ntwo'],
      tail: '',
    });
  });

  it('keeps an input with no complete frame unchanged', () => {
    expect(consumeFrames('data: 1\r\n')).toEqual({
      frames: [],
      tail: 'data: 1\r\n',
    });
  });
});
