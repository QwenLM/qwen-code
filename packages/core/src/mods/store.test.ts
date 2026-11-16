/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statfsSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open, readdir, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

  const bootId = process.platform === 'linux' ? readLocalBootId() : null;
  const pidNamespace = readPidNamespaceId();
  const machineScope = (() => {
    if (bootId === null || pidNamespace === null) return null;
    try {
      if (statfsSync('/proc/sys/kernel/random/boot_id').type !== 0x9fa0)
        return null;
      const id = readFileSync('/etc/machine-id', 'utf8').trim();
      if (!/^[a-f0-9]{32}$/i.test(id) || /^0+$/.test(id)) return null;
      return createHmac('sha256', 'Qwen-Code/ModStore/lock-host')
        .update(Buffer.from(id, 'hex'))
        .digest('hex')
        .slice(0, 32);
    } catch {
      return null;
    }
  })();
  const heldLock = (
    dir: string,
    pid: number,
    identity?: {
      boot?: string;
      machine?: string;
      namespace?: number;
      legacy?: boolean;
      start?: string;
    },
  ) => {
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          hostname(),
          identity?.namespace ?? pidNamespace,
          identity?.boot ?? bootId,
        ]),
      )
      .digest('hex')
      .slice(0, 16);
    const lock = join(dir, 'mod.json.lock');
    const suffix = identity?.machine
      ? `${identity.legacy ? '' : '.k'}.${identity.machine}.${identity.boot}`
      : '';
    const owner = join(
      lock,
      `${scope}.${pid}.${identity?.start ?? '-'}.${randomUUID()}${suffix}`,
    );
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

  it.runIf(machineScope !== null)(
    'recovers a verified earlier boot in this PID namespace even if its PID is in use',
    async () => {
      const dir = storeDir();
      const { lock, owner } = heldLock(dir, process.pid, {
        boot: randomUUID(),
        machine: machineScope!,
      });
      writeFileSync(join(owner, 'store.json'), 'incomplete');
      const store = new ModStore(dir);
      await store.set('mod', 'kept', 1);
      expect(await store.get('mod', 'kept')).toBe(1);
      expect(() => statSync(lock)).toThrow();
    },
  );

  const expectLockRetained = async (
    store: ModStore,
    { lock, owner }: ReturnType<typeof heldLock>,
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      await expect(
        store.set('mod', 'kept', 1, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(await readdir(lock)).toEqual([basename(owner)]);
      expect(await store.keys('mod')).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  };

  it.runIf(machineScope !== null).each([
    ['an older marker', { legacy: true }],
    ['another PID namespace', { namespace: (pidNamespace ?? 0) + 1 }],
  ] as const)(
    'preserves an earlier boot lock with %s',
    async (_case, identity) => {
      const dir = storeDir();
      const lock = heldLock(dir, process.pid, {
        boot: randomUUID(),
        machine: machineScope!,
        ...identity,
      });
      await expectLockRetained(new ModStore(dir), lock);
    },
  );

  it.runIf(machineScope !== null)(
    'preserves an earlier boot lock when the reaper reads a virtual boot ID',
    async () => {
      const dir = storeDir();
      const lock = heldLock(dir, process.pid, {
        boot: randomUUID(),
        machine: machineScope!,
      });
      const checkedBootFile = vi.fn();
      vi.resetModules();
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        return {
          ...actual,
          statfsSync(file: string) {
            const stat = actual.statfsSync(file);
            if (!file.startsWith('/proc/self/fd/')) return stat;
            checkedBootFile(file);
            return { ...stat, type: 0x01021994 };
          },
        };
      });
      try {
        const { ModStore: VirtualBootStore } = await import('./store.js');
        expect(checkedBootFile).toHaveBeenCalled();
        await expectLockRetained(new VirtualBootStore(dir), lock);
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
      }
    },
  );

  const fixtureBoot = '1e0d09fd-4d0b-4b9d-9d1b-2f0c1a3b4c5d';
  const fixturePidNamespace = 4026531836;
  const fixtureTimeNamespace = 4026531834;
  const recorded = Buffer.from(`${fixtureBoot}:1000`).toString('base64url');
  const scopedStart = `${fixtureTimeNamespace}~${recorded}`;

  it.each([
    ['an ancestor procfs view', scopedStart, 'Z', false, false],
    ['a different time namespace', `4026531900~${recorded}`, 'S', true, false],
    ['a legacy start token', recorded, 'S', true, false],
    ['a reused PID in the same time namespace', scopedStart, 'S', true, true],
    ['a verified zombie', recorded, 'Z', true, true],
  ] as const)(
    'checks same-boot ownership with %s',
    async (_case, start, state, localProc, recover) => {
      const dir = storeDir();
      const lock = heldLock(dir, process.pid, {
        boot: fixtureBoot,
        namespace: fixturePidNamespace,
        start,
      });
      vi.resetModules();
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        return {
          ...actual,
          readFileSync(file: string | number) {
            if (file === '/proc/sys/kernel/random/boot_id') return fixtureBoot;
            if (file === '/proc/self/status')
              return `NStgid:\t${process.pid}${localProc ? '' : `\t${process.pid}`}\n`;
            if (file === `/proc/${process.pid}/stat`)
              return `${process.pid} (mod) ${state} ${'0 '.repeat(18)}2000`;
            return actual.readFileSync(file, 'utf8');
          },
          statSync(file: string) {
            if (file === '/proc/self/ns/pid')
              return { ino: fixturePidNamespace };
            if (file === '/proc/self/ns/time')
              return { ino: fixtureTimeNamespace };
            return actual.statSync(file);
          },
        };
      });
      const platform = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue('linux');
      try {
        const { ModStore: LinuxStore } = await import('./store.js');
        const store = new LinuxStore(dir);
        if (recover) {
          await store.set('mod', 'kept', 1, AbortSignal.timeout(2000));
          expect(await store.keys('mod')).toEqual(['kept']);
          expect(await readdir(dir)).toEqual(['mod.json']);
        } else await expectLockRetained(store, lock);
      } finally {
        platform.mockRestore();
        vi.doUnmock('node:fs');
        vi.resetModules();
      }
    },
  );

  it('cancels both lock waits while preserving the existing owner', async () => {
    const dir = storeDir();
    const { lock, owner } = heldLock(dir, process.pid, {
      boot: randomUUID(),
      machine: randomUUID().replaceAll('-', ''),
    });
    const store = new ModStore(dir);
    const fileWait = new AbortController();
    const localWait = new AbortController();
    const first = store.set('mod', 'first', 1, fileWait.signal);
    void first.catch(() => {});
    const second = store.delete('mod', 'second', localWait.signal);
    let localCancelled = false;
    void second.catch(() => {
      localCancelled = true;
    });
    try {
      await vi.waitFor(async () => {
        expect(
          (await readdir(dir)).some((name) =>
            name.startsWith('mod.json.lock.'),
          ),
        ).toBe(true);
      });
      localWait.abort();
      await vi.waitFor(() => expect(localCancelled).toBe(true));
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      fileWait.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(await readdir(dir)).toEqual(['mod.json.lock']);
      expect(await readdir(lock)).toEqual([basename(owner)]);
      expect(await store.keys('mod')).toEqual([]);
    } finally {
      fileWait.abort();
      localWait.abort();
      await Promise.allSettled([first, second]);
    }
  });

  it('finishes an update when cancellation arrives after acquiring both locks', async () => {
    const store = new ModStore(storeDir());
    const controller = new AbortController();
    const original = noFollow.openNoFollow;
    const opened = vi
      .spyOn(noFollow, 'openNoFollow')
      .mockImplementationOnce((...args) => {
        controller.abort();
        return original(...args);
      });
    try {
      await store.set('mod', 'kept', 1, controller.signal);
      expect(controller.signal.aborted).toBe(true);
      expect(await store.get('mod', 'kept')).toBe(1);
    } finally {
      opened.mockRestore();
    }
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

  it.skipIf(process.platform === 'win32')(
    'refuses a named pipe before waiting for a writer',
    async () => {
      const dir = storeDir();
      const file = join(dir, 'mod.json');
      expect(spawnSync('mkfifo', [file]).status).toBe(0);
      let unblocked = false;
      const timer = setTimeout(() => {
        unblocked = true;
        void open(file, constants.O_WRONLY | constants.O_NONBLOCK)
          .then((handle) => handle.close())
          .catch(() => {});
      }, 1500);
      try {
        await expect(new ModStore(dir).get('mod', 'k')).rejects.toThrow(
          /not a regular file/,
        );
        expect(unblocked).toBe(false);
      } finally {
        clearTimeout(timer);
      }
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

  it('maps long plugin names to separate compact files without case', async () => {
    const dir = storeDir();
    const first = 'a'.repeat(129);
    const second = 'a'.repeat(128) + 'b';
    const store = new ModStore(dir);
    await store.set(first.toUpperCase(), 'k', 1);
    await store.set(second, 'k', 2);

    const reopened = new ModStore(dir);
    expect(await reopened.get(first, 'k')).toBe(1);
    expect(await reopened.get(second, 'k')).toBe(2);
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    expect(files.every((file) => /^~[a-f0-9]{64}\.json$/.test(file))).toBe(
      true,
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
