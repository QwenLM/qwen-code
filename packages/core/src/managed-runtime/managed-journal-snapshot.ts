/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const MANAGED_JOURNAL_COMPACT_BYTES = 64 * 1024;

export function encodeManagedJournalSnapshot(
  type: string,
  state: Record<string, unknown>,
): Buffer {
  const digest = createHash('sha256')
    .update(JSON.stringify(state))
    .digest('hex');
  return Buffer.from(`${JSON.stringify({ v: 2, type, state, digest })}\n`);
}

export function parseManagedJournalSnapshot(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const state = record['state'];
  if (
    record['v'] !== 2 ||
    state === null ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    record['digest'] !==
      createHash('sha256').update(JSON.stringify(state)).digest('hex')
  ) {
    throw new Error('Journal snapshot version, state, or digest is invalid.');
  }
  return state as Record<string, unknown>;
}

export async function syncManagedJournalDirectory(
  filePath: string,
): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path.dirname(filePath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** The caller must stop writing if any step fails, including after rename. */
export async function replaceManagedJournalWithSnapshot(
  filePath: string,
  bytes: Buffer,
): Promise<void> {
  const pending = `${filePath}.snapshot.pending`;
  await rm(pending, { force: true });
  try {
    const handle = await open(pending, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pending, filePath);
    await syncManagedJournalDirectory(filePath);
  } finally {
    await rm(pending, { force: true });
  }
}
