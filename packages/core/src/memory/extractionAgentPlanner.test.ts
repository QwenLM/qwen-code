/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { runForkedAgent } from '../background/forkedAgent.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn(),
  };
});

vi.mock('../background/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

describe('runAutoMemoryExtractionByAgent', () => {
  const mockConfig = {
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    getApprovalMode: vi.fn(),
  } as unknown as Config;

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

  it('returns parsed execution summary and enables write/edit tools', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: JSON.stringify({
        patches: [
          {
            topic: 'user',
            summary: 'User prefers terse responses.',
            sourceOffset: 0,
          },
        ],
        touchedTopics: ['user'],
      }),
      filesTouched: ['/tmp/user.md'],
    });

    const result = await runAutoMemoryExtractionByAgent(
      mockConfig,
      '/tmp/project',
      [{ offset: 0, role: 'user', text: 'I prefer terse responses.' }],
    );

    expect(result).toEqual({
      patches: [
        {
          topic: 'user',
          summary: 'User prefers terse responses.',
          sourceOffset: 0,
          why: undefined,
          howToApply: undefined,
        },
      ],
      touchedTopics: ['user'],
      systemMessage: 'Managed auto-memory updated: user.md',
    });
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          'read_file',
          'write_file',
          'edit',
          'list_directory',
          'glob',
          'grep_search',
        ],
        maxTurns: 5,
        maxTimeMinutes: 2,
      }),
    );
  });

  it('throws when the agent fails to complete', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'timeout',
      filesTouched: [],
    });

    await expect(
      runAutoMemoryExtractionByAgent(mockConfig, '/tmp/project', [
        { offset: 0, role: 'user', text: 'I prefer terse.' },
      ]),
    ).rejects.toThrow('timeout');
  });

  it('returns empty result when messages array is empty', async () => {
    const result = await runAutoMemoryExtractionByAgent(
      mockConfig,
      '/tmp/project',
      [],
    );
    expect(result).toEqual({ patches: [], touchedTopics: [] });
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it('returns empty result when there are no user messages', async () => {
    const result = await runAutoMemoryExtractionByAgent(
      mockConfig,
      '/tmp/project',
      [{ offset: 0, role: 'model', text: 'Sure!' }],
    );
    expect(result).toEqual({ patches: [], touchedTopics: [] });
    expect(runForkedAgent).not.toHaveBeenCalled();
  });
});
