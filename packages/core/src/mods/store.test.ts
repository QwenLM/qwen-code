/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as noFollow from '../utils/no-follow-open.js';
import {
  readLocalBootId,
  readPidNamespaceId,
} from '../utils/process-liveness.js';
import { MOD_STORE_MAX_BYTES, ModStore } from './store.js';

describe('ModStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
  const storeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-mod-store-'));
    dirs.push(dir);
    return dir;
  };

  const heldLock = (dir: string, pid: number) => {
    const bootId = process.platform === 'linux' ? readLocalBootId() : null;
    const scope = createHash('sha256')
      .update(JSON.stringify([hostname(), readPidNamespaceId(), bootId]))
      .digest('hex')
      .slice(0, 16);
    const lock = join(dir, 'mod.json.lock');
    const owner = join(lock, `${scope}.${pid}.-.${randomUUID()}`);
    mkdirSync(owner, { recursive: true });
    return { lock, owner };
  };

  it('waits for a live owner even if its lock is old, then keeps what it wrote', async () => {
    const dir = storeDir();
    const file = join(dir, 'mod.json');
    const { lock } = heldLock(dir, process.pid);
    utimesSync(lock, 1, 1);
    let landed = false;
    const write = new ModStore(dir).set('mod', 'mine', 2).then(() => {
      landed = true;
    });
    void write.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(landed).toBe(false);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: [['theirs', 1]] }),
    );
    await rm(lock, { recursive: true });
    await write;
    expect(await new ModStore(dir).keys('mod')).toEqual(['theirs', 'mine']);
  });

  it('recovers a dead owner and its unfinished temporary file', async () => {
    const dir = storeDir();
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    const { lock, owner } = heldLock(dir, child.pid);
    writeFileSync(join(owner, 'store.json'), 'incomplete');
    const store = new ModStore(dir);
    await store.set('mod', 'mine', 2);
    expect(await store.keys('mod')).toEqual(['mine']);
    expect(() => statSync(lock)).toThrow();
  });

  it('keeps every write when writes come at once', async () => {
    const dir = storeDir();
    const [one, two] = [new ModStore(dir), new ModStore(dir)];
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        (i % 2 ? one : two).set('mod', `k${i}`, i),
      ),
    );
    expect((await one.keys('mod')).sort()).toEqual(
      Array.from({ length: 30 }, (_, i) => `k${i}`).sort(),
    );
  });

  it('refuses a write that takes the store over 4 MiB, keeping what it had', async () => {
    const dir = storeDir();
    const store = new ModStore(dir);
    await store.set('mod', 'kept', 1);
    await expect(
      store.set('mod', 'big', 'x'.repeat(MOD_STORE_MAX_BYTES)),
    ).rejects.toThrow(/over 4194304 bytes/);
    expect(await store.keys('mod')).toEqual(['kept']);
  });

  it('lets a plugin delete keys from a previously oversized key list', async () => {
    const dir = storeDir();
    const first = 'a'.repeat(140_000);
    const second = 'b'.repeat(140_000);
    writeFileSync(
      join(dir, 'mod.json'),
      JSON.stringify({
        version: 1,
        entries: [
          [first, 1],
          [second, 2],
        ],
      }),
    );
    const store = new ModStore(dir);
    await store.delete('mod', second);
    expect(await store.keys('mod')).toEqual([first]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects reads and writes through a symlink to another store',
    async () => {
      const dir = storeDir();
      const store = new ModStore(dir);
      await store.set('target', 'kept', 1);
      symlinkSync('target.json', join(dir, 'alias.json'));
      await expect(store.get('alias', 'kept')).rejects.toThrow(/cannot read/);
      await expect(store.set('alias', 'kept', 2)).rejects.toThrow(
        /cannot read/,
      );
      expect(await store.get('target', 'kept')).toBe(1);
    },
  );

  it('retries a store replaced during the no-follow identity check', async () => {
    const store = new ModStore(storeDir());
    await store.set('mod', 'kept', 1);
    const open = vi
      .spyOn(noFollow, 'openNoFollow')
      .mockRejectedValueOnce(
        Object.assign(new Error('file identity changed'), { code: 'ELOOP' }),
      );
    try {
      await expect(store.get('mod', 'kept')).resolves.toBe(1);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
    }
  });

  it('names the file after the plugin, without case, and only inside its directory', async () => {
    const dir = storeDir();
    const store = new ModStore(dir);
    await store.set('My.Mod', 'k', 1);
    expect(await store.get('my.mod', 'k')).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'my.mod.json'), 'utf8'))).toEqual({
      version: 1,
      entries: [['k', 1]],
    });
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'my.mod.json')).mode & 0o777).toBe(0o600);
    for (const name of ['..', '.', 'a/b', '', 'a\\b'])
      await expect(store.get(name, 'k')).rejects.toThrow(
        /no store for the plugin name/,
      );
  });

  it('reads an absent store as empty and writes nothing for a delete of nothing', async () => {
    const dir = storeDir();
    const store = new ModStore(dir);
    expect(await store.keys('mod')).toEqual([]);
    await store.delete('mod', 'k');
    expect(() => statSync(join(dir, 'mod.json'))).toThrow();
  });
});
