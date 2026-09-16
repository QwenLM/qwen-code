/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { hooksCommand } from './hooksCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

import { SettingScope } from '../../config/settings.js';

describe('hooksCommand', () => {
  let mockContext: ReturnType<typeof createMockCommandContext>;
  let mockConfig: {
    getHookSystem: ReturnType<typeof vi.fn>;
    setHooksFromSettings: ReturnType<typeof vi.fn>;
    getBareMode: ReturnType<typeof vi.fn>;
    isSafeMode: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      setHooksFromSettings: vi.fn(),
      getBareMode: vi.fn().mockReturnValue(false),
      isSafeMode: vi.fn().mockReturnValue(false),
      getHookSystem: vi.fn().mockReturnValue({
        reload: vi.fn().mockResolvedValue(undefined),
        getRegistry: vi.fn().mockReturnValue({
          getAllHooks: vi.fn().mockReturnValue([]),
        }),
      }),
    };

    mockContext = createMockCommandContext({
      services: {
        config: mockConfig,
        settings: {
          merged: {},
          reloadScopesFromDiskAtomically: vi.fn().mockReturnValue(true),
          getUserHooks: vi.fn(),
          getProjectHooks: vi.fn(),
        },
      },
    });
  });

  it('opts in to running during streaming', () => {
    expect(hooksCommand.canRunDuringStreaming).toBe(true);
  });

  describe('basic functionality', () => {
    it('should open hooks management dialog in interactive mode', async () => {
      const result = await hooksCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
      expect(
        mockContext.services.settings.reloadScopesFromDiskAtomically,
      ).toHaveBeenCalledWith([SettingScope.User, SettingScope.Workspace]);
      expect(mockConfig.setHooksFromSettings).toHaveBeenCalledTimes(1);
      expect(mockConfig.getHookSystem().reload).toHaveBeenCalledTimes(1);
      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    });

    it('should open hooks management dialog even if config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: {
          config: null,
        },
      });

      const result = await hooksCommand.action!(contextWithoutConfig, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });

    it('should open hooks management dialog even if hook system is not available', async () => {
      mockConfig.getHookSystem = vi.fn().mockReturnValue(null);

      const result = await hooksCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });
  });

  describe('reload when the menu opens', () => {
    const mergedHooks = { Stop: [] as [] };
    const userHooks = { PreToolUse: [] };
    const projectHooks = { PostToolUse: [] };

    function makeReloadContext(
      opts: {
        executionMode?: 'interactive' | 'non_interactive';
        safeMode?: boolean;
        bareMode?: boolean;
        hookSystem?: 'none';
      } = {},
    ) {
      const hookSystem = {
        getAllHooks: vi.fn().mockReturnValue([]),
        reload: vi.fn().mockResolvedValue(undefined),
        getRegistry: vi.fn().mockReturnValue({
          getAllHooks: vi.fn().mockReturnValue([]),
        }),
        getSessionHooksManager: vi.fn().mockReturnValue({
          getAllSessionHooks: vi.fn().mockReturnValue([]),
        }),
      };
      const config = {
        getHookSystem: vi
          .fn()
          .mockReturnValue(opts.hookSystem === 'none' ? undefined : hookSystem),
        setHooksFromSettings: vi.fn(),
        getBareMode: vi.fn().mockReturnValue(opts.bareMode ?? false),
        isSafeMode: vi.fn().mockReturnValue(opts.safeMode ?? false),
        getWorkingDir: vi.fn().mockReturnValue('/work/dir'),
        getSessionId: vi.fn().mockReturnValue('session-1'),
        getDisableAllHooks: () => false,
        getExtensions: () => [],
      };
      const context = createMockCommandContext({
        executionMode: opts.executionMode ?? 'interactive',
        services: {
          config,
          settings: {
            merged: { hooks: mergedHooks },
            reloadScopesFromDiskAtomically: vi.fn().mockReturnValue(true),
            getUserHooks: () => userHooks,
            getProjectHooks: () => projectHooks,
          },
        },
      });
      const reloadSettings = vi.mocked(
        context.services.settings.reloadScopesFromDiskAtomically,
      );
      return { context, config, hookSystem, reloadSettings };
    }

    it('re-reads settings and hands the fresh hooks to Config before reloading the registry', async () => {
      const { context, config, hookSystem, reloadSettings } =
        makeReloadContext();

      const result = await hooksCommand.action!(context, '');

      expect(result).toEqual({ type: 'dialog', dialog: 'hooks' });
      expect(reloadSettings).toHaveBeenCalledWith([
        SettingScope.User,
        SettingScope.Workspace,
      ]);
      expect(config.getWorkingDir).not.toHaveBeenCalled();
      expect(config.setHooksFromSettings).toHaveBeenCalledWith({
        userHooks,
        projectHooks,
        hooks: mergedHooks,
      });
      expect(hookSystem.reload).toHaveBeenCalledTimes(1);
      expect(
        config.setHooksFromSettings.mock.invocationCallOrder[0],
      ).toBeLessThan(hookSystem.reload.mock.invocationCallOrder[0]);
    });

    it.each([
      ['safe mode', { safeMode: true }],
      ['bare mode', { bareMode: true }],
    ])('loads no hooks in %s', async (_label, mode) => {
      const { context, config } = makeReloadContext(mode);

      await hooksCommand.action!(context, '');

      expect(config.setHooksFromSettings).toHaveBeenCalledWith({
        userHooks: undefined,
        projectHooks: undefined,
        hooks: undefined,
      });
    });

    it('still opens the menu when the reload fails', async () => {
      const { context, hookSystem } = makeReloadContext();
      hookSystem.reload.mockRejectedValue(new Error('reload failed'));

      const result = await hooksCommand.action!(context, '');

      expect(result).toEqual({ type: 'dialog', dialog: 'hooks' });
    });

    it('still opens the menu when settings cannot be read', async () => {
      const { context, config, hookSystem, reloadSettings } =
        makeReloadContext();
      reloadSettings.mockImplementation(() => {
        throw new Error('bad settings');
      });

      const result = await hooksCommand.action!(context, '');

      expect(result).toEqual({ type: 'dialog', dialog: 'hooks' });
      expect(config.setHooksFromSettings).not.toHaveBeenCalled();
      expect(hookSystem.reload).not.toHaveBeenCalled();
    });

    it('retains running hooks when atomic settings refresh rejects malformed input', async () => {
      const { context, config, hookSystem, reloadSettings } =
        makeReloadContext();
      reloadSettings.mockReturnValue(false);
      expect(await hooksCommand.action!(context, '')).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
      expect(config.setHooksFromSettings).not.toHaveBeenCalled();
      expect(hookSystem.reload).not.toHaveBeenCalled();
      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: expect.stringContaining('Failed to reload hook definitions'),
        }),
        expect.any(Number),
      );
    });

    it('does not read settings when hooks are disabled', async () => {
      const { context, reloadSettings } = makeReloadContext({
        hookSystem: 'none',
      });

      const result = await hooksCommand.action!(context, '');

      expect(result).toEqual({ type: 'dialog', dialog: 'hooks' });
      expect(reloadSettings).not.toHaveBeenCalled();
    });

    it('does not reload for the non-interactive list', async () => {
      const { context, config, hookSystem, reloadSettings } = makeReloadContext(
        {
          executionMode: 'non_interactive',
        },
      );

      await hooksCommand.action!(context, '');

      expect(reloadSettings).not.toHaveBeenCalled();
      expect(config.setHooksFromSettings).not.toHaveBeenCalled();
      expect(hookSystem.reload).not.toHaveBeenCalled();
    });
  });

  describe('non-interactive list output', () => {
    function makeContext(opts: {
      configHooks: Array<{
        eventName: string;
        matcher?: string;
        source: string;
        enabled?: boolean;
        config: {
          type: string;
          command?: string;
          url?: string;
          name?: string;
          id?: string;
          prompt?: string;
        };
      }>;
      sessionHooks?: Array<{
        eventName: string;
        matcher?: string;
        config: { type: string; command?: string; name?: string };
      }>;
    }) {
      const sessionConfig = {
        getDisableAllHooks: () => false,
        isSafeMode: () => false,
        getBareMode: () => false,
        getExtensions: () => [],
        getHookSystem: vi.fn().mockReturnValue({
          getAllHooks: vi
            .fn()
            .mockReturnValue(
              opts.configHooks.map((hook) => ({ enabled: true, ...hook })),
            ),
          getSessionHooksManager: vi.fn().mockReturnValue({
            getAllSessionHooks: vi
              .fn()
              .mockReturnValue(opts.sessionHooks ?? []),
          }),
        }),
        getSessionId: vi.fn().mockReturnValue('sid'),
      };
      return createMockCommandContext({
        executionMode: 'non_interactive',
        services: { config: sessionConfig },
      });
    }

    it.each([
      [{ type: 'command', name: 'my-hook', command: 'echo hidden' }, 'my-hook'],
      [{ type: 'function', id: 'function-id' }, 'function-id'],
      [{ type: 'prompt', prompt: '' }, 'unnamed'],
    ])(
      'uses the shared display identity with name and empty fallbacks: %j',
      async (config, name) => {
        const result = await hooksCommand.action!(
          makeContext({
            configHooks: [{ eventName: 'PreToolUse', source: 'user', config }],
          }),
          '',
        );
        expect((result as { content: string }).content).toContain(
          `- **${name}** [User]`,
        );
        expect((result as { content: string }).content).not.toContain(
          '(disabled)',
        );
      },
    );

    it('renders extension attribution in the non-interactive listing', async () => {
      const hook = { type: 'command', name: 'lint', command: 'echo lint' };
      const ctx = makeContext({
        configHooks: [
          { eventName: 'PreToolUse', source: 'extensions', config: hook },
        ],
      });
      ctx.services.config!.getExtensions = () =>
        [
          {
            name: 'lint-extension',
            isActive: true,
            hooks: { PreToolUse: [{ hooks: [hook] }] },
          },
        ] as unknown as ReturnType<
          NonNullable<typeof ctx.services.config>['getExtensions']
        >;
      const result = await hooksCommand.action!(ctx, '');
      expect((result as { content: string }).content).toContain(
        '- **lint** [Extension (lint-extension)]',
      );
    });

    it('keeps multiline prompt names within a single escaped bullet', async () => {
      const result = await hooksCommand.action!(
        makeContext({
          configHooks: [
            {
              eventName: 'Stop',
              source: 'user',
              config: { type: 'prompt', prompt: 'first\n**second**' },
            },
          ],
        }),
        '',
      );
      expect((result as { content: string }).content).toContain(
        '- **first \\*\\*second\\*\\*** [User]',
      );
    });

    it('marks a disabled registry row', async () => {
      const result = await hooksCommand.action!(
        makeContext({
          configHooks: [
            {
              eventName: 'Stop',
              source: 'user',
              enabled: false,
              config: {
                type: 'command',
                name: 'disabled-hook',
                command: 'true',
              },
            },
          ],
        }),
        '',
      );
      expect((result as { content: string }).content).toContain(
        '- **disabled-hook** [User] (disabled)',
      );
    });

    it('groups hooks under matcher headings', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'PreToolUse',
            matcher: 'Bash',
            source: 'user',
            config: { type: 'command', command: '/check-bash.sh' },
          },
          {
            eventName: 'PreToolUse',
            matcher: 'Edit|Write',
            source: 'project',
            config: { type: 'command', command: '/format.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      expect(result).toBeDefined();
      const content = (result as { content: string }).content;

      expect(content).toContain('### PreToolUse');
      expect(content).toContain('#### Matcher: Bash');
      expect(content).toContain('/check-bash.sh');
      expect(content).toContain('#### Matcher: Edit|Write');
      expect(content).toContain('/format.sh');
    });

    it('renders missing matcher as *', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'PreToolUse',
            source: 'user',
            config: { type: 'command', command: '/anything.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      expect(content).toContain('#### Matcher: *');
      expect(content).toContain('/anything.sh');
    });

    it('does not emit a Matcher heading for non-matcher events like Stop', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'Stop',
            source: 'user',
            config: { type: 'command', command: '/stop-hook.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      expect(content).toContain('### Stop');
      expect(content).not.toContain('Matcher:');
      expect(content).toContain('/stop-hook.sh');
    });

    it('preserves registration order for non-matcher events with ignored matchers', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'Stop',
            matcher: 'A',
            source: 'user',
            config: { type: 'command', command: '/first.sh' },
          },
          {
            eventName: 'Stop',
            matcher: 'B',
            source: 'user',
            config: { type: 'command', command: '/second.sh' },
          },
          {
            eventName: 'Stop',
            matcher: 'A',
            source: 'user',
            config: { type: 'command', command: '/third.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      expect(content).not.toContain('Matcher:');
      expect(content.indexOf('/first.sh')).toBeLessThan(
        content.indexOf('/second.sh'),
      );
      expect(content.indexOf('/second.sh')).toBeLessThan(
        content.indexOf('/third.sh'),
      );
    });

    it('groups session hooks by their matcher alongside config hooks', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'PreToolUse',
            matcher: 'Bash',
            source: 'user',
            config: { type: 'command', command: '/persistent.sh' },
          },
        ],
        sessionHooks: [
          {
            eventName: 'PreToolUse',
            matcher: 'Bash',
            config: { type: 'command', command: '/session.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      const matcherOccurrences = content.match(/#### Matcher: Bash/g) ?? [];
      expect(matcherOccurrences).toHaveLength(1);
      expect(content).toContain('/persistent.sh');
      expect(content).toContain('/session.sh');
    });
  });
});
