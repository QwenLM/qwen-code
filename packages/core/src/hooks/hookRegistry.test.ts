/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HookRegistryConfig, FeedbackEmitter } from './hookRegistry.js';
import { HookRegistry } from './hookRegistry.js';
import { HookEventName, HooksConfigSource, HookType } from './types.js';
import type { HookConfig } from './types.js';

// Mock TrustedHooksManager
vi.mock('./trustedHooks.js', () => ({
  TrustedHooksManager: vi.fn().mockImplementation(() => ({
    getUntrustedHooks: vi.fn().mockReturnValue([]),
    trustHooks: vi.fn(),
  })),
}));

describe('HookRegistry', () => {
  let mockConfig: HookRegistryConfig;
  let mockFeedbackEmitter: FeedbackEmitter;

  beforeEach(() => {
    mockConfig = {
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getUserHooks: vi.fn().mockReturnValue(undefined),
      getProjectHooks: vi.fn().mockReturnValue(undefined),
      getExtensions: vi.fn().mockReturnValue([]),
    };
    mockFeedbackEmitter = {
      emitFeedback: vi.fn(),
    };
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize with empty hooks when no config provided', async () => {
      const registry = new HookRegistry(mockConfig);
      await registry.initialize();
      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should process project hooks from config', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'test-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].eventName).toBe(HookEventName.PreToolUse);
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
    });

    it('should process user hooks even in untrusted folder', async () => {
      mockConfig.isTrustedFolder = vi.fn().mockReturnValue(false);
      const userHooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo user',
                name: 'user-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooksConfig);
      mockConfig.getProjectHooks = vi.fn().mockReturnValue(undefined);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
    });

    it('should load hooks from getUserHooks regardless of trust', async () => {
      // In the new design, the CLI filters workspace hooks before passing to core
      // So core just loads whatever getUserHooks returns
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'test-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);
      mockConfig.getProjectHooks = vi.fn().mockReturnValue(undefined);
      mockConfig.isTrustedFolder = vi.fn().mockReturnValue(false);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      // Hooks should be loaded because CLI already filtered them
      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].source).toBe(HooksConfigSource.User);
    });

    it('should load both user and project hooks in trusted folder', async () => {
      mockConfig.isTrustedFolder = vi.fn().mockReturnValue(true);
      const userHooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo user',
                name: 'user-hook',
              },
            ],
          },
        ],
      };
      const projectHooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo project',
                name: 'project-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooksConfig);
      mockConfig.getProjectHooks = vi.fn().mockReturnValue(projectHooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(2);
      // User hooks should have priority (lower number) over project hooks
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
      expect(allHooks[0].config.name).toBe('user-hook');
      expect(allHooks[1].source).toBe(HooksConfigSource.Project);
      expect(allHooks[1].config.name).toBe('project-hook');
    });

    it('should not load project hooks in untrusted folder', async () => {
      mockConfig.isTrustedFolder = vi.fn().mockReturnValue(false);
      const userHooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo user',
                name: 'user-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooksConfig);
      // getProjectHooks should return undefined in untrusted folder
      // (this is handled by Config.getProjectHooks() checking trust)
      mockConfig.getProjectHooks = vi.fn().mockReturnValue(undefined);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
      expect(allHooks[0].config.name).toBe('user-hook');
    });
  });

  describe('getHooksForEvent', () => {
    it('should return hooks for specific event', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              { type: HookType.Command, command: 'echo pre', name: 'pre-hook' },
            ],
          },
        ],
        [HookEventName.PostToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo post',
                name: 'post-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const preHooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      expect(preHooks).toHaveLength(1);
      expect(preHooks[0].config.name).toBe('pre-hook');

      const postHooks = registry.getHooksForEvent(HookEventName.PostToolUse);
      expect(postHooks).toHaveLength(1);
      expect(postHooks[0].config.name).toBe('post-hook');
    });

    it('should register all hooks as enabled by default', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo first',
                name: 'first-hook',
              },
              {
                type: HookType.Command,
                command: 'echo second',
                name: 'second-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(2);
      expect(hooks[0].enabled).toBe(true);
      expect(hooks[1].enabled).toBe(true);
    });

    it('should sort hooks by source priority', async () => {
      // Test with user hooks and extension hooks to verify source priority
      const userHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo user',
                name: 'user-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooks);
      mockConfig.getExtensions = vi.fn().mockReturnValue([
        {
          isActive: true,
          hooks: {
            [HookEventName.PreToolUse]: [
              {
                hooks: [
                  {
                    type: HookType.Command,
                    command: 'echo extension',
                    name: 'extension-hook',
                  },
                ],
              },
            ],
          },
        },
      ]);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      // Should have both user and extension hooks
      expect(hooks).toHaveLength(2);
      // User hooks have higher priority (lower number) than extensions
      expect(hooks[0].source).toBe(HooksConfigSource.User);
      expect(hooks[1].source).toBe(HooksConfigSource.Extensions);
    });
  });

  describe('setHookEnabled', () => {
    it('should disable an enabled hook', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'test-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        1,
      );

      registry.setHookEnabled('test-hook', false);

      const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(0);
    });

    it('should enable a disabled hook', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'test-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      // First disable the hook
      registry.setHookEnabled('test-hook', false);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );

      // Then enable it again
      registry.setHookEnabled('test-hook', true);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        1,
      );
    });

    it('should update all hooks with matching name', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              { type: HookType.Command, command: 'echo 1', name: 'same-name' },
            ],
          },
        ],
        [HookEventName.PostToolUse]: [
          {
            hooks: [
              { type: HookType.Command, command: 'echo 2', name: 'same-name' },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(2);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        1,
      );
      expect(registry.getHooksForEvent(HookEventName.PostToolUse)).toHaveLength(
        1,
      );

      registry.setHookEnabled('same-name', false);

      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );
      expect(registry.getHooksForEvent(HookEventName.PostToolUse)).toHaveLength(
        0,
      );
    });
  });

  describe('hook validation', () => {
    it('should discard hooks with invalid type', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: 'invalid-type',
                command: 'echo test',
              } as unknown as HookConfig,
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should discard command hooks without command field', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [{ type: HookType.Command } as HookConfig],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should discard HTTP hooks without url field', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [{ type: HookType.Http } as HookConfig],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should discard function hooks without callback field', async () => {
      const hooksConfig = {
        [HookEventName.SessionStart]: [
          {
            hooks: [{ type: HookType.Function } as HookConfig],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should accept valid HTTP hooks with url', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Http,
                url: 'http://localhost:8080/hook',
                name: 'http-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].config.type).toBe(HookType.Http);
    });

    it('should accept valid function hooks with callback', async () => {
      const callback = vi.fn();
      const hooksConfig = {
        [HookEventName.SessionStart]: [
          {
            hooks: [
              {
                type: HookType.Function,
                callback,
                name: 'function-hook',
                errorMessage: 'Error occurred',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].config.type).toBe(HookType.Function);
    });

    it('should skip invalid event names', async () => {
      const hooksConfig = {
        InvalidEventName: [
          {
            hooks: [{ type: HookType.Command, command: 'echo test' }],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig, mockFeedbackEmitter);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
      expect(mockFeedbackEmitter.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('Invalid hook event name'),
      );
    });

    it('should skip hooks config fields like enabled and disabled', async () => {
      const hooksConfig = {
        enabled: ['hook1'],
        disabled: ['hook2'],
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'valid-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].config.name).toBe('valid-hook');
    });
  });

  describe('duplicate detection', () => {
    it('should skip duplicate hooks with same name+source+event+matcher+sequential', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            matcher: '*.ts',
            sequential: true,
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'dup-hook',
              },
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'dup-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(1);
    });

    it('should allow hooks with same name but different matcher', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            matcher: '*.ts',
            hooks: [
              { type: HookType.Command, command: 'echo ts', name: 'my-hook' },
            ],
          },
          {
            matcher: '*.js',
            hooks: [
              { type: HookType.Command, command: 'echo js', name: 'my-hook' },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(2);
    });

    it('should allow hooks with same name but different sequential', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            sequential: true,
            hooks: [
              { type: HookType.Command, command: 'echo seq', name: 'my-hook' },
            ],
          },
          {
            sequential: false,
            hooks: [
              { type: HookType.Command, command: 'echo par', name: 'my-hook' },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(2);
    });

    it('should distinguish unnamed prompt hooks with same prefix but different content', async () => {
      // Two prompt hooks without name that share the same first 30 chars
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Prompt,
                prompt:
                  'This is a very long prompt that exceeds thirty characters and has ending A',
              },
              {
                type: HookType.Prompt,
                prompt:
                  'This is a very long prompt that exceeds thirty characters and has ending B',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      // Both hooks should be registered (not treated as duplicates)
      const hooks = registry.getAllHooks();
      expect(hooks).toHaveLength(2);
      expect(hooks[0].config.type).toBe(HookType.Prompt);
      expect(hooks[1].config.type).toBe(HookType.Prompt);
    });

    it('should skip truly duplicate unnamed prompt hooks with identical prompt', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Prompt,
                prompt: 'This is a test prompt',
              },
              {
                type: HookType.Prompt,
                prompt: 'This is a test prompt',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      // Only one hook should be registered (true duplicate)
      expect(registry.getAllHooks()).toHaveLength(1);
    });
  });

  describe('extension hooks', () => {
    it('should process hooks from active extensions', async () => {
      const extensionHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              { type: HookType.Command, command: 'echo ext', name: 'ext-hook' },
            ],
          },
        ],
      };
      mockConfig.getExtensions = vi
        .fn()
        .mockReturnValue([{ isActive: true, hooks: extensionHooks }]);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].source).toBe(HooksConfigSource.Extensions);
      expect(allHooks[0].config.name).toBe('ext-hook');
    });

    it('should skip hooks from inactive extensions', async () => {
      const extensionHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [{ type: HookType.Command, command: 'echo ext' }],
          },
        ],
      };
      mockConfig.getExtensions = vi
        .fn()
        .mockReturnValue([{ isActive: false, hooks: extensionHooks }]);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should process multiple extensions', async () => {
      mockConfig.getExtensions = vi.fn().mockReturnValue([
        {
          isActive: true,
          hooks: {
            [HookEventName.PreToolUse]: [
              {
                hooks: [
                  {
                    type: HookType.Command,
                    command: 'echo ext1',
                    name: 'ext1-hook',
                  },
                ],
              },
            ],
          },
        },
        {
          isActive: true,
          hooks: {
            [HookEventName.PreToolUse]: [
              {
                hooks: [
                  {
                    type: HookType.Command,
                    command: 'echo ext2',
                    name: 'ext2-hook',
                  },
                ],
              },
            ],
          },
        },
      ]);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(2);
    });
  });

  describe('hook metadata', () => {
    it('should preserve matcher in registry entry', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'ReadFileTool',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'matcher-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getAllHooks();
      expect(hooks[0].matcher).toBe('ReadFileTool');
    });

    it('should preserve sequential flag in registry entry', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            sequential: true,
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'seq-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getAllHooks();
      expect(hooks[0].sequential).toBe(true);
    });

    it('should add source to hook config', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'source-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getAllHooks();
      expect((hooks[0].config as { source?: unknown }).source).toBe(
        HooksConfigSource.User,
      );
    });
  });

  describe('getAllHooks', () => {
    it('should return a copy of entries array', async () => {
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'test-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks1 = registry.getAllHooks();
      const hooks2 = registry.getAllHooks();

      expect(hooks1).toEqual(hooks2);
      expect(hooks1).not.toBe(hooks2); // Different array reference
    });
  });
});
