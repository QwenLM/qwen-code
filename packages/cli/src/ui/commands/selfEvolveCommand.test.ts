/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from './types.js';
import { selfEvolveCommand } from './selfEvolveCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { SelfEvolveService } from '../../services/SelfEvolveService.js';

vi.mock('../../services/SelfEvolveService.js', () => ({
  SelfEvolveService: vi.fn(),
}));

describe('selfEvolveCommand', () => {
  let mockContext: CommandContext;
  const mockRun = vi.fn();
  const cronCreate = vi.fn();
  const cronList = vi.fn();
  const cronDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SelfEvolveService).mockImplementation(
      () =>
        ({
          run: mockRun,
        }) as unknown as SelfEvolveService,
    );

    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      services: {
        config: {
          getProjectRoot: () => '/repo',
          isCronEnabled: () => true,
          getCronScheduler: () => ({
            create: cronCreate,
            list: cronList,
            delete: cronDelete,
          }),
        },
      },
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  describe('completion', () => {
    it('suggests common self-evolve argument forms for an empty query', async () => {
      await expect(
        selfEvolveCommand.completion?.(mockContext, ''),
      ).resolves.toEqual([
        {
          value: '--once',
          description:
            'Run once now. This is the default if you omit schedule flags.',
        },
        {
          value: '--every',
          description:
            'Run now and then repeat on a schedule, for example `--every 2h`.',
        },
        {
          value: 'list',
          description:
            'Show scheduled recurring self-evolve jobs for this session.',
        },
        {
          value: 'clear',
          description:
            'Delete all scheduled recurring self-evolve jobs for this session.',
        },
      ]);
    });

    it('filters suggestions by prefix', async () => {
      await expect(
        selfEvolveCommand.completion?.(mockContext, '--e'),
      ).resolves.toEqual([
        {
          value: '--every',
          description:
            'Run now and then repeat on a schedule, for example `--every 2h`.',
        },
      ]);
      await expect(
        selfEvolveCommand.completion?.(mockContext, 'cl'),
      ).resolves.toEqual([
        {
          value: 'clear',
          description:
            'Delete all scheduled recurring self-evolve jobs for this session.',
        },
      ]);
    });

    it('stops suggesting subcommands after free-form direction text starts', async () => {
      await expect(
        selfEvolveCommand.completion?.(mockContext, 'focus lint'),
      ).resolves.toEqual([]);
    });
  });

  it('runs one-shot self-evolve with free-form direction text', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      attemptId: 'attempt-1',
      recordPath: '/tmp/result.json',
      branch: 'self-evolve/review',
      commitSha: 'abc123',
      summary: 'Prepared a small improvement.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      direction: 'focus lint and tests around the CLI',
      validation: ['pass: npm run lint'],
      changedFiles: ['src/file.ts'],
    });

    await selfEvolveCommand.action!(
      mockContext,
      'focus lint and tests around the CLI',
    );

    expect(mockRun).toHaveBeenCalledWith(expect.anything(), {
      direction: 'focus lint and tests around the CLI',
    });
    expect(cronCreate).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining(
          'Direction: focus lint and tests around the CLI',
        ),
      }),
      expect.any(Number),
    );
  });

  it('describes the default run-once behavior in the command metadata', () => {
    expect(selfEvolveCommand.description).toContain('once by default');
    expect(selfEvolveCommand.argumentHint).toContain('--every <interval>');
    expect(selfEvolveCommand.examples).toContain('/self-evolve');
  });

  it('schedules recurring self-evolve and runs the first attempt immediately', async () => {
    cronCreate.mockReturnValue({
      id: 'job12345',
      cronExpr: '0 */2 * * *',
      prompt: '/self-evolve --once --direction focus lint cleanup',
    });
    mockRun.mockResolvedValue({
      ok: true,
      attemptId: 'attempt-2',
      recordPath: '/tmp/result.json',
      branch: 'self-evolve/review',
      commitSha: 'def456',
      summary: 'Prepared a small improvement.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      direction: 'focus lint cleanup',
      validation: ['pass: npm run lint'],
      changedFiles: ['src/file.ts'],
    });

    const result = await selfEvolveCommand.action!(
      {
        ...mockContext,
        executionMode: 'non_interactive',
      },
      '--every 90m focus lint cleanup',
    );

    expect(cronCreate).toHaveBeenCalledWith(
      '0 */2 * * *',
      '/self-evolve --once --direction focus lint cleanup',
      true,
    );
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), {
      direction: 'focus lint cleanup',
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining(
        'Scheduled recurring self-evolve job job12345.',
      ),
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('Rounded from 90m to every 2 hours.'),
    });
  });

  it('runs the first scheduled self-evolve attempt in the background for interactive mode', async () => {
    cronCreate.mockReturnValue({
      id: 'job12345',
      cronExpr: '0 */2 * * *',
      prompt: '/self-evolve --once --direction focus lint cleanup',
    });

    let resolveRun:
      | ((value: Awaited<ReturnType<SelfEvolveService['run']>>) => void)
      | undefined;
    mockRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    await expect(
      selfEvolveCommand.action!(mockContext, '--every 2h focus lint cleanup'),
    ).resolves.toBeUndefined();

    expect(mockContext.ui.setPendingItem).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining(
          'Running the first self-evolve attempt in the background.',
        ),
      }),
      expect.any(Number),
    );
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), {
      direction: 'focus lint cleanup',
    });

    resolveRun?.({
      ok: true,
      attemptId: 'attempt-bg',
      recordPath: '/tmp/result.json',
      branch: 'self-evolve/review',
      commitSha: 'bg123',
      summary: 'Prepared a small improvement.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      direction: 'focus lint cleanup',
      validation: ['pass: npm run lint'],
      changedFiles: ['src/file.ts'],
    });

    await vi.waitFor(() => {
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining(
            'Background self-evolve attempt finished.',
          ),
        }),
        expect.any(Number),
      );
    });
  });

  it('returns usage error for invalid flag combinations', async () => {
    const result = await selfEvolveCommand.action!(
      mockContext,
      '--once --every 1h',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Usage: /self-evolve'),
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('lists only scheduled self-evolve jobs', async () => {
    cronList.mockReturnValue([
      {
        id: 'job1',
        cronExpr: '*/5 * * * *',
        prompt: '/self-evolve --once',
      },
      {
        id: 'job2',
        cronExpr: '*/5 * * * *',
        prompt: '/loop 5m check the build',
      },
    ]);

    const result = await selfEvolveCommand.action!(
      {
        ...mockContext,
        executionMode: 'non_interactive',
      },
      'list',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Scheduled self-evolve jobs:\n\njob1  */5 * * * *\nPrompt: /self-evolve --once',
    });
  });

  it('clears scheduled self-evolve jobs only', async () => {
    cronList.mockReturnValue([
      {
        id: 'job1',
        cronExpr: '*/5 * * * *',
        prompt: '/self-evolve --once',
      },
      {
        id: 'job2',
        cronExpr: '0 */2 * * *',
        prompt: '/self-evolve --once --direction focus docs',
      },
      {
        id: 'job3',
        cronExpr: '*/5 * * * *',
        prompt: '/loop 5m check the build',
      },
    ]);

    const result = await selfEvolveCommand.action!(
      {
        ...mockContext,
        executionMode: 'non_interactive',
      },
      'clear',
    );

    expect(cronDelete).toHaveBeenCalledTimes(2);
    expect(cronDelete).toHaveBeenNthCalledWith(1, 'job1');
    expect(cronDelete).toHaveBeenNthCalledWith(2, 'job2');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Cleared 2 scheduled self-evolve jobs.',
    });
  });

  it('errors when recurring mode is requested without cron support', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {
          getProjectRoot: () => '/repo',
          isCronEnabled: () => false,
        },
      },
    } as unknown as CommandContext);

    const result = await selfEvolveCommand.action!(
      mockContext,
      '--every 2h focus docs',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining(
        'Recurring /self-evolve requires cron support.',
      ),
    });
    expect(mockRun).not.toHaveBeenCalled();
  });
});
