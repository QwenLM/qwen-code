/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import type { LoadedSettings } from './config/settings.js';
import { CommandService } from './services/CommandService.js';
import { CommandKind, type SlashCommand } from './ui/commands/types.js';
import { handleSlashCommand } from './nonInteractiveCliCommands.js';
import { renameCommand } from './ui/commands/renameCommand.js';

vi.mock('./startup/startupModePolicy.js', () => ({
  waitForCommandCatalogReady: vi.fn(),
  waitForSlashCommandReady: vi.fn(),
}));

describe('handleSlashCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executes a nested command with its leaf invocation identity', async () => {
    const action = vi.fn(async () => ({
      type: 'submit_prompt' as const,
      content: 'goal prompt',
    }));
    const commands: readonly SlashCommand[] = [
      {
        name: 'goal',
        description: 'Manage goals',
        kind: CommandKind.BUILT_IN,
        subCommands: [
          {
            name: 'set',
            description: 'Set a goal',
            kind: CommandKind.BUILT_IN,
            takesArgs: true,
            action,
          },
        ],
      },
    ];
    vi.spyOn(CommandService, 'create').mockResolvedValue({
      getCommands: () => commands,
    } as CommandService);
    const config = {
      getSessionId: () => 'nested-command-session',
    } as unknown as Config;

    const result = await handleSlashCommand(
      '/goal set demo',
      new AbortController(),
      config,
      {} as LoadedSettings,
    );

    expect(result).toMatchObject({ type: 'query', content: 'goal prompt' });
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: {
          raw: '/goal set demo',
          name: 'set',
          args: 'demo',
        },
      }),
      'demo',
    );
    expect(result).toMatchObject({
      type: 'query',
      content: 'goal prompt',
      commandInvocationId: expect.any(String),
    });
  });

  it('returns empty direct output when the parent aborts a command action', async () => {
    let started: (() => void) | undefined;
    const action = vi.fn(
      async (context) =>
        new Promise<void>((resolve) => {
          started = () => {
            context.abortSignal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          };
          started();
        }),
    );
    const commands: readonly SlashCommand[] = [
      {
        name: 'claim',
        description: 'Run extension command',
        kind: CommandKind.DYNAMIC,
        action,
      },
    ];
    vi.spyOn(CommandService, 'create').mockResolvedValue({
      getCommands: () => commands,
    } as CommandService);
    const controller = new AbortController();
    const config = {
      getSessionId: () => 'aborted-command-session',
    } as unknown as Config;

    const resultPromise = handleSlashCommand(
      '/claim',
      controller,
      config,
      {} as LoadedSettings,
    );
    await vi.waitFor(() => expect(started).toBeTypeOf('function'));
    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      type: 'direct_output',
      resultText: '',
    });
  });

  it('treats a matched void action as handled without querying the model', async () => {
    const action = vi.fn(async () => undefined);
    const commands: readonly SlashCommand[] = [
      {
        name: 'pause-local-work',
        description: 'Pause local work',
        kind: CommandKind.BUILT_IN,
        action,
      },
    ];
    vi.spyOn(CommandService, 'create').mockResolvedValue({
      getCommands: () => commands,
    } as CommandService);

    const result = await handleSlashCommand(
      '/pause-local-work',
      new AbortController(),
      { getSessionId: () => 'void-command-session' } as unknown as Config,
      {} as LoadedSettings,
    );

    expect(result).toEqual({ type: 'direct_output', resultText: '' });
    expect(action).toHaveBeenCalledOnce();
  });

  it('returns message actions as direct output', async () => {
    const commands: readonly SlashCommand[] = [
      {
        name: 'local-status',
        description: 'Show local status',
        kind: CommandKind.BUILT_IN,
        action: async () => ({
          type: 'message' as const,
          messageType: 'error' as const,
          content: 'Local status failed',
        }),
      },
    ];
    vi.spyOn(CommandService, 'create').mockResolvedValue({
      getCommands: () => commands,
    } as CommandService);

    const result = await handleSlashCommand(
      '/local-status',
      new AbortController(),
      { getSessionId: () => 'message-command-session' } as unknown as Config,
      {} as LoadedSettings,
    );

    expect(result).toEqual({
      type: 'direct_output',
      resultText: 'Local status failed',
      isError: true,
    });
  });

  it('treats tool actions without a follow-up prompt as handled', async () => {
    const commands: readonly SlashCommand[] = [
      {
        name: 'local-tool',
        description: 'Run a local tool',
        kind: CommandKind.BUILT_IN,
        action: async () => ({
          type: 'tool' as const,
          toolName: 'LocalTool',
          toolArgs: {},
        }),
      },
    ];
    vi.spyOn(CommandService, 'create').mockResolvedValue({
      getCommands: () => commands,
    } as CommandService);

    const result = await handleSlashCommand(
      '/local-tool',
      new AbortController(),
      { getSessionId: () => 'tool-command-session' } as unknown as Config,
      {} as LoadedSettings,
    );

    expect(result).toEqual({ type: 'direct_output', resultText: '' });
  });

  it('does not fall through when a matched parent requires a subcommand', async () => {
    const commands: readonly SlashCommand[] = [
      {
        name: 'parent',
        description: 'Parent command',
        kind: CommandKind.BUILT_IN,
        subCommands: [
          {
            name: 'child',
            description: 'Child command',
            kind: CommandKind.BUILT_IN,
            action: async () => undefined,
          },
        ],
      },
    ];
    vi.spyOn(CommandService, 'create').mockResolvedValue({
      getCommands: () => commands,
    } as CommandService);

    const result = await handleSlashCommand(
      '/parent',
      new AbortController(),
      { getSessionId: () => 'parent-command-session' } as unknown as Config,
      {} as LoadedSettings,
    );

    expect(result).toEqual({
      type: 'direct_output',
      resultText: "Command '/parent' requires a subcommand.",
      isError: true,
    });
  });
  describe('/rename', () => {
    function renameConfig() {
      const persistSessionTitle = vi.fn().mockResolvedValue(undefined);
      const config = {
        getSessionId: () => 'rename-session',
        persistSessionTitle,
        get config() {
          return config;
        },
      };
      return { config: config as unknown as Config, persistSessionTitle };
    }

    beforeEach(() => {
      vi.spyOn(CommandService, 'create').mockResolvedValue({
        getCommands: () => [renameCommand],
      } as unknown as CommandService);
    });

    it('renames with an explicit name', async () => {
      const { config, persistSessionTitle } = renameConfig();

      const result = await handleSlashCommand(
        '/rename foo',
        new AbortController(),
        config,
        {} as LoadedSettings,
      );

      expect(persistSessionTitle).toHaveBeenCalledWith('foo');
      expect(result).toEqual({
        type: 'direct_output',
        resultText: 'Session renamed to: foo',
      });
    });

    it('reports name generation as unavailable without an argument', async () => {
      const { config, persistSessionTitle } = renameConfig();

      const result = await handleSlashCommand(
        '/rename',
        new AbortController(),
        config,
        {} as LoadedSettings,
      );

      expect(persistSessionTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'direct_output',
        resultText:
          'Name generation is not available here. Usage: /rename <name>',
        isError: true,
      });
    });
  });

  describe('unresolved slash input', () => {
    beforeEach(() => {
      vi.spyOn(CommandService, 'create').mockResolvedValue({
        getCommands: () => [
          {
            name: 'security-scan',
            description: 'Scan',
            kind: CommandKind.SKILL,
          },
          {
            name: 'simplify',
            description: 'Simplify',
            kind: CommandKind.SKILL,
          },
          {
            name: 'compact',
            description: 'Compact',
            kind: CommandKind.BUILT_IN,
            hidden: true,
          },
        ],
      } as unknown as CommandService);
    });

    it('falls back to the model with the visible command inventory', async () => {
      const config = {
        getSessionId: () => 'fallback-session',
      } as unknown as Config;

      const result = await handleSlashCommand(
        '/16 总地址65,536，怎么算的',
        new AbortController(),
        config,
        {} as LoadedSettings,
      );

      expect(result).toEqual({
        type: 'unknown_command_fallback',
        commandName: '16',
        availableCommandNames: ['security-scan', 'simplify'],
        availableCommandCount: 2,
      });
    });

    it('suggests the closest command within edit distance two', async () => {
      const config = {
        getSessionId: () => 'fallback-suggestion-session',
      } as unknown as Config;

      const result = await handleSlashCommand(
        '/simplfy',
        new AbortController(),
        config,
        {} as LoadedSettings,
      );

      expect(result).toMatchObject({
        type: 'unknown_command_fallback',
        commandName: 'simplfy',
        suggestion: 'simplify',
      });
    });

    it('still treats path-like input as plain text', async () => {
      const config = {
        getSessionId: () => 'fallback-path-session',
      } as unknown as Config;

      const result = await handleSlashCommand(
        '/etc/hosts is unreadable',
        new AbortController(),
        config,
        {} as LoadedSettings,
      );

      expect(result).toBeUndefined();
    });
  });
});
