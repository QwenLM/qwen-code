/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function prepareSocketDirectory(
  socketPath: string,
): Promise<void> {
  if (process.platform === 'win32') return;
  await mkdir(dirname(socketPath), { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  await verifySocketDirectory(socketPath);
}

async function verifySocketDirectory(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = dirname(socketPath);
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Chrome bridge requires a private user-owned directory: ${directory}`,
    );
  }
  // Ancestors must not let another user replace the private directory. Root's
  // sticky /tmp is safe; canonicalization also handles macOS /var and /tmp.
  for (const start of [resolve(directory), await realpath(directory)]) {
    let ancestor = dirname(start);
    for (;;) {
      const entry = await lstat(ancestor);
      const parent = await stat(ancestor);
      if (
        (entry.uid !== 0 && entry.uid !== process.getuid!()) ||
        (parent.uid !== 0 && parent.uid !== process.getuid!()) ||
        ((parent.mode & 0o022) !== 0 &&
          !(parent.uid === 0 && (parent.mode & 0o1000) !== 0))
      ) {
        throw new Error(
          `Chrome bridge socket has an unsafe ancestor: ${ancestor}`,
        );
      }
      const next = dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  }
}

export async function verifySocketPeerPath(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  await verifySocketDirectory(socketPath);
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid!()) {
    throw new Error(
      `Chrome bridge requires a user-owned socket: ${socketPath}`,
    );
  }
}
