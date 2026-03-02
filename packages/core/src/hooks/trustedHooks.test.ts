/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

// Mock before import
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../config/storage.js', () => ({
  Storage: {
    getGlobalQwenDir: vi.fn().mockReturnValue('/test/global/qwen'),
  },
}));

import { TrustedHooksManager } from './trustedHooks.js';
import { HookEventName, HookType } from './types.js';

describe('TrustedHooksManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getUntrustedHooks', () => {
    it('should return empty array when no hooks provided', () => {
      const manager = new TrustedHooksManager();
      const result = manager.getUntrustedHooks('/project/test', {});
      expect(result).toEqual([]);
    });

    it('should return all hooks as untrusted when no trusted hooks exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const manager = new TrustedHooksManager();

      const hooks = {
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

      const result = manager.getUntrustedHooks('/project/test', hooks);
      expect(result).toContain('test-hook');
    });

    it('should not return hooks that are already trusted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          '/project/test': ['test-hook:echo test'],
        }),
      );

      const manager = new TrustedHooksManager();

      const hooks = {
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

      const result = manager.getUntrustedHooks('/project/test', hooks);
      expect(result).toEqual([]);
    });

    it('should use command as key when name is not provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const manager = new TrustedHooksManager();

      const hooks = {
        [HookEventName.PostToolUse]: [
          {
            hooks: [{ type: HookType.Command, command: 'log-result.sh' }],
          },
        ],
      };

      const result = manager.getUntrustedHooks('/project/test', hooks);
      expect(result).toContain('log-result.sh');
    });

    it('should handle multiple event types', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const manager = new TrustedHooksManager();

      const hooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              { type: HookType.Command, command: 'pre-hook.sh', name: 'pre' },
            ],
          },
        ],
        [HookEventName.PostToolUse]: [
          {
            hooks: [
              { type: HookType.Command, command: 'post-hook.sh', name: 'post' },
            ],
          },
        ],
        [HookEventName.Notification]: [
          {
            hooks: [
              { type: HookType.Command, command: 'notify.sh', name: 'notify' },
            ],
          },
        ],
      };

      const result = manager.getUntrustedHooks('/project/test', hooks);
      expect(result).toContain('pre');
      expect(result).toContain('post');
      expect(result).toContain('notify');
    });
  });

  describe('trustHooks', () => {
    it('should add hooks to trusted list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      const manager = new TrustedHooksManager();
      const hooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'new-hook',
              },
            ],
          },
        ],
      };

      manager.trustHooks('/project/test', hooks);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should handle empty hooks gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      const manager = new TrustedHooksManager();

      expect(() => manager.trustHooks('/project/test', {})).not.toThrow();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle corrupted JSON in config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid json');

      expect(() => new TrustedHooksManager()).not.toThrow();
    });

    it('should handle write errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Write error');
      });

      const manager = new TrustedHooksManager();
      const hooks = {
        [HookEventName.PreToolUse]: [
          { hooks: [{ type: HookType.Command, command: 'test.sh' }] },
        ],
      };

      expect(() => manager.trustHooks('/project/test', hooks)).not.toThrow();
    });
  });
});
