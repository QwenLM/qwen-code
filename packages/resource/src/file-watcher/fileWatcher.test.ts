/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearInternalWrites, markInternalWrite } from './internalWrites.js';
import {
  FileSystemWatcher,
  createNoopFileWatcher,
  type FileChangeEvent,
} from './fileWatcher.js';

const cleanup: Array<() => Promise<void>> = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'resource-watcher-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function settle(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWatcher(debounceMs = 30): FileSystemWatcher {
  return new FileSystemWatcher({
    debounceMs,
    awaitWriteFinish: false,
    usePolling: false,
  });
}

function makePollingWatcher(pollingIntervalMs = 40, usePolling = true) {
  const watcher = new FileSystemWatcher({
    usePolling,
    pollingIntervalMs,
    debounceMs: 10,
    awaitWriteFinish: false,
  });
  cleanup.push(() => watcher.stop());
  return watcher;
}

function getChokidarBackend(watcher: FileSystemWatcher, depth?: number): FSWatcher {
  return (
    watcher as unknown as {
      defaultChokidarBackend: { watchers: Map<string, FSWatcher> };
    }
  ).defaultChokidarBackend.watchers.get(`recursive:${depth ?? 'all'}`)!;
}

/** Emits a raw event into the watcher without a live chokidar instance. */
function injectRaw(
  watcher: FileSystemWatcher,
  operation: 'add' | 'change' | 'unlink',
  path: string,
): void {
  (watcher as unknown as {
    handleChokidarEvent: (op: 'add' | 'change' | 'unlink', path: string) => void;
  }).handleChokidarEvent(operation, path);
}

function injectSignal(
  watcher: FileSystemWatcher,
  anchor: string,
  flat: boolean,
  eventPath: string,
): void {
  const internals = watcher as unknown as {
    registrations: Map<number, unknown>;
    invalidateNativeRegistrations: (
      signal: {
        anchor: string;
        flat: boolean;
        registrations: Set<number>;
        watcher: { close(): void };
      },
      eventPath: string,
    ) => void;
  };
  internals.invalidateNativeRegistrations(
    {
      anchor,
      flat,
      registrations: new Set(internals.registrations.keys()),
      watcher: { close() {} },
    },
    eventPath,
  );
}

function injectSignalError(watcher: FileSystemWatcher): void {
  const internals = watcher as unknown as {
    registrations: Map<number, unknown>;
    fallbackToChokidar: (
      registration: unknown,
      error: unknown,
    ) => void;
  };
  internals.fallbackToChokidar(
    internals.registrations.values().next().value,
    Object.assign(new Error('native watch unavailable'), { code: 'EMFILE' }),
  );
}

afterEach(async () => {
  clearInternalWrites();
  vi.unstubAllGlobals();
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    await fn?.();
  }
});

describe('delivery logic', () => {
  it('filters excluded descendants in native signals and raw events, retaining resource assets', async () => {
    const root = await makeTempDir();
    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch(
      {
        path: root,
        logicalRoot: root,
        signal: true,
        ignoredDirectoryNames: ['node_modules'],
      },
      (event) => {
        events.push(event);
      },
    );
    const ignored = join(root, 'node_modules', 'dependency', 'index.js');
    injectRaw(watcher, 'change', ignored);
    injectSignal(watcher, root, false, ignored);
    await settle(50);
    expect(events).toEqual([]);
    injectSignal(watcher, root, false, join(root, 'scripts', 'helper.py'));
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: root, operation: 'change' });
  });

  it('delivers events for the exact requested file', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '{}');

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch({ path: file }, (event) => {
      events.push(event);
    });

    injectRaw(watcher, 'change', file);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: file, operation: 'change' });
  });

  it('filters events outside the requested subtree', async () => {
    const dir = await makeTempDir();
    const sibling = join(dir, 'other.json');
    await writeFile(sibling, '{}');
    const watchedDir = join(dir, 'skills');
    await mkdir(watchedDir);

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch({ path: watchedDir, recursive: true }, (event) => {
      events.push(event);
    });

    injectRaw(watcher, 'change', sibling);
    injectRaw(watcher, 'change', join(dir, 'skills-extra', 'SKILL.md'));
    await settle(150);
    expect(events).toHaveLength(0);

    injectRaw(watcher, 'add', join(watchedDir, 'review', 'SKILL.md'));
    await waitFor(() => events.length === 1);
  });

  it('does not deliver nested events for flat watches', async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, 'nested'));

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch({ path: dir, recursive: false }, (event) => {
      events.push(event);
    });

    injectRaw(watcher, 'change', join(dir, 'nested', 'deep.txt'));
    await settle(150);
    expect(events).toHaveLength(0);

    injectRaw(watcher, 'add', join(dir, 'top.txt'));
    await waitFor(() => events.length === 1);
    expect(events[0].path).toBe(join(dir, 'top.txt'));
  });

  it('promotes a fallback watch when the missing target appears', async () => {
    const root = await makeTempDir();
    const missing = join(root, '.qwen', 'skills');
    await mkdir(join(root, '.qwen'), { recursive: true });

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch({ path: missing, recursive: true }, (event) => {
      events.push(event);
    });

    // Intermediate directory creation is not reported.
    injectRaw(watcher, 'add', join(root, '.qwen'));
    await settle(150);
    expect(events).toHaveLength(0);

    await mkdir(missing);
    injectRaw(watcher, 'add', missing);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: missing, operation: 'add' });

    // After promotion, child events flow normally.
    injectRaw(watcher, 'add', join(missing, 'a', 'SKILL.md'));
    await waitFor(() => events.length === 2);
  });

  it('suppresses events for internally written paths', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'self.json');
    await writeFile(file, '{}');

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch({ path: dir, recursive: true }, (event) => {
      events.push(event);
    });

    markInternalWrite(file);
    injectRaw(watcher, 'change', file);
    await settle(150);
    expect(events).toHaveLength(0);
  });

  it('coalesces rapid changes into a single debounced event', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'config.json');
    await writeFile(file, '{}');

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(80);
    watcher.watch({ path: dir, recursive: true }, (event) => {
      events.push(event);
    });

    injectRaw(watcher, 'change', file);
    injectRaw(watcher, 'change', file);
    injectRaw(watcher, 'change', file);
    await waitFor(() => events.length === 1);
    await settle(250);
    expect(events).toHaveLength(1);
  });

  it('matches and reports paths through symlink aliases', async () => {
    const root = await makeTempDir();
    const real = join(root, 'real');
    await mkdir(real);
    const link = join(root, 'link');
    await symlink(real, link);
    await writeFile(join(real, 'child.txt'), 'x');

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch({ path: link, recursive: true }, (event) => {
      events.push(event);
    });

    // Event arrives under the canonical (real) path; the listener must
    // receive it in the requested (alias) namespace.
    injectRaw(watcher, 'change', join(real, 'child.txt'));
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({
      path: join(link, 'child.txt'),
      operation: 'change',
    });
  });

  it('reports removal of a directly watched symlink alias', async () => {
    const root = await makeTempDir();
    const real = join(root, 'real');
    await mkdir(real);
    const link = join(root, 'link');
    await symlink(real, link);

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch({ path: link, recursive: true }, (event) => {
      events.push(event);
    });

    await unlink(link);
    injectRaw(watcher, 'unlink', link);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: link, operation: 'unlink' });
  });

  it('reports removal and recreation of a symlink ancestor', async () => {
    const projectRoot = await makeTempDir();
    const externalRoot = await makeTempDir();
    const realAgents = join(externalRoot, 'agents');
    await mkdir(join(realAgents, 'skills'), { recursive: true });
    const agentsLink = join(projectRoot, '.agents');
    await symlink(realAgents, agentsLink);
    const watchedDir = join(agentsLink, 'skills');

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch(
      { path: watchedDir, recursive: true, logicalRoot: projectRoot },
      (event) => {
        events.push(event);
      },
    );

    await unlink(agentsLink);
    injectRaw(watcher, 'unlink', agentsLink);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: watchedDir, operation: 'unlink' });

    await symlink(realAgents, agentsLink);
    injectRaw(watcher, 'add', agentsLink);
    await waitFor(() => events.length === 2);
    expect(events[1]).toEqual({ path: watchedDir, operation: 'add' });
  });

  it('coarsely invalidates changes below a narrow signal anchor', async () => {
    const projectRoot = await makeTempDir();
    const watchedDir = join(projectRoot, '.agents', 'skills');
    await mkdir(watchedDir, { recursive: true });
    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch(
      {
        path: watchedDir,
        recursive: true,
        logicalRoot: projectRoot,
        signal: true,
      },
      (event) => {
        events.push(event);
      },
    );

    injectSignal(
      watcher,
      watchedDir,
      false,
      join(watchedDir, 'demo', 'SKILL.md'),
    );
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: watchedDir, operation: 'change' });
  });

  it('filters unrelated events from flat symlink entry guards', async () => {
    const projectRoot = await makeTempDir();
    const externalRoot = await makeTempDir();
    const realAgents = join(externalRoot, 'agents');
    await mkdir(join(realAgents, 'skills'), { recursive: true });
    const agentsLink = join(projectRoot, '.agents');
    await symlink(realAgents, agentsLink);
    const watchedDir = join(agentsLink, 'skills');
    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch(
      {
        path: watchedDir,
        recursive: true,
        logicalRoot: projectRoot,
        signal: true,
      },
      (event) => {
        events.push(event);
      },
    );

    injectSignal(
      watcher,
      projectRoot,
      true,
      join(projectRoot, 'README.md'),
    );
    await settle(100);
    expect(events).toHaveLength(0);

    injectSignal(watcher, projectRoot, true, agentsLink);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: watchedDir, operation: 'change' });
  });

  it('invalidates once and permanently falls back when native watching fails', async () => {
    const projectRoot = await makeTempDir();
    const watchedDir = join(projectRoot, '.agents', 'skills');
    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    watcher.watch(
      {
        path: watchedDir,
        recursive: true,
        logicalRoot: projectRoot,
        signal: true,
      },
      (event) => {
        events.push(event);
      },
    );

    injectSignalError(watcher);
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ path: watchedDir, operation: 'change' });

    injectSignalError(watcher);
    await settle(100);
    expect(events).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'a.json');
    await writeFile(file, '{}');

    const events: FileChangeEvent[] = [];
    const watcher = makeWatcher(10);
    const unsub = watcher.watch({ path: dir, recursive: true }, (event) => {
      events.push(event);
    });

    unsub();
    injectRaw(watcher, 'change', file);
    await settle(150);
    expect(events).toHaveLength(0);
  });
});

describe('filesystem integration', () => {
  // Real-fs tests use polling: FSEvents delivery is unreliable inside
  // vitest worker threads on macOS. Production defaults stay event-based.
  function makeFsWatcher(): FileSystemWatcher {
    return new FileSystemWatcher({
      debounceMs: 50,
      awaitWriteFinish: false,
      usePolling: true,
      pollingIntervalMs: 100,
    });
  }

  it('delivers change events for files under a watched directory', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '{}');

    const events: FileChangeEvent[] = [];
    const watcher = makeFsWatcher();
    cleanup.push(() => watcher.stop());
    watcher.watch({ path: dir, recursive: true }, (event) => {
      events.push(event);
    });
    await watcher.start();
    await settle(300);

    await writeFile(file, '{"a":1}');
    await waitFor(() => events.length > 0);
    expect(events[0]).toEqual({ path: file, operation: 'change' });
  });

  it('detects creation of a watched path that did not exist yet', async () => {
    const root = await makeTempDir();
    const missing = join(root, '.qwen', 'skills');

    const events: FileChangeEvent[] = [];
    const watcher = makeFsWatcher();
    cleanup.push(() => watcher.stop());
    watcher.watch({ path: missing, recursive: true }, (event) => {
      events.push(event);
    });
    await watcher.start();
    await settle(300);

    await mkdir(missing, { recursive: true });
    await waitFor(() => events.length > 0, 15000);
    expect(events[0]).toEqual({ path: missing, operation: 'add' });
  });

  it('reports unlink and recovers when the path is recreated', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '{}');

    const events: FileChangeEvent[] = [];
    const watcher = makeFsWatcher();
    cleanup.push(() => watcher.stop());
    watcher.watch({ path: file }, (event) => {
      events.push(event);
    });
    await watcher.start();
    await settle(300);
    events.length = 0;

    await unlink(file);
    await waitFor(() => events.some((e) => e.operation === 'unlink'));

    await writeFile(file, '{}');
    await waitFor(() => events.some((e) => e.operation === 'add'));

    expect(events[0]).toEqual({ path: file, operation: 'unlink' });
    expect(events.at(-1)).toEqual({ path: file, operation: 'add' });
  });

  it('detects deletion of a watched directory reached through a symlink', async () => {
    const root = await makeTempDir();
    const realAgents = join(root, 'real-agents');
    const skillFile = join(realAgents, 'skills', 'demo', 'SKILL.md');
    await mkdir(join(realAgents, 'skills', 'demo'), { recursive: true });
    await writeFile(skillFile, '---\nname: demo\ndescription: demo\n---\n');
    const agentsLink = join(root, '.agents');
    await symlink(realAgents, agentsLink);
    const watchedDir = join(agentsLink, 'skills');

    const events: FileChangeEvent[] = [];
    const watcher = makeFsWatcher();
    cleanup.push(() => watcher.stop());
    watcher.watch(
      { path: watchedDir, recursive: true, logicalRoot: root },
      (event) => {
        events.push(event);
      },
    );
    await watcher.start();
    await settle(300);

    await unlink(agentsLink);
    await waitFor(() =>
      events.some(
        (event) =>
          event.path === watchedDir && event.operation === 'unlink',
      ),
    );
  });

  // Native FSEvents/fs.watch delivery is unreliable in macOS vitest workers;
  // the same behavior is covered above with polling and in delivery tests.
  it.skipIf(process.platform === 'darwin')(
    'detects symlink-ancestor deletion with native Node events',
    async () => {
      const projectRoot = await makeTempDir();
      const externalRoot = await makeTempDir();
      const realAgents = join(externalRoot, 'agents');
      const skillFile = join(realAgents, 'skills', 'demo', 'SKILL.md');
      await mkdir(join(realAgents, 'skills', 'demo'), { recursive: true });
      await writeFile(
        skillFile,
        '---\nname: demo\ndescription: demo\n---\n',
      );
      const agentsLink = join(projectRoot, '.agents');
      await symlink(realAgents, agentsLink);
      const watchedDir = join(agentsLink, 'skills');

      const events: FileChangeEvent[] = [];
      const watcher = makeWatcher(50);
      cleanup.push(() => watcher.stop());
      watcher.watch(
        { path: watchedDir, recursive: true, logicalRoot: projectRoot },
        (event) => {
          events.push(event);
        },
      );
      await watcher.start();
      await settle(300);

      await unlink(agentsLink);
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.path === watchedDir && event.operation === 'unlink',
          ),
        15000,
      );
    },
    20000,
  );
});

describe('NoopFileWatcher', () => {
  it('accepts watches without emitting and resolves lifecycle calls', async () => {
    const watcher = createNoopFileWatcher();
    expect(watcher.isNoop).toBe(true);

    const unsub = watcher.watch({ path: '/nonexistent' }, () => {
      throw new Error('noop watcher must not emit');
    });
    await watcher.start();
    await watcher.stop();
    unsub();
  });
});

describe('polling cost and resource exclusions', () => {
  it.each([undefined, 0, -1, NaN, Infinity])(
    'defaults missing or invalid Bun polling interval %s to 2000ms',
    async (pollingIntervalMs) => {
      vi.stubGlobal('Bun', {});
      const root = await realpath(await makeTempDir());
      const watcher = new FileSystemWatcher({ pollingIntervalMs });
      cleanup.push(() => watcher.stop());
      watcher.watch(
        { path: root, depth: 2, signal: true, logicalRoot: root },
        () => {},
      );
      await watcher.start();
      expect(getChokidarBackend(watcher, 2).options).toMatchObject({
        depth: 2,
        usePolling: true,
        interval: 2000,
        binaryInterval: 2000,
      });
    },
  );

  it('does not enable polling when only an interval is supplied', async () => {
    const root = await realpath(await makeTempDir());
    const watcher = new FileSystemWatcher({
      usePolling: false,
      pollingIntervalMs: 2500,
    });
    cleanup.push(() => watcher.stop());
    watcher.watch({ path: root }, () => {});
    await watcher.start();
    expect(getChokidarBackend(watcher).options.usePolling).toBe(false);
    expect(getChokidarBackend(watcher).options.interval).toBe(100);
  });

  it('prunes dependency trees while observing resource asset changes', async () => {
    const root = await realpath(await makeTempDir());
    const deps = join(root, 'skill', 'node_modules', 'package');
    await mkdir(deps, { recursive: true });
    const dependency = join(deps, 'index.js');
    const asset = join(root, 'skill', 'guide.md');
    await writeFile(dependency, 'dependency');
    await writeFile(asset, 'guide');
    const events: FileChangeEvent[] = [];
    const watcher = makePollingWatcher(40);
    watcher.watch(
      { path: root, ignoredDirectoryNames: ['node_modules'] },
      (event) => {
        events.push(event);
      },
    );
    await watcher.start();
    expect(getChokidarBackend(watcher).options).toMatchObject({
      interval: 40,
      binaryInterval: 40,
    });
    expect(
      Object.keys(getChokidarBackend(watcher).getWatched()).some((path) =>
        path.includes('node_modules'),
      ),
    ).toBe(false);

    await writeFile(dependency, 'changed dependency');
    await settle(200);
    expect(events).toEqual([]);

    await writeFile(asset, 'updated guide');
    await waitFor(() =>
      events.some(
        (event) => event.path === asset && event.operation === 'change',
      ),
    );

  });

  it('keeps a symlinked target inside node_modules and prunes only its nested dependencies', async () => {
    const root = await realpath(await makeTempDir());
    const target = join(root, 'node_modules', 'skill-package');
    const deps = join(target, 'node_modules', 'dependency');
    await mkdir(deps, { recursive: true });
    await writeFile(join(deps, 'index.js'), 'dependency');
    await writeFile(join(target, 'SKILL.md'), 'initial');
    const alias = join(root, 'skills');
    await symlink(target, alias, 'dir');
    const events: FileChangeEvent[] = [];
    const watcher = makePollingWatcher();
    watcher.watch(
      {
        path: alias,
        depth: 2,
        logicalRoot: root,
        ignoredDirectoryNames: ['node_modules'],
      },
      (event) => {
        events.push(event);
      },
    );
    await watcher.start();
    expect(getChokidarBackend(watcher, 2).getWatched()[target]).toContain('SKILL.md');
    expect(getChokidarBackend(watcher, 2).getWatched()[deps]).toBeUndefined();
    await writeFile(join(target, 'SKILL.md'), 'changed skill');
    await waitFor(() =>
      events.some((event) => event.path === join(alias, 'SKILL.md')),
    );
    await unlink(alias);
    await waitFor(() =>
      events.some(
        (event) => event.path === alias && event.operation === 'unlink',
      ),
    );
    events.length = 0;
    await symlink(target, alias, 'dir');
    await waitFor(() =>
      events.some((event) => event.path === alias && event.operation === 'add'),
    );
    await writeFile(join(target, 'SKILL.md'), 'changed after recreation');
    await waitFor(() =>
      events.some((event) => event.path === join(alias, 'SKILL.md')),
    );
  });

  it('preserves missing targets below an ignored-name ancestor', async () => {
    const root = await realpath(await makeTempDir());
    const target = join(root, 'node_modules', 'package', 'skills');
    const events: FileChangeEvent[] = [];
    const watcher = makePollingWatcher();
    watcher.watch(
      { path: target, depth: 2, ignoredDirectoryNames: ['node_modules'] },
      (event) => {
        events.push(event);
      },
    );
    await watcher.start();
    await mkdir(target, { recursive: true });
    await waitFor(() =>
      events.some(
        (event) => event.path === target && event.operation === 'add',
      ),
    );
    const file = join(target, 'SKILL.md');
    await writeFile(file, 'created');
    await waitFor(() => events.some((event) => event.path === file));
  });

  it('does not prune paths required by an overlapping target with a different policy', async () => {
    const root = await realpath(await makeTempDir());
    const dependencyRoot = join(root, 'node_modules', 'package');
    await mkdir(dependencyRoot, { recursive: true });
    const file = join(dependencyRoot, 'agent.md');
    await writeFile(file, 'initial');
    const filtered: FileChangeEvent[] = [];
      const unfiltered: FileChangeEvent[] = [];
    const watcher = makePollingWatcher();
    watcher.watch(
      { path: root, ignoredDirectoryNames: ['node_modules'] },
      (event) => {
        filtered.push(event);
      },
    );
    watcher.watch({ path: dependencyRoot }, (event) => {
      unfiltered.push(event);
    });
    await watcher.start();
    await writeFile(file, 'changed');
    await waitFor(() => unfiltered.some((event) => event.path === file));
    expect(filtered).toEqual([]);
  });

  it.each([true, false])(
    'bounds traversal at depth 2 (polling=%s) while observing boundary files',
    async (usePolling) => {
      const root = await realpath(await makeTempDir());
      const scripts = join(root, 'skill', 'scripts');
      const deep = join(scripts, 'nested');
      await mkdir(deep, { recursive: true });
      const skill = join(root, 'skill', 'SKILL.md');
      const helper = join(scripts, 'helper.py');
      const deepHelper = join(deep, 'helper.py');
      for (const file of [skill, helper, deepHelper]) {
        await writeFile(file, 'initial');
      }
      const events: FileChangeEvent[] = [];
      const watcher = makePollingWatcher(40, usePolling);
      watcher.watch(
        { path: root, depth: 2, signal: true, logicalRoot: root },
        (event) => {
          events.push(event);
        },
      );
      await watcher.start();
      expect(getChokidarBackend(watcher, 2).options.depth).toBe(2);
      expect(getChokidarBackend(watcher, 2).getWatched()[scripts]).toContain('helper.py');
      expect(getChokidarBackend(watcher, 2).getWatched()[deep] ?? []).not.toContain(
        'helper.py',
      );

      // Drain delayed native startup notifications before measuring mutations.
      await settle(500);
      events.length = 0;
      await writeFile(deepHelper, 'changed deep helper');
      await settle(250);
      expect(events).toEqual([]);
      for (const file of [skill, helper]) {
        await writeFile(file, 'changed');
        await waitFor(() => events.some((event) => event.path === file));
      }
      const added = join(scripts, 'new.py');
      await writeFile(added, 'new');
      await waitFor(() =>
        events.some((event) => event.path === added && event.operation === 'add'),
      );
      await unlink(added);
      await waitFor(() =>
        events.some((event) => event.path === added && event.operation === 'unlink'),
      );
    },
  );

  it('keeps overlapping requests with different depths independent through unsubscribe', async () => {
    const root = await realpath(await makeTempDir());
    const deep = join(root, 'skill', 'scripts', 'nested');
    await mkdir(deep, { recursive: true });
    const file = join(deep, 'helper.py');
    await writeFile(file, 'initial');
    const shallow: FileChangeEvent[] = [];
      const unlimited: FileChangeEvent[] = [];
    const watcher = makePollingWatcher();
    const unsubscribe = watcher.watch({ path: root, depth: 2 }, (event) => {
      shallow.push(event);
    });
    watcher.watch({ path: root }, (event) => {
      unlimited.push(event);
    });
    await watcher.start();
    expect(getChokidarBackend(watcher, 2).getWatched()[deep] ?? []).not.toContain(
      'helper.py',
    );
    expect(getChokidarBackend(watcher).getWatched()[deep]).toContain('helper.py');
    await writeFile(file, 'first change');
    await waitFor(() => unlimited.some((event) => event.path === file));
    expect(shallow).toEqual([]);
    unsubscribe();
    unlimited.length = 0;
    await settle(100);
    await writeFile(file, 'after shallow unsubscribe');
    await waitFor(() => unlimited.some((event) => event.path === file));
  });

  it.each([-1, 1.5, NaN, Infinity])(
    'falls back to depth 2 for invalid depth %s without mutating the request',
    async (depth) => {
      const root = await realpath(await makeTempDir());
      const watcher = makePollingWatcher();
      const request = { path: root, depth };
      watcher.watch(request, () => {});
      await watcher.start();
      expect(getChokidarBackend(watcher, 2).options.depth).toBe(2);
      expect(request.depth).toBe(depth);
    },
  );
});
