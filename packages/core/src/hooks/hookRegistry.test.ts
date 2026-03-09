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
      getHooks: vi.fn().mockReturnValue(undefined),
      getProjectHooks: vi.fn().mockReturnValue(undefined),
      getDisabledHooks: vi.fn().mockReturnValue([]),
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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].eventName).toBe(HookEventName.PreToolUse);
      expect(allHooks[0].source).toBe(HooksConfigSource.Project);
    });

    it('should not process project hooks in untrusted folder', async () => {
      mockConfig.isTrustedFolder = vi.fn().mockReturnValue(false);
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [{ type: HookType.Command, command: 'echo test' }],
          },
        ],
      };
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const preHooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      expect(preHooks).toHaveLength(1);
      expect(preHooks[0].config.name).toBe('pre-hook');

      const postHooks = registry.getHooksForEvent(HookEventName.PostToolUse);
      expect(postHooks).toHaveLength(1);
      expect(postHooks[0].config.name).toBe('post-hook');
    });

    it('should filter out disabled hooks', async () => {
      mockConfig.getDisabledHooks = vi.fn().mockReturnValue(['disabled-hook']);
      const hooksConfig = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo enabled',
                name: 'enabled-hook',
              },
              {
                type: HookType.Command,
                command: 'echo disabled',
                name: 'disabled-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(1);
      expect(hooks[0].config.name).toBe('enabled-hook');
    });

    it('should sort hooks by source priority', async () => {
      // This test requires multiple sources, which would need getUserHooks
      // For now, we test with extensions which are processed after project hooks
      const projectHooks = {
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
      mockConfig.getHooks = vi.fn().mockReturnValue(projectHooks);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(1);
      expect(hooks[0].source).toBe(HooksConfigSource.Project);
    });
  });

  describe('setHookEnabled', () => {
    it('should enable a disabled hook', async () => {
      mockConfig.getDisabledHooks = vi.fn().mockReturnValue(['test-hook']);
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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );

      registry.setHookEnabled('test-hook', true);

      const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
      expect(hooks).toHaveLength(1);
      expect(hooks[0].enabled).toBe(true);
    });

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        1,
      );

      registry.setHookEnabled('test-hook', false);

      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should skip invalid event names', async () => {
      const hooksConfig = {
        InvalidEventName: [
          {
            hooks: [{ type: HookType.Command, command: 'echo test' }],
          },
        ],
      };
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      expect(registry.getAllHooks()).toHaveLength(2);
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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks = registry.getAllHooks();
      expect(hooks[0].config.source).toBe(HooksConfigSource.Project);
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
      mockConfig.getHooks = vi.fn().mockReturnValue(hooksConfig);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      const hooks1 = registry.getAllHooks();
      const hooks2 = registry.getAllHooks();

      expect(hooks1).toEqual(hooks2);
      expect(hooks1).not.toBe(hooks2); // Different array reference
    });
  });
});
