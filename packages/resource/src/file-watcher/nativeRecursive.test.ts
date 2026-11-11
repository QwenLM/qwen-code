/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSystemWatcher } from './fileWatcher.js';
import type { FileChangeEvent, WatchRequest } from './types.js';
import {
  clearInternalWrites,
  consumeInternalWrite,
  markInternalWrite,
} from './internalWrites.js';

const native = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  watch: native.watch,
}));

type Handle = EventEmitter & {
  path: string;
  recursive: boolean;
  callback: (event: string, filename: string | null) => void;
  close: ReturnType<typeof vi.fn>;
};
let root: string;
let handles: Handle[];
let watchers: FileSystemWatcher[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-recursive-test-')));
  handles = [];
  watchers = [];
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.stubGlobal('Bun', undefined);
  native.watch.mockReset().mockImplementation((path, options, callback) => {
    const handle = Object.assign(new EventEmitter(), {
      path, recursive: options.recursive, callback, close: vi.fn(),
    });
    handles.push(handle);
    return handle;
  });
});

afterEach(async () => {
  for (const watcher of watchers) await watcher.stop();
  clearInternalWrites();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function create(options = {}) {
  const watcher = new FileSystemWatcher({ debounceMs: 5, awaitWriteFinish: false, ...options });
  watchers.push(watcher);
  return watcher;
}

function request(path = root): WatchRequest {
  return {
    path, logicalRoot: root, signal: true, depth: 2,
    preferNativeRecursive: true, ignoredDirectoryNames: ['node_modules', '.git'],
  };
}

function pools(watcher: FileSystemWatcher) {
  return watcher as unknown as {
    defaultChokidarBackend: { watchers: Map<string, import('chokidar').FSWatcher> };
    fallbackPollingBackend: { watchers: Map<string, import('chokidar').FSWatcher> };
  };
}

describe('macOS native recursive opt-in', () => {
  it(
    'uses native root anchors without per-file watchers on Node', async () => {
      await mkdir(join(root, 'skill'));
      await Promise.all(Array.from({ length: 50 }, (_, n) => writeFile(join(root, 'skill', `${n}.md`), 'x')));
      const watcher = create();
      const first = watcher.watch(request(), () => {});
      const second = watcher.watch(request(), () => {});
      await watcher.start();
      expect(handles.filter((h) => h.recursive).map((h) => h.path)).toEqual([root]);
      expect(handles).toHaveLength(2); // content root + flat parent guard
      expect(pools(watcher).defaultChokidarBackend.watchers.size).toBe(0);
      expect(pools(watcher).fallbackPollingBackend.watchers.size).toBe(0);
      first();
      expect(handles.every((h) => h.close.mock.calls.length === 0)).toBe(true);
      second();
      expect(handles.every((h) => h.close.mock.calls.length === 1)).toBe(true);
    },
  );

  it.each(['1.3.14', '1.4.1', '1.4.2', '1.4.3', '1.5.0', '2.0.0', undefined])(
    'uses bounded polling on Bun %s', async (version) => {
      vi.stubGlobal('Bun', { version });
      const watcher = create();
      watcher.watch(request(), () => {});
      await watcher.start();
      expect(native.watch).not.toHaveBeenCalled();
      const backend = pools(watcher).defaultChokidarBackend.watchers.get('recursive:2')!;
      expect(backend.options).toMatchObject({ usePolling: true, interval: 2000, binaryInterval: 2000, depth: 2 });
      expect([...pools(watcher).defaultChokidarBackend.watchers.keys()]).toEqual(['recursive:2']);
    },
  );

  it('honors explicit polling and leaves non-opted-in Bun targets on polling', async () => {
    vi.stubGlobal('Bun', { version: '1.4.2' });
    const forced = create({ usePolling: true });
    forced.watch(request(), () => {});
    await forced.start();
    expect(native.watch).not.toHaveBeenCalled();
    const watcher = create();
    watcher.watch({ ...request(), preferNativeRecursive: false, depth: undefined }, () => {});
    await watcher.start();
    expect(native.watch).not.toHaveBeenCalled();
    expect(pools(watcher).defaultChokidarBackend.watchers.get('recursive:all')!.options.usePolling).toBe(true);
  });

  it('keeps Linux on its existing backend', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubGlobal('Bun', { version: '1.4.2' });
    const watcher = create();
    watcher.watch(request(), () => {});
    await watcher.start();
    expect(native.watch).not.toHaveBeenCalled();
    expect(pools(watcher).defaultChokidarBackend.watchers.get('recursive:2')!.options.usePolling).toBe(true);
  });

  it('keeps Bun on the native Windows backend', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubGlobal('Bun', { version: '1.4.2' });
    const watcher = create();
    watcher.watch(request(), () => {});
    await watcher.start();
    expect(handles.filter((handle) => handle.recursive).map((handle) => handle.path)).toEqual([root]);
  });

  it('filters deep/dependency noise, coalesces valid changes and refreshes unknown events', async () => {
    const watcher = create();
    const events: FileChangeEvent[] = [];
    watcher.watch(request(), (event) => { events.push(event); });
    await watcher.start();
    const content = handles.find((h) => h.recursive)!;
    for (const name of ['skill/node_modules/a.js', 'skill/.git/index', 'skill/scripts/nested/a.py']) {
      content.callback('change', name);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual([]);
    content.callback('change', 'skill/SKILL.md');
    content.callback('change', 'skill/scripts/a.py');
    await vi.waitFor(() => expect(events).toEqual([{ path: root, operation: 'change' }]));
    content.callback('change', null);
    await vi.waitFor(() => expect(events).toHaveLength(2));
  });

  it.each(['sync', 'async'])(
    'falls back once to bounded polling on %s native failure, even if usePolling was false', async (failure) => {
      const error = Object.assign(new Error('watch limit'), { code: 'EMFILE' });
      if (failure === 'sync') native.watch.mockImplementationOnce(() => { throw error; });
      const onError = vi.fn();
      const watcher = create({ usePolling: false, pollingIntervalMs: 40, onError });
      const events: FileChangeEvent[] = [];
      await mkdir(join(root, 'skill', 'node_modules'), { recursive: true });
      const file = join(root, 'skill', 'SKILL.md');
      await writeFile(file, 'initial');
      watcher.watch(request(), (event) => { events.push(event); });
      await watcher.start();
      if (failure === 'async') handles[0].emit('error', error);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(pools(watcher).defaultChokidarBackend.watchers.size).toBe(0);
      const backend = pools(watcher).fallbackPollingBackend.watchers.get('recursive:2')!;
      expect(backend.options).toMatchObject({ usePolling: true, interval: 40, binaryInterval: 40, depth: 2 });
      await vi.waitFor(() => expect(backend.getWatched()[join(root, 'skill')]).toContain('SKILL.md'));
      expect(backend.getWatched()[join(root, 'skill', 'node_modules')]).toBeUndefined();
      const calls = native.watch.mock.calls.length;
      await writeFile(file, 'updated content');
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(1));
      expect(native.watch).toHaveBeenCalledTimes(calls);
    },
  );

  it.each([false, true])('follows descendant symlinks through polling (added later=%s)', async (later) => {
    const external = join(root, 'external');
    const target = join(root, 'skills');
    await mkdir(external);
    await mkdir(target);
    const file = join(external, 'SKILL.md');
    await writeFile(file, 'initial');
    if (!later) await symlink(external, join(target, 'linked'));
    const events: FileChangeEvent[] = [];
    const watcher = create({ pollingIntervalMs: 40 });
    watcher.watch(request(target), (event) => { events.push(event); });
    await watcher.start();
    if (later) {
      await symlink(external, join(target, 'linked'));
      handles.find((h) => h.recursive)!.callback('rename', 'linked');
    }
    await vi.waitFor(() => expect(pools(watcher).fallbackPollingBackend.watchers.size).toBeGreaterThan(0));
    await vi.waitFor(() => expect(pools(watcher).fallbackPollingBackend.watchers.get('recursive:2')!.getWatched()[join(target, 'linked')]).toContain('SKILL.md'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    events.length = 0;
    await writeFile(file, 'changed through symlink');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  });

  it('keeps a symlinked root native and ignores links inside excluded dependencies', async () => {
    const actual = join(root, 'actual');
    const alias = join(root, 'alias');
    await mkdir(join(actual, 'node_modules'), { recursive: true });
    await symlink(root, join(actual, 'node_modules', 'ignored-link'));
    await symlink(actual, alias);
    const watcher = create();
    watcher.watch(request(alias), () => {});
    await watcher.start();
    expect(handles.filter((h) => h.recursive).map((h) => h.path)).toEqual([actual]);
    expect(pools(watcher).fallbackPollingBackend.watchers.size).toBe(0);
  });

  it('does not deliverChokidarEvent overlapping raw events to a native registration', async () => {
    const events: FileChangeEvent[] = [];
    const watcher = create({ usePolling: false });
    watcher.watch(request(), (event) => { events.push(event); });
    await watcher.start();
    // Another target in the shared service can still use a Chokidar backend.
    const internals = watcher as unknown as {
      handleChokidarEvent(operation: string, path: string, source: 'default' | 'fallback-polling'): void;
    };
    internals.handleChokidarEvent('change', join(root, 'SKILL.md'), 'default');
    internals.handleChokidarEvent('change', join(root, 'SKILL.md'), 'fallback-polling');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual([]);
    handles.find((h) => h.recursive)!.callback('change', 'SKILL.md');
    await vi.waitFor(() => expect(events).toHaveLength(1));
  });

  it('filters ignored events before consulting internal writes, while suppressing relevant internal writes', async () => {
    const dependency = join(root, 'node_modules', 'a.js');
    const skill = join(root, 'SKILL.md');
    await mkdir(join(root, 'node_modules'));
    await writeFile(dependency, 'x');
    await writeFile(skill, 'x');
    const watcher = create();
    const events: FileChangeEvent[] = [];
    watcher.watch(request(), (event) => { events.push(event); });
    await watcher.start();
    const content = handles.find((h) => h.recursive)!;
    markInternalWrite(dependency);
    content.callback('change', 'node_modules/a.js');
    expect(consumeInternalWrite(dependency, 5000)).toBe(true);
    markInternalWrite(skill);
    content.callback('change', 'SKILL.md');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual([]);
    content.callback('change', 'SKILL.md');
    await vi.waitFor(() => expect(events).toHaveLength(1));
  });
});
