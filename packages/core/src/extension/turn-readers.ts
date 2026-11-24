/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { statfsSync, type Dirent } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isNodeError } from '../utils/errors.js';

export class ExtensionStoreInUseError extends Error {
  readonly code = 'extension_store_in_use';

  constructor() {
    super('extension_store_in_use: an active turn holds the extension store');
    this.name = 'ExtensionStoreInUseError';
  }
}

// Pathname sockets are meaningful only on a local filesystem. A remote kernel
// could otherwise report ECONNREFUSED for a live reader on another machine.
const localTypes =
  process.platform === 'linux'
    ? new Set([
        0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1,
        0x858458f6,
      ])
    : process.platform === 'darwin'
      ? new Set([17, 26])
      : new Set<number>();

/** Capability probe before the Store exists. Actual admission rechecks the live mount. */
export function supportsLocalExtensionTurnStore(storeDir: string): boolean {
  let candidate = path.resolve(storeDir);
  for (;;) {
    try {
      return localTypes.has(statfsSync(candidate).type >>> 0);
    } catch (error) {
      const parent = path.dirname(candidate);
      if (
        !isNodeError(error) ||
        error.code !== 'ENOENT' ||
        parent === candidate
      )
        return false;
      candidate = parent;
    }
  }
}

// AF_UNIX has a small address limit. Bind through a private short alias; the
// socket inode itself lives in the Store, including when QWEN_HOME is long.
async function withSocketDirectory<T>(
  directory: string,
  probe: (alias: string) => Promise<T>,
): Promise<T> {
  const prefix = path.join(tmpdir(), 'qwen-er-');
  // Leave space for mkdtemp's suffix, the alias, the UUID and the terminating NUL.
  const socketPath = path.join(prefix + 'XXXXXX', 'r', '0'.repeat(36));
  const temp = await fs.mkdtemp(
    Buffer.byteLength(socketPath) < 104 ? prefix : '/tmp/qwen-er-',
  );
  try {
    const alias = path.join(temp, 'r');
    await fs.symlink(directory, alias);
    return await probe(alias);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

export async function createExtensionTurnReader(
  storeDir: string,
): Promise<() => Promise<void>> {
  const directory = path.join(storeDir, '.turn-readers');
  if (!localTypes.has((await fs.statfs(storeDir)).type >>> 0)) {
    throw new Error(
      'Extension turn leases require a supported local filesystem',
    );
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const name = randomUUID();
  const server = net.createServer((peer) => peer.destroy());
  await withSocketDirectory(directory, async (alias) => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(alias, name), () => {
        server.off('error', reject);
        server.unref();
        resolve();
      });
    });
  });
  let closed = false;
  return async () => {
    if (!closed) {
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlinkIfPresent(path.join(directory, name));
  };
}

// Called under the Store lock. A successful connection establishes liveness
// without asking a process to answer. On exit (including SIGKILL), the kernel
// closes the listener; PID reuse and wall clock/heartbeat delays do not matter.
export async function assertNoExtensionTurnReaders(
  storeDir: string,
): Promise<void> {
  const directory = path.join(storeDir, '.turn-readers');
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(directory, { withFileTypes: true })).filter(
      (entry) => !(entry.isFile() && entry.name.startsWith('.')),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (!entries.length) return;
  if (!localTypes.has((await fs.statfs(storeDir)).type >>> 0))
    throw new ExtensionStoreInUseError();
  await withSocketDirectory(directory, async (alias) => {
    for (const { name } of entries) {
      if (!/^[0-9a-f-]{36}$/.test(name)) throw new ExtensionStoreInUseError();
      const held = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(path.join(alias, name));
        const finish = (live: boolean) => {
          socket.destroy();
          resolve(live);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', (error) =>
          finish(
            !isNodeError(error) ||
              (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'),
          ),
        );
        socket.setTimeout(1000, () => finish(true));
      });
      if (held) throw new ExtensionStoreInUseError();
      await unlinkIfPresent(path.join(directory, name));
    }
  });
}
