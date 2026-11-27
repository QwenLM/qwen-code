/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { describe, expect, it, vi } from 'vitest';
import { memoryCommand } from './memoryCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const { prepareMigration, refreshMemory } = vi.hoisted(() => ({
  prepareMigration: vi.fn(),
  refreshMemory: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core/memory/worktree-migration.js', () => ({
  prepareWorktreeMemoryMigration: prepareMigration,
}));
vi.mock('@qwen-code/qwen-code-core/memory/refresh.js', () => ({
  refreshMemoryInstruction: refreshMemory,
}));

describe('memoryCommand', () => {
  it('opens the memory dialog in interactive mode', async () => {
    const context = createMockCommandContext({
      executionMode: 'interactive',
    });

    const result = await memoryCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'memory',
    });
  });

  it('advertises both explicit migration subcommands', () => {
    expect(memoryCommand.argumentHint).toBe(
      '[migrate-team | migrate-worktree <path>]',
    );
  });

  it('asks for one path in ACP before calling the model', async () => {
    const context = createMockCommandContext({ executionMode: 'acp' });
    expect(
      await memoryCommand.action?.(context, 'migrate-worktree'),
    ).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('/memory migrate-worktree <path>'),
    });
    expect(prepareMigration).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'applies the displayed plan only on affirmative confirmation (%s)',
    async (confirmed) => {
      prepareMigration.mockReset();
      refreshMemory.mockClear();
      const apply = vi.fn(async () => {});
      prepareMigration.mockResolvedValue({
        source: '/runtime/projects/-old/memory',
        target: '/runtime/projects/-current/memory',
        topics: [
          {
            filename: 'tests.md',
            summary: 'Record the test command',
            update: false,
          },
        ],
        conflicts: ['Kept the existing build command.'],
        apply,
      });
      const config = {
        isManagedMemoryAvailable: () => true,
        isTrustedFolder: () => true,
        isProvisionalWorkspace: () => false,
        getExecutionEnvironment: () => undefined,
      } as unknown as Config;
      const confirmAction = vi.fn(async () => {
        expect(apply).not.toHaveBeenCalled();
        return confirmed;
      });
      const signal = new AbortController().signal;
      const context = createMockCommandContext({
        executionMode: 'acp',
        services: { config },
        abortSignal: signal,
        confirmAction,
      });

      await memoryCommand.action?.(
        context,
        'migrate-worktree "/worktrees/old checkout"',
      );

      expect(prepareMigration).toHaveBeenCalledExactlyOnceWith(
        config,
        '/worktrees/old checkout',
        signal,
      );
      expect(confirmAction).toHaveBeenCalledExactlyOnceWith(
        'Apply these project memory changes?',
        expect.stringMatching(
          /\/runtime\/projects\/-old\/memory[\s\S]*\/runtime\/projects\/-current\/memory[\s\S]*tests\.md[\s\S]*Kept the existing build command/,
        ),
      );
      expect(apply).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(refreshMemory).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    },
  );

  it('does not start migration in a prompt without a confirmation handler', async () => {
    prepareMigration.mockClear();
    const config = {
      isManagedMemoryAvailable: () => true,
      isTrustedFolder: () => true,
      isProvisionalWorkspace: () => false,
      getExecutionEnvironment: () => undefined,
    } as unknown as Config;
    const context = createMockCommandContext({
      executionMode: 'acp',
      services: { config },
      abortSignal: new AbortController().signal,
    });
    expect(
      await memoryCommand.action?.(context, 'migrate-worktree /old'),
    ).toMatchObject({
      type: 'message',
      messageType: 'warning',
    });
    expect(prepareMigration).not.toHaveBeenCalled();
  });

  it('shows conflicts for a no-change result without requesting approval', async () => {
    const apply = vi.fn();
    prepareMigration.mockResolvedValue({
      topics: [],
      conflicts: ['The source conflicts with the current test command.'],
      apply,
    });
    const config = {
      isManagedMemoryAvailable: () => true,
      isTrustedFolder: () => true,
      isProvisionalWorkspace: () => false,
      getExecutionEnvironment: () => undefined,
    } as unknown as Config;
    const confirmAction = vi.fn();
    const context = createMockCommandContext({
      services: { config },
      abortSignal: new AbortController().signal,
      confirmAction,
    });
    expect(
      await memoryCommand.action?.(context, 'migrate-worktree /old'),
    ).toMatchObject({
      type: 'message',
      content: expect.stringContaining(
        'conflicts with the current test command',
      ),
    });
    expect(confirmAction).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ['acp', 'warning'],
    ['interactive', 'error'],
  ] as const)(
    'surfaces a stale target conflict in %s',
    async (executionMode, messageType) => {
      prepareMigration.mockResolvedValue({
        source: '/old/memory',
        target: '/project/memory',
        topics: [
          {
            filename: 'checks.md',
            summary: 'Update project checks.',
            update: true,
          },
        ],
        conflicts: [],
        apply: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('stale'), { code: 'ESTALE' }),
          ),
      });
      const confirmAction = vi.fn(async () => true);
      const context = createMockCommandContext({
        executionMode,
        services: {
          config: {
            isManagedMemoryAvailable: () => true,
            isTrustedFolder: () => true,
            isProvisionalWorkspace: () => false,
            getExecutionEnvironment: () => undefined,
          },
        },
        abortSignal: new AbortController().signal,
        confirmAction,
      });
      expect(
        await memoryCommand.action?.(context, 'migrate-worktree /old'),
      ).toMatchObject({
        type: 'message',
        messageType,
        content: expect.stringContaining('Project memory conflict'),
      });
      const addItem = vi.mocked(context.ui.addItem);
      if (executionMode === 'interactive') {
        expect(addItem).toHaveBeenCalledWith(
          { type: 'info', text: expect.stringContaining('Update checks.md') },
          expect.any(Number),
        );
        expect(addItem.mock.invocationCallOrder[0]).toBeLessThan(
          confirmAction.mock.invocationCallOrder[0]!,
        );
      } else {
        expect(addItem).not.toHaveBeenCalled();
      }
    },
  );

  it('starts team migration only from the explicit subcommand', async () => {
    const scheduleMetadataMigration = vi.fn().mockResolvedValue({
      status: 'scheduled',
      taskId: 'migration-1',
    });
    const config = {
      getTeamMemoryEnabled: vi.fn().mockReturnValue(true),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getProjectRoot: vi.fn().mockReturnValue('/project'),
      getMemoryManager: vi.fn().mockReturnValue({
        scheduleMetadataMigration,
      }),
    } as unknown as Config;
    const context = createMockCommandContext({
      executionMode: 'interactive',
      services: { config },
    });

    const result = await memoryCommand.action?.(context, 'migrate-team');

    expect(scheduleMetadataMigration).toHaveBeenCalledWith({
      projectRoot: '/project',
      scope: 'team',
      config,
    });
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
  });

  it.each([
    ['disabled team memory', false, true],
    ['an untrusted folder', true, false],
  ])('rejects team migration with %s', async (_label, enabled, trusted) => {
    const scheduleMetadataMigration = vi.fn();
    const config = {
      getTeamMemoryEnabled: vi.fn().mockReturnValue(enabled),
      isTrustedFolder: vi.fn().mockReturnValue(trusted),
      getMemoryManager: vi.fn().mockReturnValue({
        scheduleMetadataMigration,
      }),
    } as unknown as Config;
    const context = createMockCommandContext({
      executionMode: 'interactive',
      services: { config },
    });

    const result = await memoryCommand.action?.(context, 'migrate-team');

    expect(scheduleMetadataMigration).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
  });
});
