/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { tasksCommand } from './tasksCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { BackgroundShellEntry } from '@qwen-code/qwen-code-core';

function entry(
  overrides: Partial<BackgroundShellEntry> = {},
): BackgroundShellEntry {
  return {
    shellId: 'bg_aaaaaaaa',
    command: 'sleep 60',
    cwd: '/tmp',
    status: 'running',
    startTime: Date.now() - 5_000,
    outputPath: '/tmp/tasks/sess/shell-bg_aaaaaaaa.output',
    abortController: new AbortController(),
    ...overrides,
  };
}

describe('tasksCommand', () => {
  let context: CommandContext;
  let getAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getAll = vi.fn().mockReturnValue([]);
    context = createMockCommandContext({
      services: {
        config: {
          getBackgroundShellRegistry: () => ({ getAll }),
        },
      },
    } as unknown as Parameters<typeof createMockCommandContext>[0]);
  });

  it('reports an empty registry', async () => {
    const result = await tasksCommand.action!(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No background shells.',
    });
  });

  it('lists running and terminal entries with status / runtime / output path', async () => {
    getAll.mockReturnValue([
      entry({
        shellId: 'bg_run',
        command: 'npm run dev',
        status: 'running',
        startTime: Date.now() - 12_000,
        pid: 1111,
      }),
      entry({
        shellId: 'bg_done',
        command: 'npm test',
        status: 'completed',
        exitCode: 0,
        startTime: Date.now() - 70_000,
        endTime: Date.now() - 5_000,
        outputPath: '/tmp/tasks/sess/shell-bg_done.output',
      }),
      entry({
        shellId: 'bg_fail',
        command: 'flaky.sh',
        status: 'failed',
        error: 'spawn ENOENT',
        startTime: Date.now() - 3_000,
        endTime: Date.now() - 2_000,
      }),
    ]);

    const result = await tasksCommand.action!(context, '');
    if (!result || result.type !== 'message') {
      throw new Error('expected message result');
    }
    expect(result.content).toContain('Background shells (3 total)');
    expect(result.content).toContain('[bg_run] running');
    expect(result.content).toContain('pid=1111');
    expect(result.content).toContain('npm run dev');
    expect(result.content).toContain('[bg_done] completed (exit 0)');
    expect(result.content).toContain('[bg_fail] failed: spawn ENOENT');
    expect(result.content).toContain(
      'output: /tmp/tasks/sess/shell-bg_done.output',
    );
  });
});
