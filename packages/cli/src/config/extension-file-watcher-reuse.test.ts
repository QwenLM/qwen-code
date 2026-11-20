/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { Config, ExtensionMutationEvent } from '@qwen-code/qwen-code-core';
import { ExtensionFileWatcher } from './extension-file-watcher.js';
import { ExtensionRefreshState } from './extension-refresh-state.js';

type Handler = (...args: unknown[]) => void;
type Handle = { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const mocks = vi.hoisted(() => {
  const main: Array<{
    target: string | string[];
    handlers: Record<string, Handler>;
    instance: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  }> = [];
  const state: Array<{
    target: string;
    callback: Handler;
    handlers: Record<string, Handler>;
    instance: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  }> = [];
  const watch = vi.fn((target: string | string[]) => {
    const handlers: Record<string, Handler> = {};
    const instance: Handle = {
      on: vi.fn((name: string, fn: Handler) => {
        handlers[name] = fn;
        return instance;
      }),
      close: vi.fn(async () => {}),
    };
    main.push({ target, handlers, instance });
    return instance;
  });
  const watchState = vi.fn((target: string, ...args: unknown[]) => {
    const handlers: Record<string, Handler> = {};
    const callback = args.find((arg) => typeof arg === 'function') as Handler;
    const instance: Handle = {
      on: vi.fn((name: string, fn: Handler) => {
        handlers[name] = fn;
        return instance;
      }),
      close: vi.fn(),
    };
    state.push({ target: String(target), callback, handlers, instance });
    return instance;
  });
  return { main, state, watch, watchState };
});
vi.mock('chokidar', () => ({ watch: mocks.watch }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: mocks.watchState,
}));

const cleanups: Array<() => void> = [];
function manager() {
  const listeners = new Set<(event: ExtensionMutationEvent) => void>();
  return {
    addMutationListener: vi.fn(
      (listener: (event: ExtensionMutationEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    ),
    emit: (phase: 'start' | 'end') => {
      for (const listener of [...listeners])
        listener({ id: 1, phase, operation: 'installExtension' });
    },
  };
}
function fixture(
  options: { missingStore?: boolean; missingExtensions?: boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'extension-watch-reuse-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const extensions = path.join(home, 'extensions');
  const store = path.join(home, 'extension-store');
  const state = path.join(store, 'state.json');
  if (!options.missingExtensions) fs.mkdirSync(extensions);
  if (!options.missingStore) {
    fs.mkdirSync(store);
    fs.writeFileSync(state, '{"generation":1}');
  }
  let owner = manager();
  const active: Array<{
    path: string;
    config: object;
    contextFiles: string[];
    installMetadata: { type: 'link'; source: string };
  }> = [];
  const config = {
    getExtensions: () => active,
    getActiveExtensions: () => active,
    getExtensionManager: () => owner,
  } as unknown as Config;
  const refresh = new ExtensionRefreshState();
  const changed = vi.spyOn(refresh, 'markExtensionsChanged');
  const content = vi.spyOn(refresh, 'markExtensionContentChanged');
  const watcher = new ExtensionFileWatcher(config, extensions, refresh, state);
  cleanups.push(() => {
    watcher.stopWatching();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    extensions,
    store,
    state,
    watcher,
    refresh,
    changed,
    content,
    active,
    get owner() {
      return owner;
    },
    replaceManager: () => {
      owner = manager();
    },
  };
}
function ready() {
  for (const item of mocks.main) item.handlers['ready']?.();
}
function targets() {
  const target = mocks.main.at(-1)!.target;
  return Array.isArray(target) ? target : [target];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.main.length = 0;
  mocks.state.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('ExtensionFileWatcher real directory identity and public watcher lifecycle', () => {
  it.each(['mutation', 'reload'] as const)(
    'keeps healthy unchanged native handles across %s',
    (reason) => {
      const f = fixture();
      f.watcher.startWatching();
      ready();
      const first = mocks.main[0];
      if (reason === 'mutation') {
        f.owner.emit('start');
        f.owner.emit('end');
      } else f.watcher.restartWatching();
      expect(first.instance.close).not.toHaveBeenCalled();
      expect(mocks.main).toHaveLength(1);
      expect(mocks.state).toHaveLength(1);
      expect(mocks.state[0].instance.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1001);
      // A real manifest is needed for command content classification.
      fs.mkdirSync(path.join(f.extensions, 'alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(f.extensions, 'alpha/qwen-extension.json'),
        '{}',
      );
      f.changed.mockClear();
      f.content.mockClear();
      first.handlers['all']?.(
        'change',
        path.join(f.extensions, 'alpha/commands/proof.md'),
      );
      expect(f.content).toHaveBeenCalledOnce();
    },
  );

  it('keeps observing actual atomic state replacements through the stable parent', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    expect(mocks.state[0].target).toBe(f.store);
    expect(targets()).not.toContain(f.state);
    const parentBefore = fs.statSync(f.store);
    const fileBefore = fs.statSync(f.state);
    const replacement = path.join(f.store, 'replacement.tmp');
    fs.writeFileSync(replacement, '{"generation":2}');
    fs.renameSync(replacement, f.state);
    expect(fs.statSync(f.state).ino).not.toBe(fileBefore.ino);
    expect(fs.statSync(f.store).ino).toBe(parentBefore.ino);
    mocks.state[0].callback('rename', 'state.json');
    expect(f.changed).toHaveBeenCalledWith(
      'extension store generation changed',
    );
    f.changed.mockClear();
    f.watcher.restartWatching();
    expect(mocks.main).toHaveLength(1);
    expect(mocks.state).toHaveLength(1);
    fs.writeFileSync(replacement, '{"generation":3}');
    fs.renameSync(replacement, f.state);
    mocks.state[0].callback('rename', null);
    expect(f.changed).toHaveBeenCalledWith(
      'extension store generation changed',
    );
  });

  it('updates real linked roots when an active link is added and removed', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    const link = path.join(f.root, 'linked');
    fs.mkdirSync(link);
    f.active.push({
      path: link,
      config: {},
      contextFiles: [],
      installMetadata: { type: 'link', source: link },
    });
    f.watcher.restartWatching();
    ready();
    expect(targets()).toContain(link);
    expect(mocks.main[0].instance.close).toHaveBeenCalledOnce();
    const linked = mocks.main.at(-1)!;
    f.active.length = 0;
    f.watcher.restartWatching();
    ready();
    expect(targets()).not.toContain(link);
    expect(linked.instance.close).toHaveBeenCalledOnce();
    f.changed.mockClear();
    linked.handlers['all']?.('change', path.join(link, 'qwen-extension.json'));
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('rebuilds when the same extension-root pathname now names a new inode', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    const first = mocks.main[0];
    const old = fs.statSync(f.extensions);
    fs.renameSync(f.extensions, f.extensions + '-old');
    fs.mkdirSync(f.extensions);
    expect(fs.statSync(f.extensions).ino).not.toBe(old.ino);
    f.watcher.restartWatching();
    ready();
    expect(first.instance.close).toHaveBeenCalledOnce();
    expect(mocks.main).toHaveLength(2);
    f.changed.mockClear();
    first.handlers['all']?.('addDir', path.join(f.extensions, 'stale'));
    expect(f.changed).not.toHaveBeenCalled();
    mocks.main[1].handlers['all']?.('addDir', path.join(f.extensions, 'new'));
    expect(f.changed).toHaveBeenCalledOnce();
  });

  it.each(['not-ready', 'main-error', 'state-error', 'state-close'] as const)(
    'safely rebuilds an unhealthy watcher (%s)',
    (fault) => {
      const f = fixture();
      f.watcher.startWatching();
      const first = mocks.main[0];
      if (fault !== 'not-ready') ready();
      if (fault === 'main-error')
        first.handlers['error']?.(new Error('owned watcher fault'));
      if (fault === 'state-error')
        mocks.state[0].handlers['error']?.(
          new Error('owned state watcher fault'),
        );
      if (fault === 'state-close') mocks.state[0].handlers['close']?.();
      f.watcher.restartWatching();
      expect(first.instance.close).toHaveBeenCalledOnce();
      expect(mocks.main).toHaveLength(2);
    },
  );

  it('does not reuse a prior manager subscription with otherwise identical roots', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    const oldOwner = f.owner;
    f.replaceManager();
    f.watcher.restartWatching();
    ready();
    expect(mocks.main[0].instance.close).toHaveBeenCalledOnce();
    const count = mocks.main.length;
    const staleListener = oldOwner.addMutationListener.mock.calls[0][0];
    staleListener({ id: 1, phase: 'start', operation: 'installExtension' });
    expect(f.refresh.isSuppressed()).toBe(false);
    staleListener({ id: 1, phase: 'end', operation: 'installExtension' });
    expect(mocks.main).toHaveLength(count);
  });

  it('rearms state monitoring when an initially missing store directory appears', () => {
    const f = fixture({ missingStore: true });
    f.watcher.startWatching();
    ready();
    expect(mocks.state[0].target).toBe(f.home);
    fs.mkdirSync(f.store);
    fs.writeFileSync(f.state, '{"generation":1}');
    mocks.state[0].callback('rename', 'extension-store');
    expect(mocks.state.at(-1)?.target).toBe(f.store);
    fs.writeFileSync(f.state, '{"generation":2}');
    mocks.state.at(-1)!.callback('change', 'state.json');
    expect(f.changed).toHaveBeenCalledWith(
      'extension store generation changed',
    );
  });

  it('bootstraps missing extension roots and ignores buffered events after stop', async () => {
    const f = fixture({ missingExtensions: true });
    f.watcher.startWatching();
    const bootstrap = mocks.main.find((item) => item.target === f.home)!;
    expect(bootstrap).toBeDefined();
    fs.mkdirSync(f.extensions);
    bootstrap.handlers['all']?.('addDir', f.extensions);
    await Promise.resolve();
    ready();
    expect(targets()).toContain(f.extensions);
    f.watcher.stopWatching();
    f.changed.mockClear();
    f.content.mockClear();
    for (const item of mocks.main)
      item.handlers['all']?.('addDir', path.join(f.extensions, 'late'));
    for (const item of mocks.state) item.callback('change', 'state.json');
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.content).not.toHaveBeenCalled();
  });
  it('updates context-file classification without destroying healthy unchanged handles', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    const contextFile = path.join(f.extensions, 'alpha', 'CUSTOM.md');
    fs.mkdirSync(path.dirname(contextFile));
    fs.writeFileSync(contextFile, 'owned');
    f.active.push({
      path: path.dirname(contextFile),
      config: {},
      contextFiles: [contextFile],
      installMetadata: { type: 'link', source: f.extensions },
    });
    f.watcher.restartWatching();
    expect(mocks.main).toHaveLength(1);
    expect(mocks.main[0].instance.close).not.toHaveBeenCalled();
    mocks.main[0].handlers['all']?.('change', contextFile);
    expect(f.changed).toHaveBeenCalledWith('extension files changed');
  });

  it('stale ready/error callbacks cannot poison the healthy successor', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    const oldMain = mocks.main[0];
    const oldState = mocks.state[0];
    f.replaceManager();
    f.watcher.restartWatching();
    ready();
    const current = mocks.main.at(-1)!;
    const count = mocks.main.length;
    oldMain.handlers['ready']?.();
    oldMain.handlers['error']?.(new Error('old error'));
    oldState.handlers['error']?.(new Error('old state error'));
    oldState.handlers['close']?.();
    f.watcher.restartWatching();
    expect(mocks.main).toHaveLength(count);
    expect(current.instance.close).not.toHaveBeenCalled();
  });

  it('does not let queued old bootstrap work restart a new owner', async () => {
    const f = fixture({ missingExtensions: true });
    f.watcher.startWatching();
    const oldBootstrap = mocks.main.find((item) => item.target === f.home)!;
    fs.mkdirSync(f.extensions);
    oldBootstrap.handlers['all']?.('addDir', f.extensions);
    f.watcher.stopWatching();
    f.watcher.startWatching();
    ready();
    const current = mocks.main.at(-1)!;
    const count = mocks.main.length;
    await Promise.resolve();
    expect(mocks.main).toHaveLength(count);
    expect(current.instance.close).not.toHaveBeenCalled();
  });

  it.each(['physical-root', 'store-ancestor'] as const)(
    'preserves an active mutation suppression across same-manager %s rearming',
    (change) => {
      const f = fixture({ missingStore: change === 'store-ancestor' });
      f.watcher.startWatching();
      ready();
      f.owner.emit('start');
      expect(f.refresh.isSuppressed()).toBe(true);
      if (change === 'physical-root') {
        fs.renameSync(f.extensions, f.extensions + '-old');
        fs.mkdirSync(f.extensions);
        f.watcher.restartWatching();
      } else {
        fs.mkdirSync(f.store);
        fs.writeFileSync(f.state, '{"generation":1}');
        mocks.state[0].callback('rename', 'extension-store');
      }
      ready();
      vi.advanceTimersByTime(1001);
      expect(f.refresh.isSuppressed()).toBe(true);
      f.owner.emit('end');
      vi.advanceTimersByTime(1001);
      expect(f.refresh.isSuppressed()).toBe(false);
    },
  );

  it('does not let buffered old-manager settlement end a new-manager mutation with the same id', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    const oldOwner = f.owner;
    oldOwner.emit('start');
    const oldListener = oldOwner.addMutationListener.mock.calls[0][0];
    f.replaceManager();
    f.watcher.restartWatching();
    ready();
    vi.advanceTimersByTime(1001);
    expect(f.refresh.isSuppressed()).toBe(false);
    f.owner.emit('start');
    oldListener({ id: 1, phase: 'end', operation: 'installExtension' });
    vi.advanceTimersByTime(1001);
    expect(f.refresh.isSuppressed()).toBe(true);
    f.owner.emit('end');
    vi.advanceTimersByTime(1001);
    expect(f.refresh.isSuppressed()).toBe(false);
  });

  it('rebuilds conservatively when a watch root is a symlink rather than a literal directory', () => {
    const f = fixture();
    fs.renameSync(f.extensions, f.extensions + '-real');
    fs.symlinkSync(
      f.extensions + '-real',
      f.extensions,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    f.watcher.startWatching();
    ready();
    const first = mocks.main[0];
    f.watcher.restartWatching();
    expect(first.instance.close).toHaveBeenCalledOnce();
    expect(mocks.main).toHaveLength(2);
  });

  it('rejects a captured old generation interval after stop and fresh start', () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      const f = fixture();
      f.watcher.startWatching();
      ready();
      const oldTick = intervals.mock.calls[0][0];
      f.watcher.stopWatching();
      f.watcher.startWatching();
      ready();
      const newTick = intervals.mock.calls.at(-1)![0];
      if (typeof oldTick !== 'function' || typeof newTick !== 'function')
        throw new Error('Expected public timer callbacks');
      fs.writeFileSync(f.state, '{"generation":2}');
      f.changed.mockClear();
      oldTick();
      expect(f.changed).not.toHaveBeenCalled();
      newTick();
      expect(f.changed).toHaveBeenCalledWith(
        'extension store generation changed',
      );
    } finally {
      intervals.mockRestore();
    }
  });

  it('moves from a missing-store ancestor to the new parent even when a symlinked link makes root identity unknown', () => {
    const f = fixture({ missingStore: true });
    const target = path.join(f.root, 'link-target');
    const alias = path.join(f.root, 'link-alias');
    fs.mkdirSync(target);
    fs.symlinkSync(
      target,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    f.active.push({
      path: alias,
      config: {},
      contextFiles: [],
      installMetadata: { type: 'link', source: alias },
    });
    f.watcher.startWatching();
    ready();
    expect(mocks.state[0].target).toBe(f.home);
    fs.mkdirSync(f.store);
    fs.writeFileSync(f.state, '{"generation":1}');
    mocks.state[0].callback('rename', 'extension-store');
    expect(mocks.state.at(-1)?.target).toBe(f.store);
    const replacement = path.join(f.store, 'replacement.tmp');
    fs.writeFileSync(replacement, '{"generation":2}');
    fs.renameSync(replacement, f.state);
    mocks.state.at(-1)!.callback('rename', 'state.json');
    expect(f.changed).toHaveBeenCalledWith(
      'extension store generation changed',
    );
  });

  it.each([0, 1])(
    'establishes only a baseline when a missing store first appears with generation %s',
    (generation) => {
      const f = fixture({ missingStore: true });
      f.watcher.startWatching();
      ready();
      expect(mocks.state[0].target).toBe(f.home);
      fs.mkdirSync(f.store);
      fs.writeFileSync(f.state, JSON.stringify({ generation }));
      mocks.state[0].callback('rename', 'extension-store');
      expect(mocks.state.at(-1)?.target).toBe(f.store);
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.refresh.needsExtensionRefresh()).toBe(false);
      const replacement = path.join(f.store, 'replacement.tmp');
      fs.writeFileSync(
        replacement,
        JSON.stringify({ generation: generation + 1 }),
      );
      fs.renameSync(replacement, f.state);
      mocks.state.at(-1)!.callback('rename', 'state.json');
      expect(f.changed).toHaveBeenCalledWith(
        'extension store generation changed',
      );
      expect(f.refresh.needsExtensionRefresh()).toBe(true);
    },
  );

  it('marks stale when the previously observed store parent disappears and safely rearms its ancestor', () => {
    const f = fixture();
    f.watcher.startWatching();
    ready();
    const previous = mocks.state[0];
    expect(previous.target).toBe(f.store);
    fs.rmSync(f.store, { recursive: true });
    previous.callback('rename', 'state.json');
    expect(mocks.state.at(-1)?.target).toBe(f.home);
    expect(f.changed).toHaveBeenCalledWith(
      'extension store generation changed',
    );
    expect(f.refresh.needsExtensionRefresh()).toBe(true);
  });
});
