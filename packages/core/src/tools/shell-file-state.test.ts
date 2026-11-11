/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createIsolatedPermissionSession } from '../test-utils/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PermissionRules } from '../permissions/manager/decision/index.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import { initializeShellParsers } from '../utils/shell-utils.js';
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
} from '../utils/fileStateCache.js';
import {
  shellChangedFilesHint,
  snapshotShellFileState,
  snapshotKnownShellFileState,
} from './shell-file-state.js';

describe('Bash changed-file hints', () => {
  beforeAll(async () => {
    await initializeShellParsers();
  });
  let cwd: string;
  let file: string;
  let cache: FileStateCache;
  let config: Config;
  let rules: PermissionRules;
  let permission: ReturnType<typeof createIsolatedPermissionSession>;

  beforeEach(() => {
    cwd = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'shell-read-state-'),
    );
    file = path.join(cwd, 'sample.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    cache = createFileStateCacheWithSizeLimit(10);
    rules = { allow: {}, deny: {}, ask: {} };
    permission = createIsolatedPermissionSession({
      permissionMode: 'default',
      additionalDirectories: [],
      cwd,
      rules,
      toolCheckerMap: new Map(),
    });
    config = {
      getTargetDir: () => cwd,
      permission,
    } as unknown as Config;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function seed() {
    cache.set(file, {
      content: 'one\ntwo\nthree\n',
      timestamp: Math.floor(fs.statSync(file).mtimeMs),
      offset: undefined,
      limit: undefined,
    });
  }

  it('lets another shell observe known files without Bash syntax or implicit reads', async () => {
    seed();
    const original = cache.get(file);
    const watched = await snapshotKnownShellFileState(cache);
    expect(watched).toHaveLength(1);
    expect(cache.get(file)).toBe(original);
    const time = new Date(Date.now() + 2000);
    fs.writeFileSync(file, 'changed by PowerShell');
    fs.utimesSync(file, time, time);
    expect(await shellChangedFilesHint(watched, cache, config)).toContain(
      'Read the relevant content before editing',
    );
    expect(cache.get(file)).toBe(original);
    expect(
      await snapshotKnownShellFileState(cache, AbortSignal.abort()),
    ).toEqual([]);
  });

  it.each([
    'python --version',
    'node --version',
    'sed -n 1p sample.txt',
    'ls format',
    'echo ok > /dev/null',
  ])('does not scan for a read-only command: %s', async (command) => {
    seed();
    const stat = vi.spyOn(fs.promises, 'stat');
    expect(await snapshotShellFileState(command, cache, { cwd })).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });

  it.each([0, 100, 5000])(
    'bounds stat concurrency with %i cached files',
    async (count) => {
      cache = createFileStateCacheWithSizeLimit(5000);
      for (let i = 0; i < count; i++) {
        cache.set(path.join(cwd, String(i)), {
          content: 'known',
          timestamp: 1000,
          offset: undefined,
          limit: undefined,
        });
      }
      let active = 0;
      let peak = 0;
      const stats = fs.statSync(file);
      stats.mtimeMs = 1000;
      const bigintStats = fs.statSync(file, { bigint: true });
      const stat = vi
        .spyOn(fs.promises, 'stat')
        .mockImplementation(async (_path, options) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setImmediate(resolve));
          active--;
          return options?.bigint ? bigintStats : stats;
        });
      const watched = await snapshotShellFileState('pnpm run format', cache, {
        cwd,
      });
      expect(watched).toHaveLength(count);
      expect(
        await shellChangedFilesHint(watched, cache, config),
      ).toBeUndefined();
      expect(stat).toHaveBeenCalledTimes(count * 2);
      expect(peak).toBeLessThanOrEqual(16);
    },
  );

  it('stops scanning after cancellation', async () => {
    seed();
    const signal = AbortSignal.abort();
    const stat = vi.spyOn(fs.promises, 'stat');
    expect(
      await snapshotShellFileState('touch sample.txt', cache, { signal }),
    ).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });

  it.each(['deny', 'ask'] as const)(
    'does not disclose changed paths restricted by %s',
    async (behavior) => {
      seed();
      const watched = await snapshotShellFileState('touch sample.txt', cache);
      fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
      permission.setRules({
        allow: {},
        deny: {},
        ask: {},
        [behavior]: { session: ['Read'] },
      });
      const ask = vi.spyOn(permission, 'check');
      expect(
        await shellChangedFilesHint(watched, cache, config),
      ).toBeUndefined();
      expect(ask).toHaveBeenCalledTimes(1);
    },
  );

  it('limits displayed paths and preserves the total changed count', async () => {
    for (let i = 0; i < 7; i++) {
      const current = path.join(cwd, `file-${i}.txt`);
      fs.writeFileSync(current, 'before');
      cache.set(current, {
        content: 'before',
        timestamp: 1,
        offset: undefined,
        limit: undefined,
      });
    }
    const watched = await snapshotShellFileState('pnpm format', cache);
    for (const current of cache.keys())
      fs.utimesSync(current, new Date(), new Date(Date.now() + 2000));
    const hint = await shellChangedFilesHint(watched, cache, config);
    expect(hint).toContain(
      '7 previously read file(s) changed during this command',
    );
    expect(hint?.match(/file-\d\.txt/g)).toHaveLength(5);
    expect(hint).toContain('and 2 more');
  });

  it('does not emit a hint after cancellation', async () => {
    seed();
    const watched = await snapshotShellFileState('touch sample.txt', cache);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
    expect(
      await shellChangedFilesHint(watched, cache, config, {
        signal: AbortSignal.abort(),
      } as ToolUseContext),
    ).toBeUndefined();
  });

  it('drops a stale hint if a sibling Read refreshes during permission checking', async () => {
    seed();
    const watched = await snapshotShellFileState('touch sample.txt', cache);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
    const checkPermission = permission.check.bind(permission);
    vi.spyOn(permission, 'check').mockImplementationOnce(
      async (...args) => {
        seed();
        return checkPermission(...args);
      },
    );
    expect(await shellChangedFilesHint(watched, cache, config)).toBeUndefined();
  });

  it('hints about a shell write without marking the new contents read', async () => {
    cache.set(file, {
      content: 'one\ntwo\nthree\n',
      timestamp: Math.floor(fs.statSync(file).mtimeMs),
      offset: undefined,
      limit: undefined,
    });
    const previous = cache.get(file)!;
    const watched = await snapshotShellFileState(
      'python3 rewrite.py --write',
      cache,
    );
    fs.writeFileSync(file, 'changed\n');
    fs.utimesSync(file, new Date(), new Date(previous.timestamp + 2000));
    expect(await shellChangedFilesHint(watched, cache, config)).toContain(
      JSON.stringify(file),
    );
    expect(cache.get(file)).toBe(previous);
    expect(previous.content).toBe('one\ntwo\nthree\n');
  });

  it('does not hint when a sibling read has already refreshed the file', async () => {
    cache.set(file, {
      content: 'one\ntwo\nthree\n',
      timestamp: Math.floor(fs.statSync(file).mtimeMs),
      offset: undefined,
      limit: undefined,
    });
    const watched = await snapshotShellFileState('touch sample.txt', cache);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
    // Model a sibling Read committing a new cache entry.
    cache.set(file, {
      content: 'one\ntwo\nthree\n',
      timestamp: Math.floor(fs.statSync(file).mtimeMs),
      offset: 1,
      limit: undefined,
    });
    expect(await shellChangedFilesHint(watched, cache, config)).toBeUndefined();
  });
});
