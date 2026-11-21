/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { describe, expect, it, vi } from 'vitest';
import { memoryCommand } from './memoryCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

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

  it('advertises the explicit show and team migration subcommands', () => {
    expect(memoryCommand.argumentHint).toBe('[show|migrate-team]');
  });

  describe('/memory show', () => {
    it('is registered as a subcommand', () => {
      expect(memoryCommand.subCommands).toBeDefined();
      expect(memoryCommand.subCommands!.map((s) => s.name)).toContain('show');
    });

    it('prints the combined content when memory is loaded', async () => {
      const config = {
        getUserMemory: vi.fn().mockReturnValue('# User memory'),
        getAutoMemoryPrompt: vi.fn().mockReturnValue('Auto-memory prompt'),
        getAutoMemoryContext: vi.fn().mockReturnValue('Auto-memory context'),
        getMemoryFileCount: vi.fn().mockReturnValue(2),
      } as unknown as Config;
      const context = createMockCommandContext({
        executionMode: 'interactive',
        services: { config },
      });
      const show = memoryCommand.subCommands!.find((s) => s.name === 'show')!;

      const result = await show.action?.(context, '');

      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
      const content = (result as { content: string }).content;
      expect(content).toContain('2 context file(s)');
      expect(content).toContain('# User memory');
      expect(content).toContain('Auto-memory prompt');
      expect(content).toContain('Auto-memory context');
      expect(content).toContain('---');
    });

    it('prints the empty state when nothing is loaded', async () => {
      const config = {
        getUserMemory: vi.fn().mockReturnValue(''),
        getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
        getAutoMemoryContext: vi.fn().mockReturnValue(''),
        getMemoryFileCount: vi.fn().mockReturnValue(0),
      } as unknown as Config;
      const context = createMockCommandContext({
        executionMode: 'interactive',
        services: { config },
      });
      const show = memoryCommand.subCommands!.find((s) => s.name === 'show')!;

      const result = await show.action?.(context, '');

      expect((result as { content: string }).content).toContain(
        'No hierarchical memory',
      );
    });

    it('prints the loaded-but-empty state when files exist but content is blank', async () => {
      const config = {
        getUserMemory: vi.fn().mockReturnValue(''),
        getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
        getAutoMemoryContext: vi.fn().mockReturnValue(''),
        getMemoryFileCount: vi.fn().mockReturnValue(1),
      } as unknown as Config;
      const context = createMockCommandContext({
        executionMode: 'interactive',
        services: { config },
      });
      const show = memoryCommand.subCommands!.find((s) => s.name === 'show')!;

      const result = await show.action?.(context, '');

      expect((result as { content: string }).content).toContain(
        'loaded but content is empty',
      );
    });

    it('returns an error when config is not loaded', async () => {
      const context = createMockCommandContext({
        executionMode: 'interactive',
        services: { config: null },
      });
      const show = memoryCommand.subCommands!.find((s) => s.name === 'show')!;

      const result = await show.action?.(context, '');

      expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    });

    it('handles missing getAutoMemoryContext gracefully', async () => {
      const config = {
        getUserMemory: vi.fn().mockReturnValue('# User memory'),
        getAutoMemoryPrompt: vi.fn().mockReturnValue('Prompt'),
        getMemoryFileCount: vi.fn().mockReturnValue(1),
      } as unknown as Config;
      const context = createMockCommandContext({
        executionMode: 'interactive',
        services: { config },
      });
      const show = memoryCommand.subCommands!.find((s) => s.name === 'show')!;

      const result = await show.action?.(context, '');

      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
      const content = (result as { content: string }).content;
      expect(content).toContain('# User memory');
      expect(content).toContain('Prompt');
      expect(content).not.toContain('undefined');
    });
  });

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
