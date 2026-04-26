/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../utils/sideQuery.js';
import type { ScannedAutoMemoryDocument } from './scan.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';

vi.mock('../utils/sideQuery.js', () => ({
  runSideQuery: vi.fn(),
}));

const docs: ScannedAutoMemoryDocument[] = [
  {
    type: 'user',
    filePath: '/tmp/user.md',
    relativePath: 'user.md',
    filename: 'user.md',
    title: 'User Memory',
    description: 'User preferences',
    body: '- User prefers terse responses.',
    mtimeMs: 1,
  },
  {
    type: 'reference',
    filePath: '/tmp/reference.md',
    relativePath: 'reference.md',
    filename: 'reference.md',
    title: 'Reference Memory',
    description: 'Operational references',
    body: '- Grafana dashboard: https://grafana.internal/d/api-latency',
    mtimeMs: 2,
  },
];

describe('selectRelevantAutoMemoryDocumentsByModel', () => {
  const mockConfig = {} as Config;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns documents chosen by the side-query selector', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: ['reference.md'],
    });

    const selected = await selectRelevantAutoMemoryDocumentsByModel(
      mockConfig,
      'check the latency dashboard',
      docs,
      2,
    );

    expect(selected).toEqual([docs[1]]);
    expect(runSideQuery).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        purpose: 'auto-memory-recall',
        config: { temperature: 0 },
      }),
    );
  });

  it('returns an empty list for empty query or no docs', async () => {
    await expect(
      selectRelevantAutoMemoryDocumentsByModel(mockConfig, '   ', docs, 2),
    ).resolves.toEqual([]);
    await expect(
      selectRelevantAutoMemoryDocumentsByModel(mockConfig, 'hello', [], 2),
    ).resolves.toEqual([]);
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('throws when selector returns unknown relative paths', async () => {
    vi.mocked(runSideQuery).mockImplementation(async (_config, options) => {
      const error = options.validate?.({
        selected_memories: ['unknown.md'],
      });
      if (error) {
        throw new Error(error);
      }
      return { selected_memories: [] };
    });

    await expect(
      selectRelevantAutoMemoryDocumentsByModel(
        mockConfig,
        'check memory',
        docs,
        2,
      ),
    ).rejects.toThrow('Recall selector returned unknown relative path');
  });
});
