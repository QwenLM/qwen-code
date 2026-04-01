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
import { getAutoMemoryTopicPath } from './paths.js';
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

  it('returns validated rewrites from the background agent', async () => {
    await fs.writeFile(
      getAutoMemoryTopicPath(projectRoot, 'user'),
      [
        '---',
        'type: user',
        'title: User Memory',
        'description: User profile',
        '---',
        '',
        '# User Memory',
        '',
        '- User prefers terse responses.',
        '- User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );

    const runner = {
      run: vi.fn().mockResolvedValue({
        taskId: 'task-1',
        status: 'completed',
        finalText: JSON.stringify({
          rewrites: [
            {
              topic: 'user',
              body: '# User Memory\n\n- User prefers terse responses.',
            },
          ],
        }),
        filesTouched: [],
      }),
    };

    const rewrites = await planManagedAutoMemoryDreamByAgent(
      config,
      projectRoot,
      runner,
    );

    expect(rewrites).toEqual([
      {
        topic: 'user',
        body: '# User Memory\n\n- User prefers terse responses.',
      },
    ]);
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        sessionId: 'session-1',
        toolConfig: { tools: [] },
      }),
    );
  });

  it('rejects invalid agent output', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        taskId: 'task-2',
        status: 'completed',
        finalText: JSON.stringify({
          rewrites: [
            {
              topic: 'user',
              body: '   ',
            },
          ],
        }),
        filesTouched: [],
      }),
    };

    await expect(
      planManagedAutoMemoryDreamByAgent(config, projectRoot, runner),
    ).rejects.toThrow('Invalid dream agent response: empty body');
  });
});
