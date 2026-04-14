/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { ForkedAgentResult } from '../background/forkedAgent.js';
import { runForkedAgent } from '../background/forkedAgent.js';
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { ensureAutoMemoryScaffold } from './store.js';

vi.mock('../background/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
}));

describe('dreamAgentPlanner', () => {
  let tempDir: string;
  let projectRoot: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'auto-memory-dream-agent-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    config = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getModel: vi.fn().mockReturnValue('qwen-test'),
      getApprovalMode: vi.fn(),
    } as unknown as Config;
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('returns the forked agent result', async () => {
    const mockResult: ForkedAgentResult = {
      status: 'completed',
      finalText: 'Merged 2 duplicate Vim entries into prefers-vim.md.',
      filesTouched: [
        path.join(projectRoot, '.qwen', 'memory', 'user', 'prefers-vim.md'),
      ],
    };

    vi.mocked(runForkedAgent).mockResolvedValue(mockResult);

    const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot);

    expect(result).toBe(mockResult);
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 8,
        maxTimeMinutes: 5,
        tools: [
          'read_file',
          'grep_search',
          'glob',
          'list_directory',
          'run_shell_command',
          'write_file',
          'edit',
        ],
      }),
    );
  });

  it('throws when the agent fails', async () => {
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'failed',
      terminateReason: 'Model timed out',
      filesTouched: [],
    } satisfies ForkedAgentResult);

    await expect(
      planManagedAutoMemoryDreamByAgent(config, projectRoot),
    ).rejects.toThrow('Model timed out');
  });

  it('returns cancelled result without throwing', async () => {
    const mockResult: ForkedAgentResult = {
      status: 'cancelled',
      filesTouched: [],
    };

    vi.mocked(runForkedAgent).mockResolvedValue(mockResult);

    const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot);
    expect(result.status).toBe('cancelled');
    expect(result.filesTouched).toHaveLength(0);
  });
});
