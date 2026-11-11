/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { truncateIndexContent } from './memory-index.js';

describe('truncateIndexContent', () => {
  it('preserves an index within both limits without adding a notice', () => {
    const content = 'one\ntwo';

    expect(truncateIndexContent(content, 2, 7)).toBe(content);
  });

  it.each([
    {
      limit: 'lines',
      content: 'one\ntwo\nthree',
      maxLines: 2,
      maxBytes: 100,
      retained: 'one\ntwo',
      size: '3 lines (limit: 2)',
    },
    {
      limit: 'UTF-8 bytes',
      content: '用户\n参考',
      maxLines: 10,
      maxBytes: 7,
      retained: '用户',
      size: '13 bytes (limit: 7)',
    },
    {
      limit: 'both lines and bytes',
      content: 'one\ntwo\nthree',
      maxLines: 2,
      maxBytes: 5,
      retained: 'one',
      size: '3 lines and 13 bytes',
    },
  ])(
    'reports partial loading for $limit without requesting memory maintenance',
    ({ content, maxLines, maxBytes, retained, size }) => {
      expect(truncateIndexContent(content, maxLines, maxBytes)).toBe(
        `${retained}\n\n> WARNING: MEMORY.md is ${size}. Only part of it was loaded.`,
      );
    },
  );
});
