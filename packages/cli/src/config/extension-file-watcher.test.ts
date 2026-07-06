/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import { ExtensionFileWatcher } from './extension-file-watcher.js';
import type { ExtensionRefreshState } from './extension-refresh-state.js';

type EventHandler = (...args: unknown[]) => void;

interface MockWatcherEntry {
  target: string | string[];
  options: Record<string, unknown>;
  handlers: Record<string, EventHandler>;
  instance: {
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

const { mockWatchers, mockWatch, mockExistsSync } = vi.hoisted(() => {
  const mockWatchers: MockWatcherEntry[] = [];
  const mockExistsSync = vi.fn().mockReturnValue(true);
  const mockWatch = vi
    .fn()
    .mockImplementation(
      (target: string | string[], options: Record<string, unknown>) => {
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
        mockWatchers.push({ target, options, handlers, instance });
        return instance;
      },
    );
  return { mockWatchers, mockWatch, mockExistsSync };
});

vi.mock('chokidar', () => ({
  watch: mockWatch,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

function configWithExtensions(extensions: unknown[]): Config {
  return {
    getExtensions: () => extensions,
    getActiveExtensions: () => extensions,
    getExtensionManager: () => ({
      addMutationListener: vi.fn(() => vi.fn()),
    }),
  } as unknown as Config;
}

function createRefreshState(): ExtensionRefreshState {
  return {
    markExtensionContentChanged: vi.fn(),
    markExtensionsChanged: vi.fn(),
    beginSuppression: vi.fn((onSettle?: () => void) => () => onSettle?.()),
  } as unknown as ExtensionRefreshState;
}

function fireAllEvent(
  watcherIndex: number,
  event: string,
  changedPath: string,
) {
  mockWatchers[watcherIndex].handlers['all']?.(event, changedPath);
}

describe('ExtensionFileWatcher', () => {
  const extensionsDir = '/home/user/.qwen/extensions';

  beforeEach(() => {
    vi.clearAllMocks();
    mockWatchers.length = 0;
    mockExistsSync.mockReturnValue(true);
  });

  it('watches the extensions directory and linked extension sources', () => {
    const linkedSource = path.resolve('relative-linked-extension');
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([
        {
          path: linkedSource,
          config: {},
          installMetadata: {
            type: 'link',
            source: 'relative-linked-extension',
          },
          contextFiles: [],
        },
      ]),
      extensionsDir,
      refreshState,
    );

    watcher.startWatching();

    expect(mockWatch).toHaveBeenCalledOnce();
    expect(mockWatchers[0].target).toEqual([extensionsDir, linkedSource]);
    expect(mockWatchers[0].options).toEqual(
      expect.objectContaining({
        ignoreInitial: true,
        followSymlinks: false,
      }),
    );
  });

  it('marks refresh needed for manual extension add and remove events', () => {
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([]),
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    fireAllEvent(0, 'addDir', `${extensionsDir}/new-extension`);
    fireAllEvent(0, 'unlinkDir', `${extensionsDir}/old-extension`);

    expect(refreshState.markExtensionsChanged).toHaveBeenCalledTimes(2);
  });

  it('marks stale refresh needed for inventory and hook files', () => {
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([
        {
          path: `${extensionsDir}/alpha`,
          config: {},
          installMetadata: undefined,
          contextFiles: [],
        },
      ]),
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    fireAllEvent(0, 'change', `${extensionsDir}/alpha/qwen-extension.json`);
    fireAllEvent(0, 'change', `${extensionsDir}/alpha/hooks/hooks.json`);
    fireAllEvent(0, 'change', `${extensionsDir}/extension-enablement.json`);

    expect(refreshState.markExtensionsChanged).toHaveBeenCalledTimes(3);
    expect(refreshState.markExtensionContentChanged).not.toHaveBeenCalled();
  });

  it('auto-refreshes command, skill, and agent content changes', () => {
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([]),
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    fireAllEvent(0, 'add', `${extensionsDir}/alpha/commands/run.toml`);
    fireAllEvent(0, 'unlink', `${extensionsDir}/alpha/skills/demo/SKILL.md`);
    fireAllEvent(0, 'change', `${extensionsDir}/alpha/agents/reviewer.md`);

    expect(refreshState.markExtensionContentChanged).toHaveBeenCalledTimes(3);
    expect(refreshState.markExtensionsChanged).not.toHaveBeenCalled();
  });

  it('treats content events as stale when the extension manifest is gone', () => {
    mockExistsSync.mockImplementation(
      (filePath: string) => !filePath.endsWith('/alpha/qwen-extension.json'),
    );
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([]),
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    fireAllEvent(0, 'unlink', `${extensionsDir}/alpha/commands/run.toml`);

    expect(refreshState.markExtensionsChanged).toHaveBeenCalledOnce();
    expect(refreshState.markExtensionContentChanged).not.toHaveBeenCalled();
  });

  it('marks refresh needed for linked source changes and context files', () => {
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([
        {
          path: '/tmp/linked-extension',
          config: {},
          installMetadata: { type: 'link', source: '/tmp/linked-extension' },
          contextFiles: ['/tmp/linked-extension/GEMINI.md'],
        },
      ]),
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    fireAllEvent(0, 'change', '/tmp/linked-extension/qwen-extension.json');
    fireAllEvent(0, 'change', '/tmp/linked-extension/GEMINI.md');
    fireAllEvent(0, 'change', '/tmp/linked-extension/commands/run.toml');

    expect(refreshState.markExtensionsChanged).toHaveBeenCalledTimes(2);
    expect(refreshState.markExtensionContentChanged).toHaveBeenCalledOnce();
  });

  it('does not watch inactive linked extension sources or context files', () => {
    const activeSource = '/tmp/active-linked-extension';
    const inactiveSource = '/tmp/inactive-linked-extension';
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      {
        getExtensions: () => [
          {
            path: activeSource,
            config: {},
            installMetadata: { type: 'link', source: activeSource },
            contextFiles: [`${activeSource}/QWEN.md`],
          },
          {
            path: inactiveSource,
            config: {},
            installMetadata: { type: 'link', source: inactiveSource },
            contextFiles: [`${inactiveSource}/QWEN.md`],
          },
        ],
        getActiveExtensions: () => [
          {
            path: activeSource,
            config: {},
            installMetadata: { type: 'link', source: activeSource },
            contextFiles: [`${activeSource}/QWEN.md`],
          },
        ],
        getExtensionManager: () => ({
          addMutationListener: vi.fn(() => vi.fn()),
        }),
      } as unknown as Config,
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    expect(mockWatchers[0].target).toEqual([extensionsDir, activeSource]);

    fireAllEvent(0, 'change', `${inactiveSource}/QWEN.md`);
    fireAllEvent(0, 'change', `${inactiveSource}/commands/run.toml`);

    expect(refreshState.markExtensionsChanged).not.toHaveBeenCalled();
    expect(refreshState.markExtensionContentChanged).not.toHaveBeenCalled();
  });

  it('ignores unrelated files', () => {
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([]),
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    fireAllEvent(0, 'change', `${extensionsDir}/alpha/README.md`);
    fireAllEvent(0, 'change', `${extensionsDir}/alpha/node_modules/pkg/x.js`);
    fireAllEvent(0, 'change', `${extensionsDir}/alpha/.DS_Store`);

    expect(refreshState.markExtensionsChanged).not.toHaveBeenCalled();

    const ignored = mockWatchers[0].options['ignored'] as (
      filePath: string,
    ) => boolean;
    expect(ignored('C:/Users/me/.qwen/extensions/alpha/.git/config')).toBe(
      true,
    );
    expect(
      ignored('C:/Users/me/.qwen/extensions/alpha/node_modules/pkg/index.js'),
    ).toBe(true);
  });

  it('bootstraps on the parent when the extensions directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([]),
      extensionsDir,
      refreshState,
    );

    watcher.startWatching();

    expect(mockWatch).toHaveBeenCalledOnce();
    expect(mockWatchers[0].target).toBe('/home/user/.qwen');
    expect(mockWatchers[0].options).toEqual(
      expect.objectContaining({
        ignoreInitial: true,
        followSymlinks: false,
        depth: 0,
      }),
    );
  });

  it('restarts watching after extension manager mutations settle', () => {
    const refreshState = createRefreshState();
    let mutationListener:
      | ((event: {
          id: number;
          phase: 'start' | 'end';
          operation: string;
        }) => void)
      | undefined;
    const manager = {
      addMutationListener: vi.fn(
        (
          listener: (event: {
            id: number;
            phase: 'start' | 'end';
            operation: string;
          }) => void,
        ) => {
          mutationListener = listener;
          return vi.fn();
        },
      ),
    };
    const watcher = new ExtensionFileWatcher(
      {
        getExtensions: () => [],
        getActiveExtensions: () => [],
        getExtensionManager: () => manager,
      } as unknown as Config,
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    mutationListener?.({
      id: 1,
      phase: 'start',
      operation: 'installExtension',
    });
    mutationListener?.({
      id: 1,
      phase: 'end',
      operation: 'installExtension',
    });

    expect(mockWatch).toHaveBeenCalledTimes(2);
    expect(mockWatchers[0].instance.close).toHaveBeenCalledOnce();
  });

  it('ignores buffered events from stopped watchers', () => {
    const refreshState = createRefreshState();
    const watcher = new ExtensionFileWatcher(
      configWithExtensions([]),
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();
    const oldWatcherIndex = 0;
    watcher.restartWatching();

    fireAllEvent(oldWatcherIndex, 'addDir', `${extensionsDir}/old-buffered`);

    expect(refreshState.markExtensionsChanged).not.toHaveBeenCalled();
  });

  it('pairs overlapping extension manager mutations by id', () => {
    const refreshState = createRefreshState();
    let mutationListener:
      | ((event: {
          id: number;
          phase: 'start' | 'end';
          operation: string;
        }) => void)
      | undefined;
    const endSuppressions = new Map<number, () => void>();
    vi.mocked(refreshState.beginSuppression).mockImplementation((onSettle) => {
      const endSuppression = vi.fn(() => onSettle?.());
      endSuppressions.set(endSuppressions.size + 1, endSuppression);
      return endSuppression;
    });
    const manager = {
      addMutationListener: vi.fn(
        (
          listener: (event: {
            id: number;
            phase: 'start' | 'end';
            operation: string;
          }) => void,
        ) => {
          mutationListener = listener;
          return vi.fn();
        },
      ),
    };
    const watcher = new ExtensionFileWatcher(
      {
        getExtensions: () => [],
        getActiveExtensions: () => [],
        getExtensionManager: () => manager,
      } as unknown as Config,
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    mutationListener?.({ id: 1, phase: 'start', operation: 'enableExtension' });
    mutationListener?.({
      id: 2,
      phase: 'start',
      operation: 'disableExtension',
    });
    mutationListener?.({ id: 1, phase: 'end', operation: 'enableExtension' });
    mutationListener?.({ id: 2, phase: 'end', operation: 'disableExtension' });

    expect(endSuppressions.get(1)).toHaveBeenCalledOnce();
    expect(endSuppressions.get(2)).toHaveBeenCalledOnce();
  });

  it('ends pending mutation suppressions when watching stops', () => {
    const refreshState = createRefreshState();
    const endSuppression = vi.fn();
    vi.mocked(refreshState.beginSuppression).mockReturnValue(endSuppression);
    let mutationListener:
      | ((event: {
          id: number;
          phase: 'start' | 'end';
          operation: string;
        }) => void)
      | undefined;
    const manager = {
      addMutationListener: vi.fn(
        (
          listener: (event: {
            id: number;
            phase: 'start' | 'end';
            operation: string;
          }) => void,
        ) => {
          mutationListener = listener;
          return vi.fn();
        },
      ),
    };
    const watcher = new ExtensionFileWatcher(
      {
        getExtensions: () => [],
        getActiveExtensions: () => [],
        getExtensionManager: () => manager,
      } as unknown as Config,
      extensionsDir,
      refreshState,
    );
    watcher.startWatching();

    mutationListener?.({
      id: 1,
      phase: 'start',
      operation: 'installExtension',
    });
    watcher.stopWatching();

    expect(endSuppression).toHaveBeenCalledOnce();
  });
});
