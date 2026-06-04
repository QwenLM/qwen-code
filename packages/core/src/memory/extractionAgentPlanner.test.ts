/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { runForkedAgent, getCacheSafeParams } from '../utils/forkedAgent.js';

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn(),
  };
});

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getAutoMemoryRoot: vi.fn().mockReturnValue('/tmp/auto-memory'),
    getUserAutoMemoryRoot: vi.fn().mockReturnValue('/tmp/user-memory'),
  };
});

vi.mock('../utils/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
  getCacheSafeParams: vi.fn(),
}));

describe('runAutoMemoryExtractionByAgent', () => {
  const mockConfig = {
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    getApprovalMode: vi.fn(),
  } as unknown as Config;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ],
      model: 'qwen3-coder-plus',
      version: 1,
    });
    vi.mocked(scanAutoMemoryTopicDocuments).mockResolvedValue([
      {
        type: 'user',
        filePath: '/tmp/auto-memory/user/prefs.md',
        relativePath: 'user/prefs.md',
        filename: 'prefs.md',
        title: 'User Memory',
        description: 'User preferences',
        body: '- Existing terse preference.',
        mtimeMs: 1,
      },
    ]);
  });

  it('derives touchedTopics from filesTouched and returns systemMessage', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: ['/tmp/auto-memory/user/prefs.md'],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');

    expect(result).toEqual({
      touchedTopics: ['user'],
      touchedProjectScope: true,
      touchedUserScope: false,
      systemMessage: 'Managed auto-memory updated: user.md',
    });
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          'read_file',
          'grep_search',
          'glob',
          'list_directory',
          'run_shell_command',
          'write_file',
          'edit',
        ],
        maxTurns: 5,
        maxTimeMinutes: 2,
      }),
    );
  });

  it('returns empty touchedTopics when agent touches no files', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result).toEqual({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      systemMessage: undefined,
    });
  });

  it('throws when getCacheSafeParams returns null', async () => {
    vi.mocked(getCacheSafeParams).mockReturnValue(null);
    await expect(
      runAutoMemoryExtractionByAgent(mockConfig, '/tmp'),
    ).rejects.toThrow('no cache-safe params');
  });

  it('throws when the agent fails to complete', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'timeout',
      filesTouched: [],
    });

    await expect(
      runAutoMemoryExtractionByAgent(mockConfig, '/tmp/project'),
    ).rejects.toThrow('timeout');
  });

  it('ignores non-memory file paths in filesTouched', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/auto-memory/project/arch.md',
        '/tmp/auto-memory/reference/api.md',
        '/tmp/some/other/file.ts',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['project', 'reference']),
    );
    expect(result.touchedTopics).not.toContain('user');
    expect(result.touchedProjectScope).toBe(true);
    expect(result.touchedUserScope).toBe(false);
  });

  it('attributes user-rooted writes to the user scope (not project)', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/user-memory/user/role.md',
        '/tmp/user-memory/feedback/terse.md',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['user', 'feedback']),
    );
    expect(result.touchedUserScope).toBe(true);
    expect(result.touchedProjectScope).toBe(false);
  });

  it('reports both scopes when the agent writes to both roots in one run', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [
        '/tmp/user-memory/user/role.md',
        '/tmp/auto-memory/project/release.md',
      ],
    });

    const result = await runAutoMemoryExtractionByAgent(mockConfig, '/tmp');
    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['user', 'project']),
    );
    expect(result.touchedProjectScope).toBe(true);
    expect(result.touchedUserScope).toBe(true);
  });
});
