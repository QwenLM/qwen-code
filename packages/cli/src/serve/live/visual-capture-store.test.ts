/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveVisualCaptureStore } from './visual-capture-store.js';

const cleanup: string[] = [];
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'live-capture-store-'));
  cleanup.push(directory);
  return directory;
}

describe('LiveVisualCaptureStore', () => {
  it('writes the image into a private directory under a name it chooses', async () => {
    const base = await scratch();
    const directory = join(base, 'captures');
    const store = new LiveVisualCaptureStore(directory);

    const path = await store.store(IMAGE);

    expect(dirname(path)).toBe(directory);
    await expect(readFile(path)).resolves.toEqual(IMAGE);
    const stat = await lstat(path);
    expect(stat.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o077).toBe(0);
      expect((await lstat(directory)).mode & 0o077).toBe(0);
    }
    store.dispose();
  });

  it('gives every capture its own path', async () => {
    const store = new LiveVisualCaptureStore(join(await scratch(), 'captures'));

    const first = await store.store(IMAGE);
    const second = await store.store(IMAGE);

    expect(first).not.toBe(second);
    store.dispose();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a capture directory anyone else can read',
    async () => {
      const base = await scratch();
      const directory = join(base, 'captures');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o755);
      const store = new LiveVisualCaptureStore(directory);

      await expect(store.store(IMAGE)).rejects.toThrow('is not private');
      store.dispose();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a capture directory that is a symlink elsewhere',
    async () => {
      const base = await scratch();
      const real = join(base, 'real');
      await mkdir(real, { mode: 0o700 });
      const linked = join(base, 'captures');
      await symlink(real, linked);
      const store = new LiveVisualCaptureStore(linked);

      // `mkdir -p` is happy with an existing symlink to a directory, so the
      // lstat is what stands between a capture and a path someone else aimed.
      await expect(store.store(IMAGE)).rejects.toThrow('is not private');
      store.dispose();
    },
  );

  it('removes a capture once it has had time to be read', async () => {
    vi.useFakeTimers();
    const store = new LiveVisualCaptureStore(join(await scratch(), 'captures'));

    const path = await store.store(IMAGE);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      await expect(readFile(path)).rejects.toThrow();
    });
    store.dispose();
  });

  it('sweeps captures an earlier run left behind', async () => {
    const base = await scratch();
    const directory = join(base, 'captures');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stale = join(directory, 'stale.jpg');
    await writeFile(stale, IMAGE, { mode: 0o600 });
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(stale, old, old);
    const store = new LiveVisualCaptureStore(directory);

    await store.store(IMAGE);

    await expect(readFile(stale)).rejects.toThrow();
    store.dispose();
  });

  it('leaves nothing behind when it is disposed mid-write', async () => {
    const directory = join(await scratch(), 'captures');
    const store = new LiveVisualCaptureStore(directory);
    // A capture in flight is not yet registered for cleanup, so disposing
    // cannot have removed it; it has to undo itself.
    const pending = store.store(IMAGE);
    store.dispose();

    await expect(pending).rejects.toThrow('shutting down');
    await vi.waitFor(async () => {
      await expect(readdir(directory)).resolves.toEqual([]);
    });
  });

  it('refuses a capture asked for after shutdown without touching the disk', async () => {
    const directory = join(await scratch(), 'captures');
    const store = new LiveVisualCaptureStore(directory);
    store.dispose();

    await expect(store.store(IMAGE)).rejects.toThrow('shutting down');
    // The rejection alone is also produced by the post-write undo, so it is
    // the absence of I/O that pins the pre-write guard: a store that is done
    // does not so much as create its directory.
    await expect(lstat(directory)).rejects.toThrow();
  });

  it('removes what it still holds when the daemon shuts down', async () => {
    const directory = join(await scratch(), 'captures');
    const store = new LiveVisualCaptureStore(directory);
    await store.store(IMAGE);
    await store.store(IMAGE);

    store.dispose();

    await vi.waitFor(async () => {
      await expect(readdir(directory)).resolves.toEqual([]);
    });
  });
});
