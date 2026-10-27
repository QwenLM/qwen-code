/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hooksCommand } from './hooksCommand.js';
import {
  HOOK_APPROVALS_FILENAME,
  loadHookApprovals,
  resetHookApprovalsForTesting,
} from '../../config/hook-approvals.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

import { SettingScope } from '../../config/settings.js';
import { createBundledMem0Server } from '../../config/mem0-settings.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) =>
      path.replaceAll('\\', '/').endsWith('/mem0/main.js') ||
      actual.existsSync(path),
  };
});

describe('hooksCommand', () => {
  let approvalsDir: string;
  let mockContext: ReturnType<typeof createMockCommandContext>;
  let mockConfig: {
    getHookSystem: ReturnType<typeof vi.fn>;
    setHooksFromSettings: ReturnType<typeof vi.fn>;
    setProjectHooksPendingApproval: ReturnType<typeof vi.fn>;
    isProjectHooksApprovalGated: ReturnType<typeof vi.fn>;
    getBareMode: ReturnType<typeof vi.fn>;
    isSafeMode: ReturnType<typeof vi.fn>;
    getTopTierMcpServers: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-cmd-'));
    process.env['QWEN_CODE_HOOK_APPROVALS_PATH'] = path.join(
      approvalsDir,
      HOOK_APPROVALS_FILENAME,
    );
    resetHookApprovalsForTesting();

    mockConfig = {
      setHooksFromSettings: vi.fn(),
      setProjectHooksPendingApproval: vi.fn(),
      isProjectHooksApprovalGated: vi.fn().mockReturnValue(false),
      getBareMode: vi.fn().mockReturnValue(false),
      isSafeMode: vi.fn().mockReturnValue(false),
      getTopTierMcpServers: vi.fn(),
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
          getSystemHooks: vi.fn().mockReturnValue(undefined),
          getUserHooks: vi.fn(),
          getProjectHooks: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env['QWEN_CODE_HOOK_APPROVALS_PATH'];
    resetHookApprovalsForTesting();
    fs.rmSync(approvalsDir, { recursive: true, force: true });
  });

  it('opts in to running during streaming', () => {
    expect(hooksCommand.canRunDuringStreaming).toBe(true);
  });

  describe('basic functionality', () => {
    it('does not promote a repository MCP lookalike to system hooks on reload', async () => {
      mockConfig.getTopTierMcpServers.mockReturnValue({
        'external-context': {
          command: 'node',
          args: ['/repo/shim/loader.js'],
          env: { QWEN_BUNDLED_MEM0_CONFIG: '{}' },
          includeTools: ['context_search', 'context_remember'],
          scope: 'project',
        },
      });
      await hooksCommand.action!(mockContext, '');
      expect(mockConfig.setHooksFromSettings).toHaveBeenCalledWith({
        systemHooks: undefined,
        userHooks: undefined,
        projectHooks: undefined,
        hooks: undefined,
      });
    });

    it('should open hooks management dialog in interactive mode', async () => {
      const result = await hooksCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
      expect(
        mockContext.services.settings.reloadScopesFromDiskAtomically,
      ).toHaveBeenNthCalledWith(1, [SettingScope.User, SettingScope.Workspace]);
      expect(
        mockContext.services.settings.reloadScopesFromDiskAtomically,
      ).toHaveBeenNthCalledWith(2, [
        SettingScope.System,
        SettingScope.SystemDefaults,
      ]);
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
    const systemHooks = { SessionStart: [] };
    const userHooks = { PreToolUse: [] };
    const projectHooks = { PostToolUse: [] };

    function makeReloadContext(
      opts: {
        executionMode?: 'interactive' | 'non_interactive';
        safeMode?: boolean;
        bareMode?: boolean;
        hookSystem?: 'none';
        gated?: boolean;
        projectHooks?: Record<string, unknown>;
        /** What `${VAR}` resolution made of `projectHooks`. */
        resolvedProjectHooks?: Record<string, unknown>;
      } = {},
    ) {
      const hookSystem = {
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
        setProjectHooksPendingApproval: vi.fn(),
        isProjectHooksApprovalGated: vi
          .fn()
          .mockReturnValue(opts.gated ?? false),
        getBareMode: vi.fn().mockReturnValue(opts.bareMode ?? false),
        isSafeMode: vi.fn().mockReturnValue(opts.safeMode ?? false),
        getTopTierMcpServers: vi.fn(),
        getWorkingDir: vi.fn().mockReturnValue('/work/dir'),
        getSessionId: vi.fn().mockReturnValue('session-1'),
      };
      const context = createMockCommandContext({
        executionMode: opts.executionMode ?? 'interactive',
        services: {
          config,
          settings: {
            merged: { hooks: mergedHooks },
            reloadScopesFromDiskAtomically: vi.fn().mockReturnValue(true),
            getSystemHooks: () => systemHooks,
            getUserHooks: () => userHooks,
            getProjectHooks: () =>
              opts.resolvedProjectHooks ?? opts.projectHooks ?? projectHooks,
            workspace: {
              path: '/work/repo/.qwen/settings.json',
              originalSettings: {
                hooks: (opts.projectHooks ?? projectHooks) as never,
              },
            },
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
      expect(reloadSettings.mock.calls).toEqual([
        [[SettingScope.User, SettingScope.Workspace]],
        [[SettingScope.System, SettingScope.SystemDefaults]],
      ]);
      expect(config.getWorkingDir).not.toHaveBeenCalled();
      expect(config.setHooksFromSettings).toHaveBeenCalledWith({
        systemHooks,
        userHooks,
        projectHooks,
        hooks: undefined,
      });
      expect(hookSystem.reload).toHaveBeenCalledTimes(1);
      expect(
        config.setHooksFromSettings.mock.invocationCallOrder[0],
      ).toBeLessThan(hookSystem.reload.mock.invocationCallOrder[0]);
    });

    const runnable = {
      SessionStart: [
        { hooks: [{ type: 'command', command: './setup.sh ${TOKEN}' }] },
      ],
    };
    const resolved = {
      SessionStart: [
        { hooks: [{ type: 'command', command: './setup.sh secret' }] },
      ],
    };

    it.each([
      ['unapproved', undefined, undefined, true, true],
      ['rejected', 'rejected', undefined, true, false],
      ['approved', 'approved', undefined, false, false],
      ['approved before ${TOKEN} changed', 'approved', 'other', true, true],
    ] as const)(
      'gates %s project hooks before the registry reloads',
      async (_label, decision, tokenAfter, gated, prompted) => {
        vi.stubEnv('TOKEN', 'secret');
        if (decision) {
          await loadHookApprovals().setState('/work/repo', runnable, decision);
        }
        if (tokenAfter) vi.stubEnv('TOKEN', tokenAfter);
        const onPending = vi.fn();
        appEvents.on(AppEvent.ProjectHooksPendingApprovalChanged, onPending);
        // The decision binds the unresolved block, as startup hashed it.
        const { context, config, hookSystem } = makeReloadContext({
          gated: true,
          projectHooks: runnable,
          resolvedProjectHooks: resolved,
        });

        await hooksCommand.action!(context, '');

        appEvents.off(AppEvent.ProjectHooksPendingApprovalChanged, onPending);
        expect(config.setProjectHooksPendingApproval).toHaveBeenCalledWith(
          gated,
          decision === 'rejected' && !tokenAfter,
        );
        expect(
          config.setProjectHooksPendingApproval.mock.invocationCallOrder[0],
        ).toBeLessThan(hookSystem.reload.mock.invocationCallOrder[0]);
        expect(onPending).toHaveBeenCalledTimes(prompted ? 1 : 0);
        expect(config.getWorkingDir).not.toHaveBeenCalled();
      },
    );

    it('leaves an ungated session alone', async () => {
      const onPending = vi.fn();
      appEvents.on(AppEvent.ProjectHooksPendingApprovalChanged, onPending);
      const { context, config } = makeReloadContext({ projectHooks: runnable });

      await hooksCommand.action!(context, '');

      appEvents.off(AppEvent.ProjectHooksPendingApprovalChanged, onPending);
      expect(config.setProjectHooksPendingApproval).not.toHaveBeenCalled();
      expect(onPending).not.toHaveBeenCalled();
    });

    it('does not file a repository-authored external-context server under system hooks', async () => {
      const { context, config } = makeReloadContext();
      // The startup binding still owns its confirmation hook while an MCP
      // allow-list temporarily hides the server from discovery.
      config.getTopTierMcpServers.mockReturnValue({
        'external-context': createBundledMem0Server(
          { baseUrl: 'https://mem0.example', enableWrites: true },
          process.cwd(),
        ),
      });

      await hooksCommand.action!(context, '');

      expect(config.setHooksFromSettings).toHaveBeenCalledWith({
        systemHooks: {
          ...systemHooks,
          PreToolUse: [
            expect.objectContaining({
              matcher: 'mcp__external-context__context_remember',
            }),
          ],
        },
        userHooks,
        projectHooks,
        hooks: undefined,
      });

      // Negative arm: the same duck-typed entry carrying a provenance scope,
      // i.e. one a checked-in `.mcp.json` ('project') or workspace settings
      // ('workspace') contributed. systemHooks is the one hook source folder
      // trust does not gate, so a repository-authored command must never be
      // presented there as administrator configuration.
      config.setHooksFromSettings.mockClear();
      config.getTopTierMcpServers.mockReturnValue({
        'external-context': {
          command: 'node',
          args: ['/repo/.qwen/shim/loader.js'],
          env: { QWEN_BUNDLED_MEM0_CONFIG: '{}' },
          includeTools: ['context_search', 'context_remember'],
          scope: 'project',
        },
      });

      await hooksCommand.action!(context, '');

      expect(config.setHooksFromSettings).toHaveBeenCalledWith({
        systemHooks,
        userHooks,
        projectHooks,
        hooks: undefined,
      });
    });

    it.each([
      ['safe mode', { safeMode: true }],
      ['bare mode', { bareMode: true }],
    ])('loads no hooks in %s', async (_label, mode) => {
      const { context, config } = makeReloadContext(mode);

      await hooksCommand.action!(context, '');

      expect(config.setHooksFromSettings).toHaveBeenCalledWith({
        systemHooks: undefined,
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
        config: {
          type: string;
          command?: string;
          url?: string;
          name?: string;
        };
      }>;
      sessionHooks?: Array<{
        eventName: string;
        matcher?: string;
        config: { type: string; command?: string; name?: string };
      }>;
    }) {
      const sessionConfig = {
        getHookSystem: vi.fn().mockReturnValue({
          getRegistry: vi.fn().mockReturnValue({
            getAllHooks: vi.fn().mockReturnValue(opts.configHooks),
          }),
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
