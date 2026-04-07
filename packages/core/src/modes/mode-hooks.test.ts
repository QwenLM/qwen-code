/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ModeHookRegistry } from './mode-hooks.js';
import type { Config } from '../config/config.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  exec: vi.fn(
    (
      cmd: string,
      _opts: unknown,
      cb: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (cmd.includes('fail')) {
        cb(new Error('Command failed'), { stdout: '', stderr: 'error' });
      } else {
        cb(null, { stdout: 'output\n', stderr: '' });
      }
    },
  ),
}));

vi.mock('node:util', () => ({
  promisify: vi.fn((fn: (...args: unknown[]) => void) => async (...args: unknown[]) => new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      })),
}));

describe('ModeHookRegistry', () => {
  let registry: ModeHookRegistry;
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getWorkingDir: vi.fn().mockReturnValue('/test/project'),
    } as unknown as Config;
    registry = new ModeHookRegistry(mockConfig);
  });

  describe('registerHooks', () => {
    it('should register hooks for a mode', () => {
      registry.registerHooks('developer', [
        { trigger: 'onEnter', commandType: 'shell', command: 'git status' },
      ]);

      const hooks = registry.getHooks('developer');
      expect(hooks).toHaveLength(1);
      expect(hooks[0].command).toBe('git status');
    });

    it('should register multiple hooks', () => {
      registry.registerHooks('developer', [
        { trigger: 'onEnter', commandType: 'shell', command: 'git status' },
        { trigger: 'onExit', commandType: 'message', command: 'Leaving' },
      ]);

      expect(registry.getHooks('developer')).toHaveLength(2);
    });

    it('should return empty array for unregistered mode', () => {
      expect(registry.getHooks('nonexistent')).toEqual([]);
    });
  });

  describe('executeHooks', () => {
    beforeEach(() => {
      registry.registerHooks('developer', [
        { trigger: 'onEnter', commandType: 'shell', command: 'echo hello' },
        { trigger: 'onExit', commandType: 'message', command: 'Goodbye' },
      ]);
    });

    it('should execute matching hooks', async () => {
      const results = await registry.executeHooks('developer', 'onEnter');

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].hook.commandType).toBe('shell');
    });

    it('should return empty array when no matching hooks', async () => {
      const results = await registry.executeHooks('developer', 'onStart');
      expect(results).toHaveLength(0);
    });

    it('should execute message hooks and return the message', async () => {
      const results = await registry.executeHooks('developer', 'onExit');

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('Goodbye');
    });

    it('should handle command failures', async () => {
      registry.registerHooks('dev', [
        { trigger: 'onEnter', commandType: 'shell', command: 'fail cmd' },
      ]);

      const results = await registry.executeHooks('dev', 'onEnter');

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeDefined();
    });

    it('should stop on first failure when continueOnError is false', async () => {
      registry.registerHooks('dev', [
        {
          trigger: 'onEnter',
          commandType: 'shell',
          command: 'fail cmd',
          continueOnError: false,
        },
        {
          trigger: 'onEnter',
          commandType: 'message',
          command: 'Should not run',
        },
      ]);

      const results = await registry.executeHooks('dev', 'onEnter');

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
    });

    it('should continue on failure when continueOnError is true', async () => {
      registry.registerHooks('dev', [
        {
          trigger: 'onEnter',
          commandType: 'shell',
          command: 'fail cmd',
          continueOnError: true,
        },
        { trigger: 'onEnter', commandType: 'message', command: 'Still runs' },
      ]);

      const results = await registry.executeHooks('dev', 'onEnter');

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });
  });

  describe('conditional execution', () => {
    it('should skip hook when envVarSet condition is not met', async () => {
      const originalEnv = process.env.TEST_VAR;
      delete process.env.TEST_VAR;

      registry.registerHooks('dev', [
        {
          trigger: 'onEnter',
          commandType: 'message',
          command: 'Should not appear',
          condition: { envVarSet: 'TEST_VAR' },
        },
      ]);

      const results = await registry.executeHooks('dev', 'onEnter');
      expect(results).toHaveLength(0);

      process.env.TEST_VAR = originalEnv;
    });

    it('should execute hook when envVarSet condition is met', async () => {
      process.env.TEST_HOOK_VAR = 'set';

      registry.registerHooks('dev', [
        {
          trigger: 'onEnter',
          commandType: 'message',
          command: 'Should appear',
          condition: { envVarSet: 'TEST_HOOK_VAR' },
        },
      ]);

      const results = await registry.executeHooks('dev', 'onEnter');
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      delete process.env.TEST_HOOK_VAR;
    });
  });

  describe('slash command hooks', () => {
    it('should return slash command for UI processing', async () => {
      registry.registerHooks('dev', [
        { trigger: 'onEnter', commandType: 'slash', command: '/test run' },
      ]);

      const results = await registry.executeHooks('dev', 'onEnter');

      expect(results).toHaveLength(1);
      expect(results[0].output).toBe('/test run');
    });
  });

  describe('clearHooks', () => {
    it('should remove all hooks for a mode', () => {
      registry.registerHooks('dev', [
        { trigger: 'onEnter', commandType: 'shell', command: 'echo' },
      ]);

      registry.clearHooks('dev');

      expect(registry.getHooks('dev')).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should return hook counts per mode', () => {
      registry.registerHooks('dev', [
        { trigger: 'onEnter', commandType: 'shell', command: 'echo' },
        { trigger: 'onExit', commandType: 'message', command: 'bye' },
      ]);
      registry.registerHooks('test', [
        { trigger: 'onEnter', commandType: 'shell', command: 'npm test' },
      ]);

      const stats = registry.getStats();

      expect(stats.get('dev')).toBe(2);
      expect(stats.get('test')).toBe(1);
    });
  });
});
