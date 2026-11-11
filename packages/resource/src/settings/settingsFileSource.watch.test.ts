/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { tmpdir } from 'node:os';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  FileChangeEvent,
  FileChangeListener,
} from '../file-watcher/types.js';

const watcher = vi.hoisted(() => ({
  isNoop: false,
  listeners: new Map<string, (event: FileChangeEvent) => void>(),
  watch: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
}));

vi.mock('../file-watcher/fileWatcher.js', () => ({
  createFileWatcher: () => ({
    isNoop: watcher.isNoop,
    watch: watcher.watch.mockImplementation(
      (request: { path: string }, listener: FileChangeListener) => {
        watcher.listeners.set(
          request.path,
          listener as (event: FileChangeEvent) => void,
        );
        return () => watcher.listeners.delete(request.path);
      },
    ),
    start: watcher.start,
    stop: watcher.stop,
  }),
}));

import { SettingsSourceStore } from './settingsFileSource.js';
import { SettingsService } from './settingsService.js';
import { mutateSettingsFile } from './settingsPersistence.js';

it('bridges shared user/project file watches through SettingsService before initialization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-service-watch-'));
  const service = new SettingsService();
  const userPath = join(root, 'settings.json');
  const projectPath = join(root, 'project.json');
  const localPath = join(root, 'local.json');
  const user = service.getUserSettingsSource(userPath);
  const sources = service.getProjectSettingsSources(projectPath, localPath);
  writeFileSync(userPath, '{"label":"initial"}');
  expect(user.read()).toBe('{"label":"initial"}');
  const first = vi.fn(() => user.read());
  const second = vi.fn();
  watcher.watch.mockClear();
  try {
    const stopFirst = await service.watchFiles(
      [userPath, projectPath, localPath],
      first,
    );
    const stopSecond = await service.watchFiles(
      [userPath, projectPath, localPath],
      second,
    );
    expect(watcher.watch).toHaveBeenCalledTimes(3);
    writeFileSync(userPath, '{"label":"external"}');
    watcher.listeners.get(userPath)?.({ path: userPath, operation: 'change' });
    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveReturnedWith('{"label":"external"}');
    expect(second).toHaveBeenCalledOnce();
    service.initialize({ userConfigDir: root });
    expect(
      (
        service.resolve({ projectPath: join(root, 'workspace') }).user.settings as Record<string, unknown>
      )[
        'label'
      ],
    ).toBe('external');
    stopFirst();
    writeFileSync(projectPath, '{"project":true}');
    watcher.listeners.get(projectPath)?.({
      path: projectPath,
      operation: 'change',
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sources.project.read()!)).toEqual({ project: true });
    stopSecond();
    expect(service.getProjectSettingsSources(projectPath, localPath)).toBe(
      sources,
    );
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('fans snapshot writes out once through SettingsService without sharing adopted snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-service-write-'));
  const service = new SettingsService();
  const filePath = join(root, 'settings.json');
  writeFileSync(filePath, '{"value":1}');
  service.initialize({ userConfigDir: root });
  const projectPath = join(root, 'workspace');
  const first = service.resolve({ projectPath });
  const second = service.resolve({ projectPath });
  const firstChanged = vi.fn();
  const secondChanged = vi.fn();
  try {
    const stopFirst = await service.watchFiles([filePath], firstChanged);
    const stopSecond = await service.watchFiles([filePath], secondChanged);
    expect(first.setValue('user', 'value', 2)).toBe(true);
    await Promise.resolve();
    expect(firstChanged).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: filePath,
        operation: 'change',
        writeId: expect.any(String),
      }),
    );
    expect(secondChanged).toHaveBeenCalledOnce();
    expect((second.user.settings as Record<string, unknown>)['value']).toBe(1);
    expect(
      (
        service.resolve({ projectPath }).user.settings as Record<
          string,
          unknown
        >
      )['value']).toBe(2);
    watcher.listeners.get(filePath)?.({ path: filePath, operation: 'change' });
    expect(secondChanged).toHaveBeenCalledOnce();
    expect(first.setValue('user', 'value', 2)).toBe(true);
    await Promise.resolve();
    expect(secondChanged).toHaveBeenCalledOnce();
    writeFileSync(filePath, '{"value":3}');
    watcher.listeners.get(filePath)?.({ path: filePath, operation: 'change' });
    expect(secondChanged).toHaveBeenCalledTimes(2);
    expect(
      (
        service.resolve({ projectPath }).user.settings as Record<
          string,
          unknown
        >
      )['value']).toBe(3);
    expect((first.user.settings as Record<string, unknown>)['value']).toBe(2);
    stopFirst();
    stopSecond();
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps settings subscriptions active until sessions detach after a service shutdown request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-service-shutdown-'));
  const service = new SettingsService();
  const filePath = join(root, 'settings.json');
  const changed = vi.fn();
  try {
    const stop = await service.watchFiles([filePath], changed);
    expect(service.requestDispose()).toBeUndefined();
    expect(() => service.invalidateAll()).not.toThrow();
    expect(() => service.getUserSettingsSource(filePath)).toThrow('disposed');
    expect(() => service.resolve({ projectPath: root })).toThrow('disposed');
    expect(() => service.watchFiles([filePath], vi.fn())).toThrow('disposed');
    watcher.listeners.get(filePath)?.({ path: filePath, operation: 'change' });
    expect(changed).toHaveBeenCalledOnce();
    stop();
    await vi.waitFor(() => expect(watcher.listeners.has(filePath)).toBe(false));
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('exposes the degraded watch warning through SettingsService only once', async () => {
  const service = new SettingsService();
  watcher.isNoop = true;
  try {
    expect(service.takeWatchUnavailableWarning()).toBe(false);
    const stop = await service.watchFiles(
      [join(tmpdir(), 'service-noop.json')],
      vi.fn(),
    );
    expect(service.takeWatchUnavailableWarning()).toBe(true);
    expect(service.takeWatchUnavailableWarning()).toBe(false);
    stop();
  } finally {
    watcher.isNoop = false;
    await service.dispose();
  }
});

it('warns once when settings watching falls back to a no-op', async () => {
  watcher.isNoop = true;
  const store = new SettingsSourceStore();
  try {
    const stopFirst = await store.watchFile(
      join(tmpdir(), 'settings-noop-1.json'),
      vi.fn(),
    );
    const stopSecond = await store.watchFile(
      join(tmpdir(), 'settings-noop-2.json'),
      vi.fn(),
    );
    expect(store.takeWatchUnavailableWarning()).toBe(true);
    expect(store.takeWatchUnavailableWarning()).toBe(false);
    stopFirst();
    stopSecond();
  } finally {
    watcher.isNoop = false;
    watcher.watch.mockClear();
    watcher.start.mockClear();
    watcher.stop.mockClear();
    watcher.listeners.clear();
    await store.dispose();
  }
});

it('shares one file watch and fans changes out to active sessions', async () => {
  const store = new SettingsSourceStore();
  const filePath = join(tmpdir(), 'settings-watch-source.json');
  const first = vi.fn();
  const second = vi.fn();
  const unwatchFirst = await store.watchFile(filePath, first);
  const unwatchSecond = await store.watchFile(filePath, second);
  expect(watcher.watch).toHaveBeenCalledTimes(1);
  watcher.listeners.get(filePath)?.({ path: filePath, operation: 'change' });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);

  unwatchFirst();
  watcher.listeners.get(filePath)?.({ path: filePath, operation: 'change' });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
  unwatchSecond();
  await store.dispose();
  expect(watcher.stop).toHaveBeenCalledTimes(1);
});

it('keeps identical callbacks as independent subscriptions', async () => {
  const store = new SettingsSourceStore();
  const filePath = join(tmpdir(), 'settings-duplicate-listener.json');
  const changed = vi.fn();
  const stopFirst = await store.watchFile(filePath, changed);
  const stopSecond = await store.watchFile(filePath, changed);
  try {
    stopFirst();
    watcher.listeners.get(filePath)?.({ path: filePath, operation: 'change' });
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    stopSecond();
    await store.dispose();
  }
});

it('keeps project sources stable after the last settings watcher stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-source-lifetime-'));
  const projectPath = join(root, 'settings.json');
  const localPath = join(root, 'settings.local.json');
  writeFileSync(projectPath, '{}');
  const store = new SettingsSourceStore();
  try {
    const sources = store.getProject(projectPath, localPath);
    const stop = await store.watchFile(projectPath, vi.fn());
    stop();
    const later = Date.now() + 20_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(store.getProject(projectPath, localPath)).toBe(sources);
    } finally {
      now.mockRestore();
    }
  } finally {
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('publishes an internal write once and still delivers a later external edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-source-write-'));
  const filePath = join(root, 'settings.json');
  writeFileSync(filePath, '{"value":1}');
  const store = new SettingsSourceStore();
  const source = store.getProject(
    filePath,
    join(root, 'settings.local.json'),
  ).project;
  const first = vi.fn();
  const second = vi.fn();
  try {
    expect(source.read()).toBe('{"value":1}');
    const stopFirst = await store.watchFile(filePath, first);
    const stopSecond = await store.watchFile(filePath, second);
    try {
      source.mutate((latest) => {
        latest['value'] = 2;
        return true;
      });
      expect(JSON.parse(source.read()!)).toEqual({ value: 2 });
      await Promise.resolve();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);

      watcher.listeners.get(filePath)?.({
        path: filePath,
        operation: 'change',
      });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);

      writeFileSync(filePath, '{"value":3}');
      watcher.listeners.get(filePath)?.({
        path: filePath,
        operation: 'change',
      });
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);
      expect(JSON.parse(source.read()!)).toEqual({ value: 3 });
    } finally {
      stopFirst();
      stopSecond();
    }
  } finally {
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('watches a missing settings file so an external first creation is observed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-source-create-'));
  const filePath = join(root, 'settings.json');
  const store = new SettingsSourceStore();
  const source = store.getProject(
    filePath,
    join(root, 'settings.local.json'),
  ).project;
  const changed = vi.fn();
  try {
    const stop = await store.watchFiles([filePath], changed);
    try {
      expect(watcher.listeners.has(filePath)).toBe(true);
      writeFileSync(filePath, '{"value":1}');
      watcher.listeners.get(filePath)?.({
        path: filePath,
        operation: 'change',
      });
      expect(changed).toHaveBeenCalledOnce();
      expect(JSON.parse(source.read()!)).toEqual({ value: 1 });
    } finally {
      stop();
    }
  } finally {
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps observing changes until the physical watcher adopts a newly created directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-source-promotion-'));
  const configDir = join(root, '.qwen');
  const filePath = join(configDir, 'settings.json');
  const store = new SettingsSourceStore();
  const source = store.getUser(filePath);
  const changed = vi.fn();
  vi.useFakeTimers();
  try {
    await store.watchFile(filePath, changed);
    mkdirSync(configDir);
    writeFileSync(filePath, '{"value":1}');
    await vi.advanceTimersByTimeAsync(250);
    expect(source.read()).toBe('{"value":1}');
    expect(changed).toHaveBeenCalledTimes(1);
    rmSync(filePath);
    await vi.advanceTimersByTimeAsync(2000);
    expect(source.read()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    writeFileSync(filePath, '{"value":2}');
    await vi.advanceTimersByTimeAsync(250);
    expect(source.read()).toBe('{"value":2}');
    expect(changed).toHaveBeenCalledTimes(3);
    watcher.listeners.get(filePath)?.({ path: filePath, operation: 'add' });
    await vi.advanceTimersByTimeAsync(500);
    expect(changed).toHaveBeenCalledTimes(3);
  } finally {
    await store.dispose();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not duplicate a first creation observed by the physical watcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-source-create-race-'));
  const configDir = join(root, '.qwen');
  const filePath = join(configDir, 'settings.json');
  const store = new SettingsSourceStore();
  const changed = vi.fn();
  vi.useFakeTimers();
  try {
    const stop = await store.watchFile(filePath, changed);
    try {
      mkdirSync(configDir);
      writeFileSync(filePath, '{"value":1}');
      watcher.listeners.get(filePath)?.({
        path: filePath,
        operation: 'add',
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')(
  'matches path-based writes to a watched symbolic-link alias',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'settings-source-alias-'));
    const realPath = join(root, 'settings.json');
    const aliasPath = join(root, 'settings-link.json');
    writeFileSync(realPath, '{"value":1}');
    symlinkSync(realPath, aliasPath);
    const store = new SettingsSourceStore();
    const source = store.getUser(aliasPath);
    const changed = vi.fn();
    try {
      const stop = await store.watchFile(aliasPath, changed);
      try {
        const result = mutateSettingsFile(realPath, (latest) => {
          latest['value'] = 2;
          return true;
        });
        await Promise.resolve();
        const expectedEvent = expect.objectContaining({
          path: aliasPath,
          writeId: result.writeId,
        });
        expect(changed).toHaveBeenCalledExactlyOnceWith(expectedEvent);
        expect(JSON.parse(source.read()!)).toEqual({ value: 2 });

        watcher.listeners.get(aliasPath)?.({
          path: aliasPath,
          operation: 'change',
        });
        expect(changed).toHaveBeenCalledExactlyOnceWith(expectedEvent);
      } finally {
        stop();
      }
    } finally {
      await store.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('rejects a subscription disposed while the watcher is starting', async () => {
  let finishStart: (() => void) | undefined;
  watcher.start.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolveStart) => {
        finishStart = () => resolveStart(undefined);
      }),
  );
  const store = new SettingsSourceStore();
  const filePath = join(tmpdir(), 'settings-start-dispose.json');
  const watching = store.watchFile(filePath, vi.fn());
  await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'));

  const disposing = store.dispose();
  finishStart!();

  await expect(watching).rejects.toThrow('disposed while starting');
  await disposing;
});

it('defers requested disposal until the final settings subscription stops', async () => {
  const store = new SettingsSourceStore();
  const filePath = join(tmpdir(), 'settings-deferred-dispose.json');
  const changed = vi.fn();
  const stop = await store.watchFile(filePath, changed);
  expect(store.requestDispose()).toBeUndefined();
  await expect(
    store.watchFile(
      join(tmpdir(), 'settings-after-dispose-request.json'),
      vi.fn(),
    ),
  ).rejects.toThrow('disposing or disposed');
  watcher.listeners.get(filePath)?.({ path: filePath, operation: 'change' });
  expect(changed).toHaveBeenCalledOnce();
  stop();
  await vi.waitFor(() => expect(watcher.stop).toHaveBeenCalled());
});

it('refreshes a registered source after a path-based settings write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-path-write-'));
  const filePath = join(root, 'settings.json');
  writeFileSync(filePath, '{"value":1}');
  const store = new SettingsSourceStore();
  try {
    const source = store.getUser(filePath);
    expect(JSON.parse(source.read()!)).toEqual({ value: 1 });
    mutateSettingsFile(filePath, (latest) => {
      latest['value'] = 2;
      return true;
    });
    expect(JSON.parse(source.read()!)).toEqual({ value: 2 });
  } finally {
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('watches sibling candidates and coalesces deletion followed by recreation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-watch-'));
  const project = join(root, 'settings.json');
  const local = join(root, 'settings.local.json');
  writeFileSync(project, '{}');
  const store = new SettingsSourceStore();
  const events = vi.fn();
  try {
    const stop = await store.watchFiles([project, local], events);
    expect(watcher.listeners.has(project)).toBe(true);
    expect(watcher.listeners.has(local)).toBe(true);
    vi.useFakeTimers();
    watcher.listeners.get(project)?.({ path: project, operation: 'unlink' });
    expect(events).not.toHaveBeenCalled();
    watcher.listeners.get(project)?.({ path: project, operation: 'change' });
    await vi.advanceTimersByTimeAsync(1700);
    expect(events).toHaveBeenCalledTimes(1);
    stop();
  } finally {
    vi.useRealTimers();
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

it('releases all registrations when the shared watcher cannot start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-watch-fail-'));
  const first = join(root, 'settings.json');
  const second = join(root, 'settings.local.json');
  writeFileSync(first, '{}');
  const store = new SettingsSourceStore();
  watcher.start.mockRejectedValueOnce(new Error('watch unavailable'));
  try {
    await expect(store.watchFiles([first, second], vi.fn())).rejects.toThrow(
      'watch unavailable',
    );
    expect(watcher.listeners.has(first)).toBe(false);
    expect(watcher.listeners.has(second)).toBe(false);
  } finally {
    await store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
