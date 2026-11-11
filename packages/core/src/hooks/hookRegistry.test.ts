/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { HookRegistry } from './hookRegistry.js';
import { HookPlanner } from './hookPlanner.js';
import type { Storage } from '../config/storage.js';
import {
  ConfigSource,
  HookEventName,
  HookType,
  HOOKS_CONFIG_FIELDS,
  type CommandHookConfig,
  type PromptHookConfig,
  type AgentHookConfig,
  type HookDefinition,
} from './types.js';
import type {
  BuiltinCommandHookDefinition,
  BuiltinHookDefinition,
  BuiltinPlugin,
} from '../builtin-plugins/types.js';
import type { Config } from '../config/config.js';
import type { LoadedPlugin } from '../plugins/types.js';
import { CONFIG_DIR } from '../utils/paths.js';
import {
  disposeBuiltinPlugins,
  initializeBuiltinPlugins,
  registerBuiltinPlugins,
} from '../test-utils/builtinPluginLifecycle.js';
type BuiltinCommandHookFields = Omit<
  BuiltinCommandHookDefinition,
  'event' | 'matcher' | 'sequential' | 'type' | 'action'
>;
type CoreCommandHookFields = Omit<
  CommandHookConfig,
  'type' | 'action' | 'source'
>;

// Mock fs
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fsMock = {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  return {
    ...fsMock,
    default: fsMock,
  };
});

// Mock runLogger using vi.hoisted
const mockRunLogger = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: mockRunLogger,
}));

vi.mock('../goal/registerGoalHooks.js', () => ({
  getGoalHooksConfiguration: vi.fn().mockReturnValue({}),
}));

const mockBuiltinHooks = vi.hoisted(() => ({
  hooks: [] as BuiltinHookDefinition[],
}));
vi.mock('../builtin-plugins/index.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../builtin-plugins/index.js')
  >();
  return {
    ...actual,
    getBuiltinPluginHooks: () => mockBuiltinHooks.hooks,
  };
});

const { mockTrustedHooksManager, mockCoreEvents } = vi.hoisted(() => ({
  mockTrustedHooksManager: {
    getUntrustedHooks: vi.fn().mockReturnValue([]),
    trustHooks: vi.fn(),
  },
  mockCoreEvents: {
    emitConsoleLog: vi.fn(),
    emitFeedback: vi.fn(),
  },
}));

vi.mock('./trustedHooks.js', () => ({
  TrustedHooksManager: vi.fn(() => mockTrustedHooksManager),
}));

vi.mock('../utils/events.js', () => ({
  coreEvents: mockCoreEvents,
}));

describe('HookRegistry', () => {
  it('keeps the builtin command hook contract aligned with Core', () => {
    const toCore = (hook: BuiltinCommandHookFields): CoreCommandHookFields =>
      hook;
    const toBuiltin = (
      hook: CoreCommandHookFields,
    ): BuiltinCommandHookFields => hook;

    expect(toCore).toBeTypeOf('function');
    expect(toBuiltin).toBeTypeOf('function');
  });

  let hookRegistry: HookRegistry;
  let mockConfig: Config;
  let mockStorage: Storage;

  beforeEach(() => {
    vi.resetAllMocks();
    mockBuiltinHooks.hooks = [];

    mockStorage = {
      getConfigDir: vi.fn().mockReturnValue(`/project/${CONFIG_DIR}`),
    } as unknown as Storage;

    mockConfig = {
      getBuiltinPluginContributions: () => ({
        isReady: () => true,
        getHooks: () => mockBuiltinHooks.hooks,
      }),
      storage: mockStorage,
      getEnabledPlugins: vi.fn().mockReturnValue([]),
      getHooks: vi.fn().mockReturnValue({}),
      getProjectHooks: vi.fn().mockReturnValue({}),
      getLocalHooks: vi.fn().mockReturnValue(undefined),
      getUserHooks: vi.fn().mockReturnValue(undefined),
      getFlagHooks: vi.fn().mockReturnValue(undefined),
      getEnableHooks: vi.fn().mockReturnValue(true),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getProjectRoot: vi.fn().mockReturnValue('/project'),
      isSettingSourceAllowed: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    hookRegistry = new HookRegistry(mockConfig);
  });

  afterEach(async () => {
    await disposeBuiltinPlugins();
    registerBuiltinPlugins([]);
    vi.restoreAllMocks();
  });

  describe('initialize', () => {
    it('preserves if conditions from builtin command hooks', async () => {
      const env = vi.fn(() => ({ QWEN_ACCESS_TOKEN: 'test-token' }));
      const plugin: BuiltinPlugin = {
        apiVersion: 1,
        id: 'conditional-hook',
        initialize: async () => {},
        getHooks: () => [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: './security-review.sh',
            if: 'Bash(git push:*)',
            args: ['review', '--platform=qwen'],
            shell: 'bash',
            once: true,
            asyncRewake: true,
            rewakeMessage: '[security] review:',
            rewakeSummary: 'Security review found issues',
            env,
          },
        ],
        dispose: async () => {},
      };
      mockBuiltinHooks.hooks = [...(plugin.getHooks?.() ?? [])];
      registerBuiltinPlugins([plugin]);
      await initializeBuiltinPlugins({
        mode: 'interactive',
        isSettingSourceAllowed: () => true,
        notifyChanged: async () => {},
        whenReady: async () => {},
      });

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect((hooks[0].config as CommandHookConfig).if).toBe(
        'Bash(git push:*)',
      );
      expect(hooks[0].config).toMatchObject({
        args: ['review', '--platform=qwen'],
        shell: 'bash',
        once: true,
        asyncRewake: true,
        rewakeMessage: '[security] review:',
        rewakeSummary: 'Security review found issues',
        builtinPlugin: true,
      });
      expect((hooks[0].config as CommandHookConfig).env).toBe(env);
      expect(env).not.toHaveBeenCalled();

      const planner = new HookPlanner(hookRegistry);
      const pushPlan = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'Bash',
        toolInput: { command: 'git push origin feature' },
      });
      expect(pushPlan?.asyncHookConfigs).toHaveLength(1);

      const ordinaryBashPlan = planner.createExecutionPlan(
        HookEventName.PreToolUse,
        {
          toolName: 'Bash',
          toolInput: { command: 'npm test' },
        },
      );
      expect(ordinaryBashPlan).toBeNull();
    });

    it('should initialize successfully with no hooks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(mockRunLogger.debug).toHaveBeenCalledWith(
        'Hook registry initialized with 0 hook entries',
      );
    });

    it('preserves command builtin hook contributions without a type field', async () => {
      mockBuiltinHooks.hooks = [
        {
          event: 'QueryEnd',
          command: 'echo builtin-command',
          timeout: 5,
          async: true,
        },
      ];

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toEqual([
        expect.objectContaining({
          eventName: HookEventName.QueryEnd,
          config: expect.objectContaining({
            type: HookType.Command,
            command: 'echo builtin-command',
            timeout: 5,
            async: true,
          }),
        }),
      ]);
    });

    it('preserves Runtime action references from builtin contributions', async () => {
      const action = vi.fn(async () => {});
      mockBuiltinHooks.hooks = [
        {
          event: 'PostToolUse',
          matcher: 'Write',
          type: 'runtime',
          name: 'builtin-runtime',
          internal: true,
          runAfterCancellation: 'completed-file-write',
          timeout: 5,
          action,
        },
      ];

      await hookRegistry.initialize();

      const [entry] = hookRegistry.getAllHooks();
      expect(entry).toMatchObject({
        eventName: HookEventName.PostToolUse,
        matcher: 'Write',
        config: expect.objectContaining({
          type: HookType.Runtime,
          name: 'builtin-runtime',
          action,
          timeout: 5,
          internal: true,
          runAfterCancellation: 'completed-file-write',
        }),
      });
      expect(entry?.config.action).toBe(action);
    });

    it.each([
      {
        event: 'QueryEnd',
        type: 'runtime',
        action: async () => {},
      },
      {
        event: 'QueryEnd',
        type: 'runtime',
        name: 'bad-runtime',
        action: async () => {},
        command: 'echo invalid',
      },
      {
        event: 'QueryEnd',
        type: 'unsupported',
        command: 'echo invalid',
      },
      {
        event: 'QueryEnd',
        type: 'runtime',
        name: 'invalid-cancellation-event',
        action: async () => {},
        runAfterCancellation: 'completed-file-write',
      },
      {
        event: 'PostToolUse',
        type: 'runtime',
        name: 'invalid-cancellation-value',
        action: async () => {},
        runAfterCancellation: 'anything-else',
      },
    ])('skips invalid builtin hook contribution %#', async (contribution) => {
      mockBuiltinHooks.hooks = [contribution as BuiltinHookDefinition];

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[builtin-plugins] Invalid hook'),
      );
    });

    it('should not load hooks if folder is not trusted', async () => {
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './hooks/test.sh',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        'Project hooks disabled because the folder is not trusted.',
      );
    });

    it('should load hooks from project configuration', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            matcher: 'EditTool',
            hooks: [
              {
                type: 'command',
                command: './hooks/check_style.sh',
                timeout: 60,
              },
            ],
          },
        ],
      };

      // Update mock to return the hooks configuration
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect(hooks[0].eventName).toBe(HookEventName.PreToolUse);
      expect(hooks[0].config.type).toBe(HookType.Command);
      expect((hooks[0].config as CommandHookConfig).command).toBe(
        './hooks/check_style.sh',
      );
      expect(hooks[0].matcher).toBe('EditTool');
      expect(hooks[0].source).toBe(ConfigSource.Project);
    });

    it('should load plugin hooks', async () => {
      const mockHooksConfig = {
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './hooks/after-tool.sh',
                timeout: 30,
              },
            ],
          },
        ],
      };

      // Update mock to return the hooks configuration
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect(hooks[0].eventName).toBe(HookEventName.PostToolUse);
      expect(hooks[0].config.type).toBe(HookType.Command);
      expect((hooks[0].config as CommandHookConfig).command).toBe(
        './hooks/after-tool.sh',
      );
    });

    it('should handle invalid configuration gracefully', async () => {
      const invalidHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'invalid-type', // Invalid hook type
                command: './hooks/test.sh',
              },
            ],
          },
        ],
      };

      // Update mock to return invalid configuration
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        invalidHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors().length).toBeGreaterThan(0);
    });

    it('should validate hook configurations', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'invalid',
                command: './hooks/test.sh',
              },
              {
                type: 'command',
                // Missing command field
              },
            ],
          },
        ],
      };

      // Update mock to return invalid configuration
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors().length).toBeGreaterThan(0);
    });

    it('should reject command hook with non-array args (exec form)', async () => {
      const badConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: '/bin/echo',
                args: 'not-an-array',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        badConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('args'),
          }),
        ]),
      );
    });

    it('should reject command hook with non-string args entry (exec form)', async () => {
      const badConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: '/bin/echo',
                args: ['ok', 42],
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        badConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('args'),
          }),
        ]),
      );
    });

    it('should register hooks that are enabled by default', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                name: 'test-hook',
                type: 'command',
                command: './hooks/test.sh',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect(hooks[0].enabled).toBe(true);
      expect(
        hookRegistry.getHooksForEvent(HookEventName.PreToolUse),
      ).toHaveLength(1);
    });
  });

  describe('getHooksForEvent', () => {
    beforeEach(async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            matcher: 'EditTool',
            hooks: [
              {
                type: 'command',
                command: './hooks/edit_check.sh',
              },
            ],
          },
          {
            hooks: [
              {
                type: 'command',
                command: './hooks/general_check.sh',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './hooks/after-tool.sh',
              },
            ],
          },
        ],
      };

      // Update mock to return the hooks configuration
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();
    });

    it('should return hooks for specific event', () => {
      const beforeToolHooks = hookRegistry.getHooksForEvent(
        HookEventName.PreToolUse,
      );
      expect(beforeToolHooks).toHaveLength(2);

      const afterToolHooks = hookRegistry.getHooksForEvent(
        HookEventName.PostToolUse,
      );
      expect(afterToolHooks).toHaveLength(1);
    });

    it('should return empty array for events with no hooks', () => {
      const notificationHooks = hookRegistry.getHooksForEvent(
        HookEventName.Notification,
      );
      expect(notificationHooks).toHaveLength(0);
    });
  });

  describe('removeEntry', () => {
    beforeEach(async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './hooks/test.sh',
              },
            ],
          },
        ],
      };

      // Update mock to return the hooks configuration
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();
    });

    it('should remove hooks by name', () => {
      const hookName = './hooks/test.sh';

      // Initially present
      let hooks = hookRegistry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(1);

      // Remove
      const removed = hookRegistry.removeEntry(hookName);
      expect(removed).toBe(1);
      hooks = hookRegistry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(0);
    });

    it('should warn when hook not found', () => {
      hookRegistry.removeEntry('non-existent-hook');
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        'No hooks found matching "non-existent-hook" for removal',
      );
    });
  });

  describe('malformed configuration handling', () => {
    it('should handle non-array definitions gracefully', async () => {
      const malformedConfig = {
        PreToolUse: 'not-an-array', // Should be an array of HookDefinition
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        malformedConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('is not an array'),
          }),
        ]),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should handle object instead of array for definitions', async () => {
      const malformedConfig = {
        PostToolUse: { hooks: [] }, // Should be an array, not a single object
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        malformedConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('is not an array'),
          }),
        ]),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should handle null definition gracefully', async () => {
      const malformedConfig = {
        PreToolUse: [null], // Invalid: null definition
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        malformedConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              'Discarding invalid hook definition',
            ),
          }),
        ]),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should handle definition without hooks array', async () => {
      const malformedConfig = {
        PreToolUse: [
          {
            matcher: 'EditTool',
            // Missing hooks array
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        malformedConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              'Discarding invalid hook definition',
            ),
          }),
        ]),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should handle non-array hooks property', async () => {
      const malformedConfig = {
        PreToolUse: [
          {
            matcher: 'EditTool',
            hooks: 'not-an-array', // Should be an array
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        malformedConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              'Discarding invalid hook definition',
            ),
          }),
        ]),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should handle non-object hookConfig in hooks array', async () => {
      const malformedConfig = {
        PreToolUse: [
          {
            hooks: [
              'not-an-object', // Should be an object
              42, // Should be an object
              null, // Should be an object
            ],
          },
        ],
      };
      mockTrustedHooksManager.getUntrustedHooks.mockReturnValue([]);

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        malformedConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      // Three load errors (one for each invalid hookConfig)
      expect(hookRegistry.getLoadErrors()).toHaveLength(3);
      // Single summarized emitFeedback call
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledTimes(1);
    });

    it('should handle mixed valid and invalid hook configurations', async () => {
      const mixedConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './valid-hook.sh',
              },
              'invalid-string',
              {
                type: 'invalid-type',
                command: './invalid-type.sh',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mixedConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      // Should only load the valid hook
      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect((hooks[0].config as CommandHookConfig).command).toBe(
        './valid-hook.sh',
      );

      // Verify the load errors for invalid configurations
      const errors = hookRegistry.getLoadErrors();
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('Discarding invalid hook'),
          }),
        ]),
      );
      // Single summarized emitFeedback call
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should skip known config fields and warn on invalid event names', async () => {
      const configWithExtras: Record<string, unknown> = {
        InvalidEvent: [],
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './test.sh',
              },
            ],
          },
        ],
      };

      // Add all known config fields dynamically
      for (const field of HOOKS_CONFIG_FIELDS) {
        configWithExtras[field] = field === 'disabled' ? [] : true;
      }

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        configWithExtras as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      // Should only load the valid hook
      expect(hookRegistry.getAllHooks()).toHaveLength(1);

      // Should skip all known config fields without warnings
      for (const field of HOOKS_CONFIG_FIELDS) {
        expect(mockRunLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining(`Invalid hook event name: ${field}`),
        );
      }

      // Should record invalid event name in load errors
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              'Invalid hook event name: "InvalidEvent"',
            ),
          }),
        ]),
      );
      // Summarized emitFeedback
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });
  });

  describe('removeEntry (malformed config)', () => {
    beforeEach(async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './hooks/test.sh',
              },
              {
                statusMessage: 'named-hook',
                type: 'command',
                command: './hooks/named.sh',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: './hooks/test.sh',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();
    });

    it('should remove all entries matching the hook name', () => {
      // './hooks/test.sh' appears in both PreToolUse and PostToolUse
      expect(hookRegistry.getAllHooks()).toHaveLength(3);

      const removed = hookRegistry.removeEntry('./hooks/test.sh');

      expect(removed).toBe(2);
      expect(hookRegistry.getAllHooks()).toHaveLength(1);
      expect(
        hookRegistry.getHooksForEvent(HookEventName.PreToolUse),
      ).toHaveLength(1);
      expect(
        hookRegistry.getHooksForEvent(HookEventName.PostToolUse),
      ).toHaveLength(0);
    });

    it('should remove entry by friendly name', () => {
      const removed = hookRegistry.removeEntry('named-hook');

      expect(removed).toBe(1);
      expect(hookRegistry.getAllHooks()).toHaveLength(2);
    });

    it('should return 0 and warn when hook not found', () => {
      const removed = hookRegistry.removeEntry('nonexistent-hook');

      expect(removed).toBe(0);
      expect(hookRegistry.getAllHooks()).toHaveLength(3);
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        'No hooks found matching "nonexistent-hook" for removal',
      );
    });

    it('should log when entries are removed', () => {
      hookRegistry.removeEntry('named-hook');

      expect(mockRunLogger.log).toHaveBeenCalledWith(
        'Removed 1 hook entry(ies) matching "named-hook"',
      );
    });
  });

  describe('prompt and agent hook validation', () => {
    it('should accept valid prompt hook configuration', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: 'Is this command safe?',
                name: 'safety-check',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect(hooks[0].config.type).toBe(HookType.Prompt);
      expect((hooks[0].config as PromptHookConfig).prompt).toBe(
        'Is this command safe?',
      );
      expect(hooks[0].enabled).toBe(true);
    });

    it('should reject prompt hook without prompt field', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'prompt',
                // Missing prompt field
                name: 'bad-prompt-hook',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              'Prompt hook missing prompt field',
            ),
          }),
        ]),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should accept valid agent hook configuration', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'agent',
                prompt: 'Evaluate if this tool use is safe',
                tools: ['Read', 'Glob'],
                maxTurns: 5,
                name: 'safety-agent',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect(hooks[0].config.type).toBe(HookType.Agent);
      expect((hooks[0].config as AgentHookConfig).prompt).toBe(
        'Evaluate if this tool use is safe',
      );
      expect((hooks[0].config as AgentHookConfig).tools).toEqual([
        'Read',
        'Glob',
      ]);
      expect(hooks[0].enabled).toBe(true);
    });

    it('should reject agent hook without prompt field', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'agent',
                // Missing prompt field
                tools: ['Read'],
                name: 'bad-agent-hook',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
      expect(hookRegistry.getLoadErrors()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('Agent hook missing prompt field'),
          }),
        ]),
      );
      expect(mockCoreEvents.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('loading hook configs'),
      );
    });

    it('should handle mixed valid and invalid prompt/agent hooks', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: 'Valid prompt hook',
              },
              {
                type: 'prompt',
                // Missing prompt — invalid
              },
              {
                type: 'agent',
                prompt: 'Valid agent hook',
              },
              {
                type: 'agent',
                // Missing prompt — invalid
              },
              {
                type: 'command',
                command: './valid-command.sh',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      // Valid prompt + valid agent + valid command = 3
      expect(hooks).toHaveLength(3);
      expect(hooks.map((h) => h.config.type)).toEqual(
        expect.arrayContaining([
          HookType.Prompt,
          HookType.Agent,
          HookType.Command,
        ]),
      );
    });

    it('should accept prompt hook with if field', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: 'Is this Bash command safe?',
                if: 'Bash(git *)',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect((hooks[0].config as PromptHookConfig).if).toBe('Bash(git *)');
    });

    it('should accept agent hook with if field', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'agent',
                prompt: 'Evaluate file edit',
                if: 'Edit(*.ts)',
                tools: ['Read'],
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect((hooks[0].config as AgentHookConfig).if).toBe('Edit(*.ts)');
    });

    it('should register prompt and agent hook types', async () => {
      const mockHooksConfig = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: 'Check safety',
                name: 'prompt-hook',
              },
              {
                type: 'agent',
                prompt: 'Check safety',
                name: 'agent-hook',
              },
            ],
          },
        ],
      };

      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        mockHooksConfig as unknown as {
          [K in HookEventName]?: HookDefinition[];
        },
      );

      await hookRegistry.initialize();

      const allHooks = hookRegistry.getAllHooks();
      expect(allHooks).toHaveLength(2);
      expect(allHooks.every((h) => h.enabled)).toBe(true);
      expect(
        hookRegistry.getHooksForEvent(HookEventName.PreToolUse),
      ).toHaveLength(2);
    });
  });

  describe('Flag hooks (--settings)', () => {
    it('should register flag hooks with ConfigSource.Flag', async () => {
      const flagHooks = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo flag-hook-fired',
              },
            ],
          },
        ],
      };
      vi.mocked(mockConfig.getFlagHooks).mockReturnValue(
        flagHooks as unknown as { [K in HookEventName]?: HookDefinition[] },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      const flagEntries = hooks.filter((h) => h.source === ConfigSource.Flag);
      expect(flagEntries).toHaveLength(1);
      expect(flagEntries[0].source).toBe(ConfigSource.Flag);
      expect(flagEntries[0].eventName).toBe(HookEventName.PreToolUse);
    });

    it('should load flag hooks even when folder is not trusted', async () => {
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
      const flagHooks = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo flag-hook-fired',
              },
            ],
          },
        ],
      };
      vi.mocked(mockConfig.getFlagHooks).mockReturnValue(
        flagHooks as unknown as { [K in HookEventName]?: HookDefinition[] },
      );
      // Project hooks should be skipped due to untrusted folder
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        flagHooks as unknown as { [K in HookEventName]?: HookDefinition[] },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      // Only flag hooks should be loaded, project hooks skipped
      const flagEntries = hooks.filter((h) => h.source === ConfigSource.Flag);
      const projectEntries = hooks.filter(
        (h) => h.source === ConfigSource.Project,
      );
      expect(flagEntries).toHaveLength(1);
      expect(projectEntries).toHaveLength(0);
    });

    it('should skip flag hooks when source is not allowed by --setting-sources', async () => {
      vi.mocked(mockConfig.isSettingSourceAllowed).mockImplementation(
        (source: string) => source !== 'flag',
      );
      const flagHooks = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo flag-hook-fired',
              },
            ],
          },
        ],
      };
      vi.mocked(mockConfig.getFlagHooks).mockReturnValue(
        flagHooks as unknown as { [K in HookEventName]?: HookDefinition[] },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      const flagEntries = hooks.filter((h) => h.source === ConfigSource.Flag);
      expect(flagEntries).toHaveLength(0);
    });

    it('should always load plugin hooks regardless of --setting-sources', async () => {
      vi.mocked(mockConfig.isSettingSourceAllowed).mockImplementation(
        (source: string) => source === 'plugin',
      );
      const flagHooks = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo flag-hook-fired',
              },
            ],
          },
        ],
      };
      vi.mocked(mockConfig.getFlagHooks).mockReturnValue(
        flagHooks as unknown as { [K in HookEventName]?: HookDefinition[] },
      );
      vi.mocked(mockConfig.getEnabledPlugins).mockReturnValue([
        {
          name: 'enterprise-plugin',
          path: '/plugins/enterprise',
          source: 'enterprise',
          repository: 'enterprise',
          manifest: { name: 'enterprise-plugin' },
          hooksConfig: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'echo plugin-hook-fired',
                  },
                ],
              },
            ],
          },
        },
      ] as unknown as LoadedPlugin[]);

      await hookRegistry.initialize();

      const hooks = hookRegistry.getAllHooks();
      const pluginEntries = hooks.filter(
        (h) => h.source === ConfigSource.Plugins,
      );
      const flagEntries = hooks.filter((h) => h.source === ConfigSource.Flag);
      expect(pluginEntries).toHaveLength(1);
      expect(flagEntries).toHaveLength(0);
    });

    it('should give flag hooks higher priority than project hooks', async () => {
      const flagHooks = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo flag-hook',
              },
            ],
          },
        ],
      };
      const projectHooks = {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo project-hook',
              },
            ],
          },
        ],
      };
      vi.mocked(mockConfig.getFlagHooks).mockReturnValue(
        flagHooks as unknown as { [K in HookEventName]?: HookDefinition[] },
      );
      vi.mocked(mockConfig.getProjectHooks).mockReturnValue(
        projectHooks as unknown as { [K in HookEventName]?: HookDefinition[] },
      );

      await hookRegistry.initialize();

      const hooks = hookRegistry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(2);
      // Flag hooks should come before project hooks (lower priority number = higher priority)
      expect(hooks[0].source).toBe(ConfigSource.Flag);
      expect(hooks[1].source).toBe(ConfigSource.Project);
    });

    it('should handle empty flag hooks without errors', async () => {
      vi.mocked(mockConfig.getFlagHooks).mockReturnValue({});

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
    });

    it('should handle undefined flag hooks without errors', async () => {
      vi.mocked(mockConfig.getFlagHooks).mockReturnValue(undefined);

      await hookRegistry.initialize();

      expect(hookRegistry.getAllHooks()).toHaveLength(0);
    });
  });

  describe('removeInlineSkillSessionHooks', () => {
    const makeConfig = (command: string): CommandHookConfig => ({
      type: HookType.Command,
      command,
    });

    it('removes matching entries across all inline skill buckets', () => {
      const config = makeConfig('echo a');
      hookRegistry.registerSessionHook(
        'skill:one',
        config,
        HookEventName.PreToolUse,
      );
      hookRegistry.registerSessionHook(
        'skill:two',
        config,
        HookEventName.PreToolUse,
      );

      expect(hookRegistry.removeInlineSkillSessionHooks(config)).toBe(true);
      expect(
        hookRegistry.getSessionHooksForEvent('skill:one', HookEventName.PreToolUse),
      ).toHaveLength(0);
      expect(
        hookRegistry.getSessionHooksForEvent('skill:two', HookEventName.PreToolUse),
      ).toHaveLength(0);
    });

    it('keeps unrelated hooks in the same bucket', () => {
      const target = makeConfig('echo a');
      const other = makeConfig('echo b');
      hookRegistry.registerSessionHook(
        'skill:one',
        target,
        HookEventName.PreToolUse,
      );
      hookRegistry.registerSessionHook(
        'skill:one',
        other,
        HookEventName.PreToolUse,
      );

      expect(hookRegistry.removeInlineSkillSessionHooks(target)).toBe(true);

      const remaining = hookRegistry.getSessionHooksForEvent(
        'skill:one',
        HookEventName.PreToolUse,
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0].config).toBe(other);
    });

    it('does not touch non-skill or :fork buckets', () => {
      const config = makeConfig('echo a');
      hookRegistry.registerSessionHook(
        'a1234',
        config,
        HookEventName.PreToolUse,
      );
      hookRegistry.registerSessionHook(
        'skill:one:fork',
        config,
        HookEventName.PreToolUse,
      );

      expect(hookRegistry.removeInlineSkillSessionHooks(config)).toBe(false);
      expect(
        hookRegistry.getSessionHooksForEvent('a1234', HookEventName.PreToolUse),
      ).toHaveLength(1);
      expect(
        hookRegistry.getSessionHooksForEvent(
          'skill:one:fork',
          HookEventName.PreToolUse,
        ),
      ).toHaveLength(1);
    });

    it('returns false when nothing matches', () => {
      hookRegistry.registerSessionHook(
        'skill:one',
        makeConfig('echo a'),
        HookEventName.PreToolUse,
      );

      expect(hookRegistry.removeInlineSkillSessionHooks(makeConfig('echo b'))).toBe(
        false,
      );
    });
  });
});
