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
import type { BackgroundAgentResult } from '../background/backgroundAgentRunner.js';
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { ensureAutoMemoryScaffold } from './store.js';

describe('dreamAgentPlanner', () => {
  let tempDir: string;
  let projectRoot: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-dream-agent-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    config = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getModel: vi.fn().mockReturnValue('qwen-test'),
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

  it('returns the background agent result from the runner', async () => {
    const mockResult: BackgroundAgentResult = {
      taskId: 'task-1',
      status: 'completed',
      finalText: 'Merged 2 duplicate Vim entries into prefers-vim.md.',
      filesTouched: [path.join(projectRoot, '.qwen', 'memory', 'user', 'prefers-vim.md')],
    };

    const runner = {
      run: vi.fn().mockResolvedValue(mockResult),
    };

    const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot, runner);

    expect(result).toBe(mockResult);
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        sessionId: 'session-1',
        runConfig: expect.objectContaining({
          max_turns: 8,
          max_time_minutes: 5,
        }),
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
      }),
    );
  });

  it('throws when the agent fails', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        taskId: 'task-2',
        status: 'failed',
        error: 'Model timed out',
        filesTouched: [],
      } satisfies BackgroundAgentResult),
    };

    await expect(
      planManagedAutoMemoryDreamByAgent(config, projectRoot, runner),
    ).rejects.toThrow('Model timed out');
  });

  it('returns cancelled result without throwing', async () => {
    const mockResult: BackgroundAgentResult = {
      taskId: 'task-3',
      status: 'cancelled',
      filesTouched: [],
    };

    const runner = {
      run: vi.fn().mockResolvedValue(mockResult),
    };

    const result = await planManagedAutoMemoryDreamByAgent(config, projectRoot, runner);
    expect(result.status).toBe('cancelled');
    expect(result.filesTouched).toHaveLength(0);
  });
});
