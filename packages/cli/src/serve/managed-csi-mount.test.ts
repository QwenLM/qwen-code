/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs, type PathLike } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedCsiMount, parseManagedCsiMount } from './managed-csi-mount.js';
import { registerManagedContextRoutes } from './managed-context-worker.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import {
  WORKSPACE_ACTIVATION_ROUTE,
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';

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
  const addresses: string[] = [];
  const descriptorPaths = new Map<number, string>();
  let rootHandle: FileHandle | undefined;
  let metadataOpens = 0;
  const nativeOpen = fs.open;
  const translate = (requested: PathLike): PathLike => {
    if (typeof requested !== 'string') return requested;
    const descriptor = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(requested);
    if (!descriptor) return requested;
    addresses.push(requested);
    const directory = descriptorPaths.get(Number(descriptor[1]));
    if (directory === undefined) throw new Error('Fixture fd is not owned.');
    return descriptor[2] ? path.join(directory, descriptor[2]) : directory;
  };
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const requested = args[0];
    const file =
      requested === '/proc/self/mountinfo'
        ? mountinfo
        : requested === `/sys/dev/block/${device}/device/serial`
          ? serial
          : translate(requested);
    const handle = await nativeOpen(file, args[1], args[2]);
    handles.push(handle);
    if (typeof file === 'string') descriptorPaths.set(handle.fd, file);
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
  const nativeLstat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) =>
    nativeLstat(translate(args[0]), args[1]),
  );
  const nativeAccess = fs.access;
  vi.spyOn(fs, 'access').mockImplementation(async (...args) =>
    nativeAccess(translate(args[0]), args[1]),
  );
  const mount = new ManagedCsiMount(root, 'owned-serial');
  onTestFinished(async () => {
    release.resolve();
    await mount.close().catch(() => {});
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
    root,
    mountinfo,
    serial,
    addresses,
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
    it.each([false, true])(
      'preserves initial root cleanup failure separately from acquisition refusal (close fails: %s)',
      async (closeFails) => {
        const owned = await observationFixture();
        const fixtureOpen = fs.open;
        let close: ReturnType<typeof vi.spyOn> | undefined;
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await fixtureOpen(...args);
          if (args[0] === owned.root) {
            vi.spyOn(handle, 'stat').mockRejectedValueOnce(
              new Error('initial root stat failed'),
            );
            close = vi.spyOn(handle, 'close');
            if (closeFails)
              close.mockRejectedValueOnce(
                new Error('initial root close failed'),
              );
          }
          return handle;
        });
        await expect(owned.mount.observe()).rejects.toThrow('unavailable');
        expect(owned.mount.isAvailable).toBe(false);
        expect(close).toHaveBeenCalledTimes(1);
        const closing = owned.mount.close();
        expect(owned.mount.close()).toBe(closing);
        if (closeFails) {
          await expect(closing).rejects.toMatchObject({
            message: 'Managed CSI root directory cleanup failed.',
            errors: [
              expect.objectContaining({ message: 'initial root stat failed' }),
              expect.objectContaining({ message: 'initial root close failed' }),
            ],
          });
          expect((await owned.rootHandle!.stat()).isDirectory()).toBe(true);
          // This explicit test cleanup does not qualify product joining.
          await owned.rootHandle!.close();
        } else {
          await expect(closing).resolves.toBeUndefined();
          expect(owned.handles.every((handle) => handle.fd === -1)).toBe(true);
        }
      },
    );

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
      expect(await owned.mount.rootDirectory()).toBeUndefined();
    });

    it('borrows the original descriptor and preserves it after ordinary callback failure', async () => {
      const owned = await observationFixture();
      await owned.mount.observe();
      const original = owned.rootHandle;
      const failure = new Error('Callback failed.');
      await expect(
        owned.mount.withVerifiedRoot(async (handle, receipt) => {
          expect(handle).toBe(original);
          expect(receipt.rootInode).toBe(owned.stats.ino.toString());
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(owned.mount.isAvailable).toBe(true);
      expect(await owned.mount.rootDirectory()).toBe(owned.root);
      expect(owned.rootHandle).toBe(original);
    });

    it('keeps sibling reads refused when CSI identity fails inside an admitted call', async () => {
      const owned = await observationFixture();
      await fs.mkdir(path.join(owned.root, 'sub'));
      await fs.writeFile(
        path.join(owned.root, 'sub', 'secret.txt'),
        'sibling-secret',
      );
      await owned.mount.observe();
      const fixture = JSON.parse(
        await fs.readFile(
          new URL(
            './contracts/managed-context-v1.fixtures.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { boot: ManagedContextBoot };
      const boot = {
        ...fixture.boot,
        mountRoot: owned.root,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      };
      const app = express();
      const executor = registerManagedContextRoutes(
        app,
        boot,
        undefined,
        undefined,
        owned.mount,
      );
      const server = app.listen(0, '127.0.0.1');
      onTestFinished(async () => {
        await executor.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      });
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (route: string, body: unknown) =>
        fetch(`${origin}${route}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${boot.token}`,
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'x-qwen-managed-lease-id': boot.leaseId,
            'x-qwen-managed-lease-epoch': String(boot.epoch),
          },
          body: JSON.stringify(body),
        });
      for (const [sessionId, cwdRelative] of [
        ['root-session', '.'],
        ['sibling', 'sub'],
      ]) {
        const binding = {
          tenantId: boot.tenantId,
          workspaceId: boot.workspaceId,
          workspaceGeneration: boot.workspaceGeneration,
          storageId: boot.storageId,
          cwdRelative,
          contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
          contextRevision: '1',
        };
        const contextDigest = computeManagedContextDigest(binding);
        expect(
          (
            await post('/internal/managed-runtime/v3/context', {
              protocolVersion: 3,
              managedContext: boot.managedContext,
              operationId: `install-${sessionId}`,
              sessionId,
              binding,
              contextDigest,
            })
          ).status,
        ).toBe(200);
        if (sessionId === 'root-session')
          expect(
            (
              await post(WORKSPACE_ACTIVATION_ROUTE.path, {
                protocolVersion: 1,
                operation: 'activate',
                sessionId,
                contextDigest,
                contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
                profile: WORKSPACE_EXECUTION_PROFILE,
              })
            ).status,
          ).toBe(200);
      }
      const read = async (callId: string) => {
        const response = await post('/internal/managed-runtime/v2/execute', {
          protocolVersion: 2,
          reference: {
            sessionId: 'root-session',
            promptId: 'prompt-1',
            callId,
            argsDigest: `digest-${callId}`,
          },
          toolName: 'read_file',
          input: { file_path: 'sub/secret.txt' },
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const control = await read('control');
      expect(control.result.executionStatus).toBe('error');
      const nativeRoot = owned.mount.rootDirectory.bind(owned.mount);
      vi.spyOn(owned.mount, 'rootDirectory').mockImplementation(async () => {
        await fs.writeFile(owned.serial, 'changed-serial\n');
        return nativeRoot();
      });
      const fenced = await read('fenced');
      expect(owned.mount.isAvailable).toBe(false);
      expect(fenced.result.executionStatus).toBe('error');
      expect(JSON.stringify(fenced)).not.toContain('sibling-secret');
    });

    it('joins the whole callback and rejects its result after close fences new borrows', async () => {
      const owned = await observationFixture();
      const entered = deferred();
      const release = deferred();
      const operation = owned.mount
        .withVerifiedRoot(async (handle) => {
          expect(handle).toBe(owned.rootHandle);
          entered.resolve();
          await release.promise;
          expect((await handle.stat()).isDirectory()).toBe(true);
          return 'unqualified result';
        })
        .catch((error: unknown) => error);
      try {
        await entered.promise;
        const close = vi.spyOn(owned.rootHandle!, 'close');
        const closing = owned.mount.close();
        expect(owned.mount.close()).toBe(closing);
        const late = vi.fn(async () => {});
        await expect(owned.mount.withVerifiedRoot(late)).rejects.toThrow(
          'unavailable',
        );
        expect(late).not.toHaveBeenCalled();
        expect(await owned.mount.rootDirectory()).toBeUndefined();
        expect(close).not.toHaveBeenCalled();
        release.resolve();
        await expect(operation).resolves.toMatchObject({
          message: expect.stringContaining('unavailable'),
        });
        await closing;
        expect(close).toHaveBeenCalledTimes(1);
        expect(owned.handles.every((handle) => handle.fd === -1)).toBe(true);
      } finally {
        release.resolve();
        await operation;
      }
    });

    it.each(['root', 'mount', 'serial'])(
      'fences a %s replacement observed after the callback',
      async (replacement) => {
        const owned = await observationFixture();
        await expect(
          owned.mount.withVerifiedRoot(async () => {
            if (replacement === 'root') {
              await fs.rename(owned.root, `${owned.root}-original`);
              await fs.mkdir(owned.root);
            } else if (replacement === 'mount') {
              const contents = await fs.readFile(owned.mountinfo, 'utf8');
              await fs.writeFile(
                owned.mountinfo,
                contents.replace('2194 ', '2195 '),
              );
            } else await fs.writeFile(owned.serial, 'changed-serial\n');
            return 'unqualified';
          }),
        ).rejects.toThrow('unavailable');
        expect(owned.mount.isAvailable).toBe(false);
        await expect(owned.mount.observe()).rejects.toThrow('unavailable');
        await owned.mount.close();
        expect(owned.handles.every((handle) => handle.fd === -1)).toBe(true);
      },
    );

    it('resolves canonical directories with a retained one-component walk', async () => {
      const owned = await observationFixture();
      await fs.mkdir(path.join(owned.root, 'a', 'b'), { recursive: true });
      expect(await owned.mount.resolve('.')).toBe(owned.root);
      expect(await owned.mount.resolve('a/b')).toBe(
        path.join(owned.root, 'a', 'b'),
      );
      const leafAddresses = owned.addresses.filter((address) =>
        /\/fd\/\d+\//.test(address),
      );
      expect(leafAddresses.length).toBeGreaterThan(0);
      expect(
        leafAddresses.every((address) =>
          /^\/proc\/self\/fd\/\d+\/[^/]+$/.test(address),
        ),
      ).toBe(true);
      expect(owned.handles.filter((handle) => handle.fd !== -1)).toEqual([
        owned.rootHandle,
      ]);
      expect(await owned.mount.resolve('missing')).toBeUndefined();
      expect(owned.mount.isAvailable).toBe(true);
    });

    it.each([
      '',
      '/outside',
      '..',
      'a/../b',
      'a//b',
      './a',
      'a/',
      'a\\b',
      'a\0b',
    ])('rejects malformed normalized cwd %s before I/O', async (cwd) => {
      const owned = await observationFixture();
      await owned.mount.observe();
      const count = owned.handles.length;
      expect(await owned.mount.resolve(cwd)).toBeUndefined();
      expect(owned.handles).toHaveLength(count);
      expect(owned.mount.isAvailable).toBe(true);
      expect(await owned.mount.resolve('.')).toBe(owned.root);
    });

    it('refuses a child whose named and descriptor devices both differ from the root', async () => {
      const owned = await observationFixture();
      await fs.mkdir(path.join(owned.root, 'foreign'));
      const foreign = await fs.lstat(path.join(owned.root, 'foreign'), {
        bigint: true,
      });
      Object.defineProperty(foreign, 'dev', { value: owned.stats.dev + 1n });
      const fixtureLstat = fs.lstat;
      const fixtureOpen = fs.open;
      const isChild = (requested: PathLike) =>
        typeof requested === 'string' &&
        /^\/proc\/self\/fd\/\d+\/foreign$/.test(requested);
      vi.spyOn(fs, 'lstat').mockImplementation(async (...args) =>
        isChild(args[0]) ? foreign : fixtureLstat(...args),
      );
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await fixtureOpen(...args);
        if (isChild(args[0]))
          vi.spyOn(handle, 'stat').mockResolvedValue(foreign);
        return handle;
      });
      expect(await owned.mount.resolve('foreign')).toBeUndefined();
      expect(owned.mount.isAvailable).toBe(true);
      expect(owned.handles.filter((handle) => handle.fd !== -1)).toEqual([
        owned.rootHandle,
      ]);
    });

    it.each(['first-symlink', 'leaf-symlink', 'file'])(
      'refuses %s and releases every walked descriptor',
      async (kind) => {
        const owned = await observationFixture();
        await fs.mkdir(path.join(owned.root, 'a'));
        await fs.mkdir(path.join(owned.root, 'real'));
        if (kind === 'first-symlink')
          await fs.symlink('real', path.join(owned.root, 'alias'));
        else if (kind === 'leaf-symlink')
          await fs.symlink('../real', path.join(owned.root, 'a', 'b'));
        else
          await fs.writeFile(
            path.join(owned.root, 'a', 'b'),
            'not a directory',
          );
        expect(
          await owned.mount.resolve(kind === 'first-symlink' ? 'alias' : 'a/b'),
        ).toBeUndefined();
        expect(owned.handles.filter((handle) => handle.fd !== -1)).toEqual([
          owned.rootHandle,
        ]);
        expect(owned.mount.isAvailable).toBe(true);
      },
    );

    it('refuses a child replaced after its descriptor was opened', async () => {
      const owned = await observationFixture();
      await fs.mkdir(path.join(owned.root, 'a'));
      const fixtureOpen = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await fixtureOpen(...args);
        if (
          typeof args[0] === 'string' &&
          /^\/proc\/self\/fd\/\d+\/a$/.test(args[0])
        ) {
          await fs.rename(
            path.join(owned.root, 'a'),
            path.join(owned.root, 'old-a'),
          );
          await fs.mkdir(path.join(owned.root, 'a'));
        }
        return handle;
      });
      expect(await owned.mount.resolve('a')).toBeUndefined();
      expect(owned.handles.filter((handle) => handle.fd !== -1)).toEqual([
        owned.rootHandle,
      ]);
      expect(owned.mount.isAvailable).toBe(true);
      expect(await owned.mount.resolve('.')).toBe(owned.root);
    });

    it('joins other child closes and retains a failed close as a permanent blocker', async () => {
      const owned = await observationFixture();
      await fs.mkdir(path.join(owned.root, 'a', 'b'), { recursive: true });
      const fixtureOpen = fs.open;
      let failed: FileHandle | undefined;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await fixtureOpen(...args);
        if (
          typeof args[0] === 'string' &&
          /^\/proc\/self\/fd\/\d+\/b$/.test(args[0])
        ) {
          failed = handle;
          vi.spyOn(handle, 'close').mockRejectedValueOnce(
            new Error('close failed'),
          );
        }
        return handle;
      });
      expect(await owned.mount.resolve('a/b')).toBeUndefined();
      expect(owned.mount.isAvailable).toBe(false);
      const closing = owned.mount.close();
      expect(owned.mount.close()).toBe(closing);
      await expect(closing).rejects.toThrow('unavailable');
      expect(owned.handles.filter((handle) => handle.fd !== -1)).toEqual([
        failed,
      ]);
      expect(await owned.mount.rootDirectory()).toBeUndefined();
      // Cleanup of this deliberately failed owned handle is not product joining.
      await failed!.close();
    });

    it('retains child and root failures when both descriptor closes reject', async () => {
      const owned = await observationFixture();
      await fs.mkdir(path.join(owned.root, 'child'));
      await owned.mount.observe();
      const rootFailure = new Error('root close failed');
      const childFailure = new Error('child close failed');
      vi.spyOn(owned.rootHandle!, 'close').mockRejectedValueOnce(rootFailure);
      const fixtureOpen = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await fixtureOpen(...args);
        if (
          typeof args[0] === 'string' &&
          /^\/proc\/self\/fd\/\d+\/child$/.test(args[0])
        )
          vi.spyOn(handle, 'close').mockRejectedValueOnce(childFailure);
        return handle;
      });
      expect(await owned.mount.resolve('child')).toBeUndefined();
      const closing = owned.mount.close();
      expect(owned.mount.close()).toBe(closing);
      await expect(closing).rejects.toMatchObject({
        errors: [
          expect.objectContaining({ errors: [childFailure] }),
          rootFailure,
        ],
      });
      expect(owned.mount.isAvailable).toBe(false);
    });

    it.each([0, 1])(
      'joins both initial observations when observation %s returns first',
      async (first) => {
        const owned = await observationFixture();
        const entered = [deferred(), deferred()];
        const release = [deferred(), deferred()];
        let metadataOpens = 0;
        const fixtureOpen = fs.open;
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await fixtureOpen(...args);
          if (args[0] === '/proc/self/mountinfo') {
            const index = metadataOpens++;
            entered[index].resolve();
            await release[index].promise;
          }
          return handle;
        });
        const observations = [
          owned.mount.observe().catch((error: unknown) => error),
        ];
        try {
          await entered[0].promise;
          observations.push(
            owned.mount.observe().catch((error: unknown) => error),
          );
          await Promise.all(entered.map((gate) => gate.promise));
          expect(owned.rootHandle).toBeUndefined();
          let closed = false;
          const closing = owned.mount.close();
          void closing.then(() => {
            closed = true;
          });
          release[first].resolve();
          await observations[first];
          await new Promise(setImmediate);
          expect(closed).toBe(false);
          release[1 - first].resolve();
          const results = await Promise.all(observations);
          expect(results).toEqual([
            expect.objectContaining({
              message: expect.stringContaining('unavailable'),
            }),
            expect.objectContaining({
              message: expect.stringContaining('unavailable'),
            }),
          ]);
          await closing;
          expect(owned.handles.every((handle) => handle.fd === -1)).toBe(true);
        } finally {
          release.forEach((gate) => gate.resolve());
          await Promise.all(observations);
        }
      },
    );

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
