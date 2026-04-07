/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../auxiliary/sideQuery.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { planAutoMemoryExtractionPatchesByModel } from './extractionPlanner.js';

vi.mock('../auxiliary/sideQuery.js', () => ({
  runSideQuery: vi.fn(),
}));

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn(),
  };
});

describe('planAutoMemoryExtractionPatchesByModel', () => {
  const mockConfig = {} as Config;
  const messages = [
    { offset: 0, role: 'user' as const, text: 'I prefer terse responses.' },
    { offset: 1, role: 'model' as const, text: 'Understood.' },
    {
      offset: 2,
      role: 'user' as const,
      text: 'The latency dashboard is https://grafana.internal/d/api-latency',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue([
      {
        type: 'user',
        filePath: '/tmp/user.md',
        relativePath: 'user.md',
        filename: 'user.md',
        title: 'User Memory',
        description: 'User preferences',
        body: '- Existing terse preference.',
        mtimeMs: 1,
      },
    ]);
  });

  it('returns model-planned extraction patches', async () => {
    vi.mocked(runSideQuery).mockResolvedValue({
      patches: [
        { topic: 'user', summary: 'User prefers terse responses.', sourceOffset: 0 },
        {
          topic: 'reference',
          summary: 'Latency dashboard: https://grafana.internal/d/api-latency',
          sourceOffset: 2,
        },
      ],
    });

    const patches = await planAutoMemoryExtractionPatchesByModel(
      mockConfig,
      '/tmp/project',
      messages,
    );

    expect(patches).toEqual([
      { topic: 'user', summary: 'User prefers terse responses.', sourceOffset: 0 },
      {
        topic: 'reference',
        summary: 'Latency dashboard: https://grafana.internal/d/api-latency',
        sourceOffset: 2,
      },
    ]);
    expect(runSideQuery).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        purpose: 'auto-memory-extract',
        systemInstruction: expect.stringContaining(
          'You are acting as the managed memory extraction planner',
        ),
      }),
    );
  });

  it('returns empty list when there are no user messages', async () => {
    await expect(
      planAutoMemoryExtractionPatchesByModel(mockConfig, '/tmp/project', [
        { offset: 0, role: 'model', text: 'hello' },
      ]),
    ).resolves.toEqual([]);
    expect(runSideQuery).not.toHaveBeenCalled();
  });

  it('throws when the planner returns an invalid sourceOffset', async () => {
    vi.mocked(runSideQuery).mockImplementation(async (_config, options) => {
      const error = options.validate?.({
        patches: [
          {
            topic: 'user',
            summary: 'User prefers terse responses.',
            sourceOffset: 99,
          },
        ],
      });
      if (error) {
        throw new Error(error);
      }
      return { patches: [] };
    });

    await expect(
      planAutoMemoryExtractionPatchesByModel(mockConfig, '/tmp/project', messages),
    ).rejects.toThrow('Extraction planner returned invalid sourceOffset');
  });
});
