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
      status: 'success',
      roundsAttempted: 1,
      attemptId: 'attempt-1',
      recordPath: '/tmp/result.json',
      branch: 'self-evolve/review',
      commitSha: 'abc123',
      summary: 'Prepared a small improvement.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      selectedTaskSource: 'lint-error',
      selectedTaskLocation: 'src/file.ts:10:2',
      selectedTaskRationale:
        'It was the smallest verifiable fix that matched the brief.',
      direction: 'focus lint and tests around the CLI',
      validation: ['pass: npm run lint'],
      changedFiles: ['src/file.ts'],
    });

    await selfEvolveCommand.action!(
      mockContext,
      'focus lint and tests around the CLI',
    );

    expect(mockRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: 'focus lint and tests around the CLI',
      }),
    );
    expect(cronCreate).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining(
          'Requested direction: focus lint and tests around the CLI',
        ),
      }),
      expect.any(Number),
    );
  });

  it('streams child activity updates into the interactive UI while self-evolve runs', async () => {
    mockRun.mockImplementation(async (_config, options) => {
      options.onProgress?.({
        stage: 'discovering_candidates',
        message: 'Discovering candidates...',
      });
      options.onProgress?.({
        stage: 'child_activity',
        message: 'Child round 1 [command]: Running npm run lint',
        round: 1,
        command: 'npm run lint',
      });
      return {
        ok: true,
        status: 'success',
        roundsAttempted: 1,
        attemptId: 'attempt-stream',
        recordPath: '/tmp/result.json',
        branch: 'self-evolve/review',
        commitSha: 'stream123',
        summary: 'Prepared a small improvement.',
        selectedTask: 'Fix lint error in src/file.ts:10:2',
        selectedTaskSource: 'lint-error',
        selectedTaskLocation: 'src/file.ts:10:2',
        direction: 'focus lint cleanup',
        validation: ['passed: npm run lint'],
        changedFiles: ['src/file.ts'],
      };
    });

    await selfEvolveCommand.action!(mockContext, 'focus lint cleanup');

    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: 'Inspecting the repo for small safe tasks...',
      }),
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: 'Child round 1 [command]: Running npm run lint',
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
      status: 'success',
      roundsAttempted: 2,
      attemptId: 'attempt-2',
      recordPath: '/tmp/result.json',
      branch: 'self-evolve/review',
      commitSha: 'def456',
      summary: 'Prepared a small improvement.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      selectedTaskSource: 'lint-error',
      selectedTaskLocation: 'src/file.ts:10:2',
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
    expect(mockRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: 'focus lint cleanup',
      }),
    );
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
      content: expect.stringContaining(
        'Cadence: Every 2 hours (`0 */2 * * *`)',
      ),
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('Rounded from 90m to every 2 hours.'),
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining(
        'Requested direction: focus lint cleanup',
      ),
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining(
        'Each run will narrow that brief into one small safe, verifiable change before editing.',
      ),
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
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining(
          'Requested direction: focus lint cleanup',
        ),
      }),
      expect.any(Number),
    );
    expect(mockRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: 'focus lint cleanup',
      }),
    );

    resolveRun?.({
      ok: true,
      status: 'success',
      roundsAttempted: 3,
      attemptId: 'attempt-bg',
      recordPath: '/tmp/result.json',
      branch: 'self-evolve/review',
      commitSha: 'bg123',
      summary: 'Prepared a small improvement.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      selectedTaskSource: 'lint-error',
      selectedTaskLocation: 'src/file.ts:10:2',
      direction: 'focus lint cleanup',
      validation: ['pass: npm run lint'],
      changedFiles: ['src/file.ts'],
    });

    await vi.waitFor(() => {
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining(
            'Background self-evolve attempt prepared a reviewable change.',
          ),
        }),
        expect.any(Number),
      );
    });
  });

  it('labels background no-safe-task attempts as skipped', async () => {
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

    resolveRun?.({
      ok: false,
      status: 'no_safe_task',
      roundsAttempted: 0,
      attemptId: 'attempt-bg-skip',
      recordPath: '/tmp/result.json',
      summary:
        'The requested direction could not be narrowed into a small safe change.',
      direction: 'focus lint cleanup',
      learnings: ['The brief stayed too broad for a safe one-shot edit.'],
    });

    await vi.waitFor(() => {
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining(
            'Background self-evolve attempt skipped this round.',
          ),
        }),
        expect.any(Number),
      );
    });
  });

  it('surfaces discarded background attempts as info instead of errors', async () => {
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

    resolveRun?.({
      ok: false,
      status: 'max_retries_exhausted',
      roundsAttempted: 5,
      attemptId: 'attempt-bg-failed',
      recordPath: '/tmp/result.json',
      summary:
        'The isolated self-evolve change was discarded after 5 unsuccessful validation rounds.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      selectedTaskSource: 'lint-error',
      selectedTaskLocation: 'src/file.ts:10:2',
      direction: 'focus lint cleanup',
      validation: ['fail: npm run lint'],
      learnings: ['Validation failed: npm run lint'],
    });

    await vi.waitFor(() => {
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining(
            'Background self-evolve attempt rolled back its trial change.',
          ),
        }),
        expect.any(Number),
      );
    });
  });

  it('shows background failures as informative follow-ups with the chosen path', async () => {
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

    resolveRun?.({
      ok: false,
      status: 'failed',
      roundsAttempted: 1,
      attemptId: 'attempt-bg-hard-fail',
      recordPath: '/tmp/result.json',
      summary:
        'The isolated self-evolve change did not provide a rerunnable validation command.',
      selectedTask: 'Advance user direction: focus lint cleanup',
      selectedTaskSource: 'user-direction',
      selectedTaskLocation: 'packages/cli/src/ui/commands/selfEvolveCommand.ts',
      selectedTaskRationale:
        'Narrowed the brief to the scheduling confirmation copy and result summary.',
      direction: 'focus lint cleanup',
      learnings: [
        'The child run finished without reporting a safe validation command.',
      ],
    });

    await vi.waitFor(() => {
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining(
            'Background self-evolve attempt stopped before a safe change was ready.',
          ),
        }),
        expect.any(Number),
      );
    });

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining(
          'Narrowed direction: Narrowed the brief to the scheduling confirmation copy and result summary.',
        ),
      }),
      expect.any(Number),
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining(
          'Validation: None reported by the child run.',
        ),
      }),
      expect.any(Number),
    );
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
        'Scheduled self-evolve jobs:\n\njob1  `*/5 * * * *`\nPrompt: /self-evolve --once',
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
