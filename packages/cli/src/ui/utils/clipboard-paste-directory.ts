/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken,
} from '@qwen-code/qwen-code-core/utils/process-liveness.js';
import { registerCleanup } from '../../utils/cleanup.js';

const directories = new Map<string, Promise<string>>();

export function getClipboardPasteDirectory(
  runtimeDir: string,
): Promise<string> {
  const root = path.resolve(runtimeDir, 'clipboard');
  const existing = directories.get(root);
  if (existing) return existing;
  const pending = createDirectory(root);
  directories.set(root, pending);
  void pending.catch(() => {
    if (directories.get(root) === pending) directories.delete(root);
  });
  return pending;
}

async function createDirectory(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const pidNs = readPidNamespaceId();
  const bootId = readLocalBootId();
  // Shared homes can contain live owners invisible to our PID namespace.
  // Unknown identities (including legacy directories) must never be reaped.
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const owner = /^paste-(\d+)-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!owner || !entry.isDirectory() || pidNs === null || bootId === null)
      continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const directory = path.join(root, entry.name);
    let identity: { pidNs?: unknown; procStart?: unknown } | null;
    try {
      identity = JSON.parse(
        await fs.readFile(path.join(directory, 'owner.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    if (
      identity?.pidNs !== pidNs ||
      typeof identity.procStart !== 'string' ||
      !identity.procStart.startsWith(`${bootId}:`) ||
      !/^\d+$/.test(identity.procStart.slice(bootId.length + 1))
    )
      continue;
    let stale = false;
    try {
      process.kill(pid, 0);
      const currentStart = readProcStartToken(pid);
      stale = currentStart !== null && currentStart !== identity.procStart;
    } catch (error) {
      stale = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (stale)
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  const directory = await fs.mkdtemp(path.join(root, `paste-${process.pid}-`));
  try {
    await fs.writeFile(
      path.join(directory, 'owner.json'),
      JSON.stringify({ pidNs, procStart: readProcStartToken(process.pid) }),
    );
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  registerCleanup(async () => {
    directories.delete(root);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
