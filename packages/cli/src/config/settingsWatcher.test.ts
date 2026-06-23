/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SettingsWatcher } from './settingsWatcher.js';
import {
  SettingScope,
  type LoadedSettings,
  type SettingsFile,
  type Settings,
} from './settings.js';
import type { SettingsChangeEvent } from './settingsWatcher.js';

type EventHandler = (...args: unknown[]) => void;

interface MockWatcherEntry {
  dir: string;
  handlers: Record<string, EventHandler>;
  instance: {
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

const { mockWatchers, mockExistsSync, mockMkdirSync, mockWatch } = vi.hoisted(
  () => {
    const mockWatchers: MockWatcherEntry[] = [];
    const mockExistsSync = vi.fn().mockReturnValue(true);
    const mockMkdirSync = vi.fn();

    const mockWatch = vi.fn().mockImplementation((dir: string) => {
      const handlers: Record<string, EventHandler> = {};
      const instance = {
        on: vi
          .fn()
          .mockImplementation((event: string, handler: EventHandler) => {
            handlers[event] = handler;
            return instance;
          }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockWatchers.push({ dir, handlers, instance });
      return instance;
    });

    return { mockWatchers, mockExistsSync, mockMkdirSync, mockWatch };
  },
);
const { mockDebugWarn } = vi.hoisted(() => ({
  mockDebugWarn: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      isEnabled: () => true,
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockDebugWarn,
      error: vi.fn(),
    }),
  };
});

vi.mock('chokidar', () => ({
  watch: mockWatch,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
  };
});

function s(obj: Record<string, unknown>): Settings {
  return obj as unknown as Settings;
}

function makeSettingsFile(overrides: Partial<SettingsFile> = {}): SettingsFile {
  return {
    settings: {},
    originalSettings: {},
    path: '/home/user/.qwen/settings.json',
    rawJson: '{}',
    ...overrides,
  };
}

function makeLoadedSettings(
  overrides: {
    user?: Partial<SettingsFile>;
    workspace?: Partial<SettingsFile>;
    workspaceSettingsActive?: boolean;
  } = {},
): LoadedSettings {
  const user = makeSettingsFile({
    path: '/home/user/.qwen/settings.json',
    ...overrides.user,
  });
  const workspace = makeSettingsFile({
    path: '/project/.qwen/settings.json',
    ...overrides.workspace,
  });
  return {
    user,
    workspace,
    forScope: vi.fn((scope: SettingScope) => {
      if (scope === SettingScope.User) return user;
      return workspace;
    }),
    reloadScopeFromDisk: vi.fn(),
    merged: {},
    workspaceSettingsActive: overrides.workspaceSettingsActive ?? true,
  } as unknown as LoadedSettings;
}

function fireAllEvent(
  watcherIndex: number,
  event: string,
  changedPath: string,
) {
  const entry = mockWatchers[watcherIndex];
  entry.handlers['all']?.(event, changedPath);
}

describe('SettingsWatcher', () => {
  let settings: LoadedSettings;
  let watcher: SettingsWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatchers.length = 0;
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReset();
    mockWatch.mockClear();
    mockDebugWarn.mockClear();
    settings = makeLoadedSettings();
    watcher = new SettingsWatcher(settings);
  });

  afterEach(() => {
    watcher.stopWatching();
    vi.useRealTimers();
  });

  describe('lifecycle', () => {
    it('should create chokidar watchers for user and workspace directories', () => {
      watcher.startWatching();

      expect(mockWatch).toHaveBeenCalledTimes(2);
      expect(mockWatch).toHaveBeenCalledWith(
        '/home/user/.qwen',
        expect.objectContaining({ ignoreInitial: true, depth: 0 }),
      );
      expect(mockWatch).toHaveBeenCalledWith(
        '/project/.qwen',
        expect.objectContaining({ ignoreInitial: true, depth: 0 }),
      );
    });

    it('should skip workspace watcher when workspace settings are inactive', () => {
      const inactiveSettings = makeLoadedSettings({
        workspaceSettingsActive: false,
      });
      const inactiveWatcher = new SettingsWatcher(inactiveSettings);

      inactiveWatcher.startWatching();

      expect(mockWatch).toHaveBeenCalledTimes(1);
      expect(mockWatch).toHaveBeenCalledWith(
        '/home/user/.qwen',
        expect.objectContaining({ ignoreInitial: true, depth: 0 }),
      );

      inactiveWatcher.stopWatching();
    });

    it('should watch active workspace even when settings file does not exist', () => {
      const noWorkspaceFileSettings = makeLoadedSettings({
        workspace: { rawJson: undefined, settings: {} },
        workspaceSettingsActive: true,
      });
      const noWorkspaceFileWatcher = new SettingsWatcher(
        noWorkspaceFileSettings,
      );

      noWorkspaceFileWatcher.startWatching();

      expect(mockWatch).toHaveBeenCalledTimes(2);
      expect(mockWatch).toHaveBeenCalledWith(
        '/project/.qwen',
        expect.objectContaining({ ignoreInitial: true, depth: 0 }),
      );

      noWorkspaceFileWatcher.stopWatching();
    });

    it('should be idempotent on double start', () => {
      watcher.startWatching();
      watcher.startWatching();

      expect(mockWatch).toHaveBeenCalledTimes(2);
    });

    it('should close all watchers on stop', () => {
      watcher.startWatching();
      watcher.stopWatching();

      expect(mockWatchers[0].instance.close).toHaveBeenCalled();
      expect(mockWatchers[1].instance.close).toHaveBeenCalled();
    });

    it('should be idempotent on double stop', () => {
      watcher.startWatching();
      watcher.stopWatching();
      watcher.stopWatching();

      expect(mockWatchers[0].instance.close).toHaveBeenCalledTimes(1);
    });

    it('should never create missing directories', () => {
      mockExistsSync.mockReturnValue(false);
      watcher.startWatching();

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should register error handler on each watcher', () => {
      watcher.startWatching();

      expect(mockWatchers[0].instance.on).toHaveBeenCalledWith(
        'error',
        expect.any(Function),
      );
    });

    it('should pass ignored filter that rejects special file types', () => {
      watcher.startWatching();

      const watchCall = mockWatch.mock.calls[0] as [
        string,
        {
          ignored: (
            p: string,
            s?: { isFile(): boolean; isDirectory(): boolean },
          ) => boolean;
        },
      ];
      const ignoredFn = watchCall[1].ignored;

      expect(
        ignoredFn('/some/file', {
          isFile: () => true,
          isDirectory: () => false,
        }),
      ).toBe(false);
      expect(
        ignoredFn('/some/socket', {
          isFile: () => false,
          isDirectory: () => false,
        }),
      ).toBe(true);
    });
  });

  describe('path filtering', () => {
    it('should trigger refresh only for settings.json basename', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({ ui: { theme: 'dark' } });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).toHaveBeenCalledWith(
        SettingScope.User,
      );
      expect(listener).toHaveBeenCalled();
    });

    it('should ignore .tmp files', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json.tmp');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('should ignore .orig files', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json.orig');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).not.toHaveBeenCalled();
    });

    it('should ignore unrelated files in the same directory', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      fireAllEvent(0, 'change', '/home/user/.qwen/other-file.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).not.toHaveBeenCalled();
    });
  });

  describe('debouncing', () => {
    it('should coalesce multiple rapid events into one reload', async () => {
      watcher.startWatching();

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({ count: 1 });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');

      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).toHaveBeenCalledTimes(1);
    });

    it('should batch changes from different scopes in one debounce window', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({
            scope: scope.toString(),
          });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      fireAllEvent(1, 'change', '/project/.qwen/settings.json');

      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledTimes(1);
      const events: SettingsChangeEvent[] = listener.mock.calls[0][0];
      expect(events).toHaveLength(2);
    });
  });

  describe('semantic diff', () => {
    it('should not notify when content is unchanged', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('should notify when content changes', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({ newKey: 'newValue' });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).toHaveBeenCalledTimes(1);
      const events: SettingsChangeEvent[] = listener.mock.calls[0][0];
      expect(events).toHaveLength(1);
      expect(events[0].scope).toBe(SettingScope.User);
      expect(events[0].changeType).toBe('modified');
    });

    it('should suppress self-writes (setValue mutates memory before disk write)', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ theme: 'dark' });

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        // no-op: disk matches memory
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should not notify on format/comment-only changes (resolved settings identical)', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        // no-op: settings stay the same after stripping comments
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('self-write with concurrent external edit', () => {
    it('should notify when external edit changes content beyond the self-write', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ theme: 'dark' });

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        userFile.settings = s({ theme: 'light' });
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).toHaveBeenCalledTimes(1);
      const events: SettingsChangeEvent[] = listener.mock.calls[0][0];
      expect(events[0].changeType).toBe('modified');
    });
  });

  describe('restart-required suppression', () => {
    it('should suppress when only restart-required keys change (env)', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ env: { FOO: 'a' } });

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        userFile.settings = s({ env: { FOO: 'b' } });
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should suppress when only credentials change (security.auth.apiKey)', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ security: { auth: { apiKey: 'old' } } });

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        userFile.settings = s({ security: { auth: { apiKey: 'new' } } });
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should notify when a hot-reloadable key changes (ui.theme)', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ ui: { theme: 'dark' } });

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        userFile.settings = s({ ui: { theme: 'light' } });
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should notify when a hot-reloadable key changes alongside a restart-required one', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ ui: { theme: 'dark' }, env: { FOO: 'a' } });

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        userFile.settings = s({ ui: { theme: 'light' }, env: { FOO: 'b' } });
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should notify on an unknown (non-schema) key change rather than silently suppress', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ someCustomKey: 1 });

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        userFile.settings = s({ someCustomKey: 2 });
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('change type classification', () => {
    it('should report created when file appears', async () => {
      const noFileSettings = makeLoadedSettings({
        user: { rawJson: undefined, settings: {} },
      });
      const w = new SettingsWatcher(noFileSettings);
      w.startWatching();
      const listener = vi.fn();
      w.addChangeListener(listener);

      vi.mocked(noFileSettings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          const file = noFileSettings.forScope(scope);
          file.settings = s({ key: 'value' });
          file.rawJson = '{"key":"value"}';
        },
      );

      const userIdx = mockWatchers.length - 2;
      fireAllEvent(userIdx, 'add', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      const events: SettingsChangeEvent[] = listener.mock.calls[0][0];
      expect(events[0].changeType).toBe('created');

      w.stopWatching();
    });

    it('should report deleted when file disappears', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      // Seed real (hot-reloadable) content so the deletion actually removes a
      // key — deleting an empty-content file has nothing to hot-reload.
      const userFile = settings.forScope(SettingScope.User);
      userFile.settings = s({ ui: { theme: 'dark' } });
      userFile.rawJson = '{"ui":{"theme":"dark"}}';

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          const file = settings.forScope(scope);
          file.settings = {};
          file.rawJson = undefined;
        },
      );

      fireAllEvent(0, 'unlink', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      const events: SettingsChangeEvent[] = listener.mock.calls[0][0];
      expect(events[0].changeType).toBe('deleted');
    });
  });

  describe('listener management', () => {
    it('should support unsubscribe', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      const unsub = watcher.addChangeListener(listener);

      unsub();

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({ a: 1 });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should isolate listener errors', async () => {
      watcher.startWatching();
      const failingListener = vi.fn().mockRejectedValue(new Error('boom'));
      const goodListener = vi.fn();
      watcher.addChangeListener(failingListener);
      watcher.addChangeListener(goodListener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({ changed: true });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(failingListener).toHaveBeenCalled();
      expect(goodListener).toHaveBeenCalled();
    });

    it('should enforce listener timeout', async () => {
      watcher.startWatching();
      const slowListener = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, SettingsWatcher.LISTENER_TIMEOUT_MS + 5000);
          }),
      );
      watcher.addChangeListener(slowListener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({ slow: true });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(
        SettingsWatcher.DEBOUNCE_MS + SettingsWatcher.LISTENER_TIMEOUT_MS + 100,
      );

      expect(slowListener).toHaveBeenCalled();
    });
  });

  describe('watcher creation failure', () => {
    it('should continue with remaining scopes when chokidar throws', () => {
      let callCount = 0;
      mockWatch.mockImplementation((dir: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('EACCES: permission denied');
        }
        const handlers: Record<string, EventHandler> = {};
        const instance = {
          on: vi
            .fn()
            .mockImplementation((event: string, handler: EventHandler) => {
              handlers[event] = handler;
              return instance;
            }),
          close: vi.fn().mockResolvedValue(undefined),
        };
        mockWatchers.push({ dir, handlers, instance });
        return instance;
      });

      watcher.startWatching();

      expect(mockWatchers).toHaveLength(1);
      expect(mockWatchers[0].dir).toBe('/project/.qwen');
    });

    it('should continue with bootstrap watcher when target dir is missing', () => {
      mockExistsSync.mockReturnValue(false);

      watcher.startWatching();

      // No directory is ever created on the user's behalf.
      expect(mockMkdirSync).not.toHaveBeenCalled();
      // Both scopes bootstrap-watch their parent dirs.
      expect(mockWatch).toHaveBeenCalledTimes(2);
      expect(mockWatch).toHaveBeenCalledWith(
        '/home/user',
        expect.objectContaining({ ignoreInitial: true, depth: 0 }),
      );
      expect(mockWatch).toHaveBeenCalledWith(
        '/project',
        expect.objectContaining({ ignoreInitial: true, depth: 0 }),
      );
    });
  });

  describe('lazy directory watching', () => {
    // promote/demote await chokidar's async close(); flush microtasks/timers.
    const flush = () => vi.advanceTimersByTimeAsync(0);

    function lastWatchOptions(): {
      ignored?: (p: string, stats?: unknown) => boolean;
    } {
      const calls = mockWatch.mock.calls;
      return calls[calls.length - 1][1] as {
        ignored?: (p: string, stats?: unknown) => boolean;
      };
    }

    it('should never create the settings directory', () => {
      mockExistsSync.mockReturnValue(false);

      watcher.startWatching();

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should bootstrap-watch the parent when the dir is missing', () => {
      const workspaceOnly = makeLoadedSettings({
        workspaceSettingsActive: false,
      });
      const w = new SettingsWatcher(workspaceOnly);
      mockExistsSync.mockReturnValue(false);

      w.startWatching();

      expect(mockWatch).toHaveBeenCalledTimes(1);
      expect(mockWatch).toHaveBeenCalledWith(
        '/home/user',
        expect.objectContaining({ ignoreInitial: true, depth: 0 }),
      );

      w.stopWatching();
    });

    it('bootstrap ignored predicate allows only the .qwen entry', () => {
      const workspaceOnly = makeLoadedSettings({
        workspaceSettingsActive: false,
        user: { path: '/home/user/.qwen/settings.json' },
      });
      const w = new SettingsWatcher(workspaceOnly);
      mockExistsSync.mockReturnValue(false);

      w.startWatching();

      const { ignored } = lastWatchOptions();
      expect(ignored).toBeTypeOf('function');
      // Watch root and the target dir are allowed (not ignored).
      expect(ignored!('/home/user')).toBe(false);
      expect(ignored!('/home/user/.qwen')).toBe(false);
      // Unrelated top-level entries are ignored.
      expect(ignored!('/home/user/Documents')).toBe(true);
      expect(ignored!('/home/user/.bashrc')).toBe(true);

      w.stopWatching();
    });

    it('should promote to a target watcher when .qwen appears', async () => {
      const workspaceOnly = makeLoadedSettings({
        workspaceSettingsActive: false,
      });
      const w = new SettingsWatcher(workspaceOnly);
      mockExistsSync.mockReturnValue(false);
      w.startWatching();

      // Bootstrap watcher on the parent.
      expect(mockWatchers).toHaveLength(1);
      expect(mockWatchers[0].dir).toBe('/home/user');

      // `.qwen` is created.
      fireAllEvent(0, 'addDir', '/home/user/.qwen');
      await flush();

      // Bootstrap closed, target watcher opened on `.qwen`.
      expect(mockWatchers[0].instance.close).toHaveBeenCalled();
      expect(mockWatchers).toHaveLength(2);
      expect(mockWatchers[1].dir).toBe('/home/user/.qwen');

      // A settings.json already inside `.qwen` is picked up via a refresh.
      vi.mocked(workspaceOnly.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          workspaceOnly.forScope(scope).settings = s({ promoted: true });
        },
      );
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);
      expect(workspaceOnly.reloadScopeFromDisk).toHaveBeenCalledWith(
        SettingScope.User,
      );

      w.stopWatching();
    });

    it('should promote immediately when .qwen appears during the TOCTOU window', async () => {
      const workspaceOnly = makeLoadedSettings({
        workspaceSettingsActive: false,
      });
      const w = new SettingsWatcher(workspaceOnly);
      // Branch check: missing; TOCTOU re-check: now present.
      mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);

      w.startWatching();
      await flush();

      // Bootstrap on parent, then immediate promote to `.qwen` without an event.
      expect(mockWatchers).toHaveLength(2);
      expect(mockWatchers[0].dir).toBe('/home/user');
      expect(mockWatchers[1].dir).toBe('/home/user/.qwen');

      w.stopWatching();
    });

    it('should demote back to bootstrap when .qwen is removed', async () => {
      const workspaceOnly = makeLoadedSettings({
        workspaceSettingsActive: false,
      });
      const w = new SettingsWatcher(workspaceOnly);
      // dir exists at startup -> target watcher; gone afterwards so the
      // post-demote TOCTOU re-check does not immediately re-promote.
      mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false);
      w.startWatching();

      expect(mockWatchers).toHaveLength(1);
      expect(mockWatchers[0].dir).toBe('/home/user/.qwen');

      // `.qwen` directory itself is removed.
      fireAllEvent(0, 'unlinkDir', '/home/user/.qwen');
      await flush();

      // Re-bootstrapped on the parent.
      expect(mockWatchers[0].instance.close).toHaveBeenCalled();
      expect(mockWatchers).toHaveLength(2);
      expect(mockWatchers[1].dir).toBe('/home/user');

      // A subsequent re-create promotes again.
      fireAllEvent(1, 'addDir', '/home/user/.qwen');
      await flush();
      expect(mockWatchers).toHaveLength(3);
      expect(mockWatchers[2].dir).toBe('/home/user/.qwen');

      w.stopWatching();
    });

    it('should not double-promote from a stale bootstrap callback', async () => {
      const workspaceOnly = makeLoadedSettings({
        workspaceSettingsActive: false,
      });
      const w = new SettingsWatcher(workspaceOnly);
      mockExistsSync.mockReturnValue(false);
      w.startWatching();

      // First promotion.
      fireAllEvent(0, 'addDir', '/home/user/.qwen');
      await flush();
      expect(mockWatchers).toHaveLength(2);

      // A stale event from the already-closed bootstrap watcher must be ignored
      // by the generation guard — no second target watcher is created.
      fireAllEvent(0, 'addDir', '/home/user/.qwen');
      await flush();
      expect(mockWatchers).toHaveLength(2);
      const targetWatchers = mockWatchers.filter(
        (m) => m.dir === '/home/user/.qwen',
      );
      expect(targetWatchers).toHaveLength(1);

      w.stopWatching();
    });
  });

  describe('reloadScopeFromDisk failure', () => {
    it('should not notify when reload preserves old state (internal catch)', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        // reloadScopeFromDisk catches internally, settings unchanged
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should log rejected refreshes', async () => {
      watcher.startWatching();
      const error = new Error('reload failed');
      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(() => {
        throw error;
      });

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(mockDebugWarn).toHaveBeenCalledWith(
        'Settings watcher refresh error:',
        error,
      );
    });
  });

  describe('stopWatching clears pending state', () => {
    it('should cancel pending debounce timer on stop', async () => {
      watcher.startWatching();
      const listener = vi.fn();
      watcher.addChangeListener(listener);

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          settings.forScope(scope).settings = s({ pending: true });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');

      watcher.stopWatching();

      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 100);

      expect(settings.reloadScopeFromDisk).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('path resolution', () => {
    it('should use resolved paths from LoadedSettings (supports QWEN_HOME redirect)', () => {
      const customSettings = makeLoadedSettings({
        user: { path: '/custom/qwen-home/settings.json' },
      });
      const w = new SettingsWatcher(customSettings);
      w.startWatching();

      expect(mockWatch).toHaveBeenCalledWith(
        '/custom/qwen-home',
        expect.any(Object),
      );

      w.stopWatching();
    });
  });

  describe('serialization', () => {
    it('should not overlap handleChange runs', async () => {
      watcher.startWatching();
      let callCount = 0;

      vi.mocked(settings.reloadScopeFromDisk).mockImplementation(
        (scope: SettingScope) => {
          callCount++;
          settings.forScope(scope).settings = s({ call: callCount });
        },
      );

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      fireAllEvent(0, 'change', '/home/user/.qwen/settings.json');
      await vi.advanceTimersByTimeAsync(SettingsWatcher.DEBOUNCE_MS + 10);

      expect(settings.reloadScopeFromDisk).toHaveBeenCalledTimes(2);
    });
  });
});
