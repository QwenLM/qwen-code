/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import { ModStore } from './store.js';

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

  it('waits for a write another process holds, then keeps what it wrote', async () => {
    const dir = storeDir();
    const file = join(dir, 'mod.json');
    const release = await lockfile.lock(file, { realpath: false });
    let landed = false;
    const write = new ModStore(dir).set('mod', 'mine', 2).then(() => {
      landed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(landed).toBe(false);
    // The other process writes while it holds the lock.
    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: [['theirs', 1]] }),
    );
    await release();
    await write;
    expect(await new ModStore(dir).keys('mod')).toEqual(['theirs', 'mine']);
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
