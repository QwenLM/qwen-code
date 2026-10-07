/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedCsiMount, parseManagedCsiMount } from './managed-csi-mount.js';

const qualified =
  '2194 2176 259:8 / /workspace rw,relatime - ext4 /dev/nvme2n1 rw\n';
const parent = '2176 2000 0:50 / / rw,relatime - overlay overlay rw\n';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function observationFixture(heldMountinfoOpen?: number) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-csi-join-'));
  const base = await fs.realpath(temporary);
  const root = path.join(base, 'root');
  await fs.mkdir(root);
  const stats = await fs.lstat(root, { bigint: true });
  const device = `${((stats.dev >> 8n) & 0xfffn) | ((stats.dev >> 32n) & 0xfffff000n)}:${(stats.dev & 0xffn) | ((stats.dev >> 12n) & 0xffffff00n)}`;
  const mountinfo = path.join(base, 'mountinfo');
  const serial = path.join(base, 'serial');
  await fs.writeFile(
    mountinfo,
    `2194 2176 ${device} / ${root} rw - ext4 /dev/nvme2n1 rw\n`,
  );
  await fs.writeFile(serial, 'owned-serial\n');
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get(target, key) {
        return key === 'platform' ? 'linux' : Reflect.get(target, key);
      },
    }),
  );
  const entered = deferred();
  const release = deferred();
  const handles: FileHandle[] = [];
  let rootHandle: FileHandle | undefined;
  let metadataOpens = 0;
  const nativeOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const requested = args[0];
    const file =
      requested === '/proc/self/mountinfo'
        ? mountinfo
        : requested === `/sys/dev/block/${device}/device/serial`
          ? serial
          : requested;
    const handle = await nativeOpen(file, args[1], args[2]);
    handles.push(handle);
    if (requested === root) rootHandle = handle;
    if (
      requested === '/proc/self/mountinfo' &&
      ++metadataOpens === heldMountinfoOpen
    ) {
      entered.resolve();
      await release.promise;
    }
    return handle;
  });
  const mount = new ManagedCsiMount(root, 'owned-serial');
  onTestFinished(async () => {
    release.resolve();
    await mount.close();
    for (const handle of handles) {
      if (handle.fd !== -1) await handle.close();
    }
    await fs.rm(base, { recursive: true, force: true });
  });
  return {
    mount,
    handles,
    entered,
    release,
    get rootHandle() {
      return rootHandle;
    },
    stats,
  };
}

describe('ACK Disk mount profile', () => {
  it('parses the retained ACK kernel observation without inferring a CSI handle', () => {
    expect(parseManagedCsiMount(parent + qualified, '/workspace')).toEqual({
      mountId: '2194',
      device: '259:8',
      source: '/dev/nvme2n1',
    });
    expect(
      parseManagedCsiMount(
        qualified.replace('/workspace', '/work\\040space'),
        '/work space',
      ),
    ).toEqual(parseManagedCsiMount(qualified, '/workspace'));
  });

  it.each([
    qualified.replace(' rw,relatime ', ' ro,relatime '),
    qualified.replace('nvme2n1 rw', 'nvme2n1 ro'),
    qualified.replace('ext4', 'overlay'),
    qualified.replace('/dev/nvme2n1', '/dev/nvme2n1p1'),
    qualified.replace('/dev/nvme2n1', '/dev/vda'),
    qualified.replace(' / /workspace', ' /subdir /workspace'),
    qualified.replace('259:8', '../259:8'),
    qualified.replace('2194 ', '+2194 '),
    qualified + qualified,
    qualified + '2195 2194 0:1 / /workspace/covered rw - tmpfs tmpfs rw\n',
    qualified.replace('/workspace', '/another'),
    qualified.replace('/workspace', '/work\\777space'),
    qualified.replace(' - ', ' '),
    qualified.trim() + ' extra',
    parent,
    `${qualified}\0`,
  ])(
    'refuses an unavailable, ambiguous or different filesystem mount',
    (input) => {
      expect(() => parseManagedCsiMount(input, '/workspace')).toThrow(
        'Managed CSI mount is unavailable.',
      );
    },
  );

  it.each([
    '/',
    '/workspace/',
    '/work//space',
    '/work/../space',
    '/work/./space',
    'workspace',
  ])('refuses noncanonical mount root %s', (root) =>
    expect(() => parseManagedCsiMount(qualified, root)).toThrow(),
  );

  it('rejects invalid serial input without opening a mount', () => {
    expect(() => new ManagedCsiMount('/workspace', 'serial\n')).toThrow();
    expect(() => new ManagedCsiMount('/workspace', '../serial')).toThrow();
  });

  it.runIf(process.platform !== 'linux')(
    'permanently fences an unsupported host',
    async () => {
      const mount = new ManagedCsiMount('/workspace', '2zehn959sand8iuw2gyd');
      await expect(mount.observe()).rejects.toThrow(
        'Managed CSI mount is unavailable.',
      );
      expect(mount.isAvailable).toBe(false);
      expect(await mount.resolve('')).toBeUndefined();
    },
  );
});

describe.runIf(process.platform !== 'win32')(
  'mount lifetime with owned metadata fixtures (not Linux/CSI qualification)',
  () => {
    it('publishes the original receipt and closes each owned fd once', async () => {
      const owned = await observationFixture();
      const receipt = await owned.mount.observe();
      expect(receipt.rootDevice).toBe(owned.stats.dev.toString());
      expect(receipt.rootInode).toBe(owned.stats.ino.toString());
      expect(owned.mount.isAvailable).toBe(true);
      expect(await owned.mount.observe()).toEqual(receipt);
      expect(owned.handles.filter((handle) => handle.fd !== -1)).toEqual([
        owned.rootHandle,
      ]);
      const close = vi.spyOn(owned.rootHandle!, 'close');
      const closing = owned.mount.close();
      expect(owned.mount.close()).toBe(closing);
      await closing;
      expect(close).toHaveBeenCalledTimes(1);
      expect(owned.handles.every((handle) => handle.fd === -1)).toBe(true);
    });

    it.each([1, 2])(
      'joins mountinfo open %s, including before the root fd exists',
      async (heldOpen) => {
        const owned = await observationFixture(heldOpen);
        const observation = owned.mount
          .observe()
          .catch((error: unknown) => error);
        try {
          await owned.entered.promise;
          const closing = owned.mount.close();
          expect(owned.mount.close()).toBe(closing);
          let closed = false;
          void closing.then(() => {
            closed = true;
          });
          await new Promise(setImmediate);
          expect(closed).toBe(false);
          expect(owned.mount.isAvailable).toBe(false);
          await expect(owned.mount.observe()).rejects.toThrow('unavailable');
          if (heldOpen === 1) expect(owned.rootHandle).toBeUndefined();
          else {
            expect((await owned.rootHandle!.stat()).isDirectory()).toBe(true);
            expect(owned.handles[2]).toBe(owned.rootHandle);
          }
          expect(owned.handles.at(-1)!.fd).not.toBe(-1);
          owned.release.resolve();
          await expect(observation).resolves.toMatchObject({
            message: 'Managed CSI mount is unavailable.',
          });
          await closing;
          expect(owned.handles.every((handle) => handle.fd === -1)).toBe(true);
        } finally {
          owned.release.resolve();
          await observation;
        }
      },
    );
  },
);
