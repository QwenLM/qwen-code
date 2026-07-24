/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { recallMedia } from './media-recall.js';
import type { MediaMemory, StoredMediaRecord } from './media-memory-store.js';

function rec(
  hash: string,
  summary: string,
  body: string,
  p = '',
): StoredMediaRecord {
  return {
    hash,
    modality: 'image',
    path: p,
    summary,
    links: [],
    updatedAt: '2026-01-01',
    body,
  };
}

function fakeMemory(records: StoredMediaRecord[]): MediaMemory {
  return {
    list: async () => records,
    get: async () => undefined,
    getByPath: async () => undefined,
    put: async () => {},
    linkOf: async () => [],
  };
}

describe('media recall', () => {
  it('scores by keyword overlap and drops non-matches', async () => {
    const memory = fakeMemory([
      rec('a', 'a diagram of the network topology', 'routers and switches'),
      rec('b', 'a photo of a cat', 'furry animal'),
    ]);
    const hits = await recallMedia(memory, 'network topology diagram');
    expect(hits.length).toBe(1);
    expect(hits[0].record.hash).toBe('a');
  });

  it('boosts records whose path is in play', async () => {
    const memory = fakeMemory([
      rec('a', 'unrelated', 'nothing here', '/proj/a.png'),
      rec('b', 'network topology', 'routers', '/proj/b.png'),
    ]);
    const hits = await recallMedia(memory, 'network', {
      contextFiles: ['/proj/a.png'],
    });
    // 'a' has no keyword hit but is in play => still surfaces via boost.
    expect(hits.map((h) => h.record.hash)).toContain('a');
    // 'b' matches the keyword.
    expect(hits.map((h) => h.record.hash)).toContain('b');
  });

  it('returns nothing for an empty memory', async () => {
    const hits = await recallMedia(fakeMemory([]), 'anything');
    expect(hits).toEqual([]);
  });
});
