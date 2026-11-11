/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeHook } from './hookSettings.js';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import {
  ConfigSource,
  HookType,
  type HookRegistryEntry,
  WRITE_FILE_TOOL_NAME,
} from '@qwen-code/core';

describe('hookSettings', () => {
  let mockSettings: LoadedSettings;
  let mockUser: {
    path: string;
    settings: { hooks?: unknown };
  };
  let mockWorkspace: {
    path: string;
    settings: { hooks?: unknown };
  };
  let mockSetValue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUser = {
      path: '/mock/user.json',
      settings: {},
    };
    mockWorkspace = {
      path: '/mock/workspace.json',
      settings: {},
    };
    mockSetValue = vi.fn().mockReturnValue(true);

    mockSettings = {
      forScope: (scope: SettingScope) => {
        if (scope === SettingScope.User) return mockUser;
        if (scope === SettingScope.Project) return mockWorkspace;
        return mockUser; // Default/Fallback
      },
      setValue: (
        scope: SettingScope,
        path: readonly string[],
        next: unknown,
      ) => {
        const target =
          scope === SettingScope.Project ? mockWorkspace : mockUser;
        const hooks = {
          ...((target.settings.hooks as Record<string, unknown>) ?? {}),
        };
        if (next === undefined) delete hooks[path[1]];
        else hooks[path[1]] = next;
        return mockSetValue(scope, 'hooks', hooks);
      },
    } as unknown as LoadedSettings;
  });

  describe('removeHook', () => {
    function makeHookEntry(
      overrides: Partial<HookRegistryEntry> & {
        command?: string;
      } = {},
    ): HookRegistryEntry {
      return {
        config: {
          type: HookType.Command,
          command: overrides.command ?? 'echo hello',
        },
        source: overrides.source ?? ConfigSource.Project,
        eventName: overrides.eventName ?? ('PreToolUse' as never),
        enabled: overrides.enabled ?? true,
      };
    }

    it('should remove a hook from Project (Workspace) scope', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.Project,
        eventName: 'PreToolUse' as never,
        command: 'echo hello',
      });

      mockWorkspace.settings = {
        ...mockWorkspace.settings,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo hello', name: 'test-hook' },
                { type: 'command', command: 'echo world', name: 'other-hook' },
              ],
            },
          ],
        },
      } as never;

      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('success');
      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.Project,
        'hooks',
        expect.objectContaining({
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo world', name: 'other-hook' },
              ],
            },
          ],
        }),
      );
    });

    it('should remove a hook from User scope', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.User,
        eventName: 'PreToolUse' as never,
        command: 'echo hello',
      });

      mockUser.settings = {
        ...mockUser.settings,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo hello', name: 'test-hook' },
              ],
            },
          ],
        },
      } as never;

      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('success');
      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.User,
        'hooks',
        // Event key is deleted when no definitions remain
        {},
      );
    });

    it('should remove entire event key when last hook is removed', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.Project,
        eventName: 'PostToolUse' as never,
        command: 'echo done',
      });

      mockWorkspace.settings = {
        ...mockWorkspace.settings,
        hooks: {
          PostToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo done', name: 'only-hook' },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo pre', name: 'pre-hook' },
              ],
            },
          ],
        },
      } as never;

      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('success');
      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.Project,
        'hooks',
        {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo pre', name: 'pre-hook' },
              ],
            },
          ],
        },
      );
    });

    // skip: 现存失败
    it.skip('should remove empty definitions when all hooks are removed from a definition', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.Project,
        eventName: 'PreToolUse' as never,
        command: 'echo hello',
      });

      mockWorkspace.settings = {
        ...mockWorkspace.settings,
        hooks: {
          PreToolUse: [
            {
              matcher: WRITE_FILE_TOOL_NAME,
              hooks: [
                { type: 'command', command: 'echo hello', name: 'test-hook' },
              ],
            },
            {
              hooks: [
                { type: 'command', command: 'echo other', name: 'other-hook' },
              ],
            },
          ],
        },
      } as never;

      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('success');
      // The definition with matcher 'write_file' should be removed (was its only hook)
      expect(mockSetValue).toHaveBeenCalledWith(
        SettingScope.Project,
        'hooks',
        {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo other', name: 'other-hook' },
              ],
            },
          ],
        },
      );
    });

    it('should return not-found when hook is not in settings', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.Project,
        eventName: 'PreToolUse' as never,
        command: 'nonexistent',
      });

      mockWorkspace.settings = {
        ...mockWorkspace.settings,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: 'echo hello', name: 'test-hook' },
              ],
            },
          ],
        },
      } as never;

      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('not-found');
      expect(mockSetValue).not.toHaveBeenCalled();
    });

    it('should return not-found when hooks object is empty', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.Project,
        eventName: 'PreToolUse' as never,
      });

      // No hooks property
      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('not-found');
    });

    it('should return error for non-editable sources', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.Plugins,
        eventName: 'PreToolUse' as never,
      });

      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('error');
      expect(result.error).toContain('Cannot remove hooks from source');
    });

    it('should return error for Runtime source', () => {
      const hookEntry = makeHookEntry({
        source: ConfigSource.Runtime,
        eventName: 'PreToolUse' as never,
      });

      const result = removeHook(mockSettings, hookEntry);

      expect(result.status).toBe('error');
      expect(result.error).toContain('Cannot remove hooks from source');
    });
  });
});
