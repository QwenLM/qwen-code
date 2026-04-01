/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { planAutoMemoryExtractionPatchesByAgent } from './extractionAgentPlanner.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn(),
  };
});

describe('planAutoMemoryExtractionPatchesByAgent', () => {
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
        title: 'User Memory',
        description: 'User preferences',
        body: '- Existing terse preference.',
      },
    ]);
  });

  it('returns parsed patches from BackgroundAgentRunner output', async () => {
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
        }),
        filesTouched: [],
      }),
    };

    const patches = await planAutoMemoryExtractionPatchesByAgent(
      mockConfig,
      '/tmp/project',
      [{ offset: 0, role: 'user', text: 'I prefer terse responses.' }],
      runner,
    );

    expect(patches).toEqual([
      {
        topic: 'user',
        summary: 'User prefers terse responses.',
        sourceOffset: 0,
      },
    ]);
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'managed-auto-memory-extraction-agent',
        sessionId: 'session-1',
      }),
    );
  });

  it('returns empty list when there are no user messages', async () => {
    const runner = { run: vi.fn() };
    await expect(
      planAutoMemoryExtractionPatchesByAgent(
        mockConfig,
        '/tmp/project',
        [{ offset: 0, role: 'model', text: 'hello' }],
        runner,
      ),
    ).resolves.toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('throws when the agent returns invalid source offsets', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        taskId: 'task-1',
        status: 'completed',
        finalText: JSON.stringify({
          patches: [
            {
              topic: 'user',
              summary: 'User prefers terse responses.',
              sourceOffset: 99,
            },
          ],
        }),
        filesTouched: [],
      }),
    };

    await expect(
      planAutoMemoryExtractionPatchesByAgent(
        mockConfig,
        '/tmp/project',
        [{ offset: 0, role: 'user', text: 'I prefer terse responses.' }],
        runner,
      ),
    ).rejects.toThrow('Invalid extraction agent response: invalid sourceOffset');
  });
});
