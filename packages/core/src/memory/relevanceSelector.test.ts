/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../core/sideQuery.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';
import { type ScannedAutoMemoryDocument } from './types.js';

vi.mock('../core/sideQuery.js', () => ({
  runSideQuery: vi.fn(),
}));

const docs: ScannedAutoMemoryDocument[] = [
  {
    relativePath: 'preferences.md',
    content: 'User prefers dark mode.',
    mtimeMs: 1,
  },
  {
    relativePath: 'todo.md',
    content: 'Finish the recall selector.',
    mtimeMs: 2,
  },
];

describe('selectRelevantAutoMemoryDocumentsByModel', () => {
  const mockConfig = {
    getFastModel: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns documents chosen by the side-query selector', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: ['preferences.md'],
    });

    const result = await selectRelevantAutoMemoryDocumentsByModel(
      mockConfig,
      'check preferences',
      docs,
      2,
    );

    expect(result).toEqual([docs[0]]);
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
      selectRelevantAutoMemoryDocumentsByModel(mockConfig, '', docs, 2),
    ).resolves.toEqual([]);
    await expect(
      selectRelevantAutoMemoryDocumentsByModel(mockConfig, 'hello', [], 2),
    ).resolves.toEqual([]);
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('passes the fast model to runSideQuery when configured', async () => {
    vi.mocked(mockConfig.getFastModel).mockReturnValue('fast-flash-model');
    vi.mocked(runSideQuery).mockResolvedValue({ selected_memories: [] });

    await selectRelevantAutoMemoryDocumentsByModel(
      mockConfig,
      'check the latency dashboard',
      docs,
      2,
    );

    expect(runSideQuery).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        model: 'fast-flash-model',
      }),
    );
  });

  it('passes undefined model when no fast model is configured', async () => {
    vi.mocked(mockConfig.getFastModel).mockReturnValue(undefined);
    vi.mocked(runSideQuery).mockResolvedValue({ selected_memories: [] });

    await selectRelevantAutoMemoryDocumentsByModel(
      mockConfig,
      'check memory',
      docs,
      2,
    );

    expect(runSideQuery).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        model: undefined,
      }),
    );
  });

  it('throws when selector returns unknown relative paths', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      selected_memories: ['unknown.md'],
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
