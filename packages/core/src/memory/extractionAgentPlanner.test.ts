/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn(),
  };
});

describe('runAutoMemoryExtractionByAgent', () => {
  const mockConfig = {
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
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
    const runner = {
      run: vi.fn().mockResolvedValue({
        taskId: 'task-1',
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
      }),
    };

    const result = await runAutoMemoryExtractionByAgent(
      mockConfig,
      '/tmp/project',
      [{ offset: 0, role: 'user', text: 'I prefer terse responses.' }],
      runner,
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
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        toolConfig: {
          tools: [
            'read_file',
            'write_file',
            'edit',
            'list_directory',
            'glob',
            'grep_search',
          ],
        },
        runConfig: expect.objectContaining({
          max_turns: 5,
          max_time_minutes: 2,
        }),
      }),
    );
  });
});
