/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForkRecord } from './forkTranscript.js';

/**
 * Thrown by {@link writeFork} when the target session file already exists. The
 * exclusive (`wx`) create both asserts non-existence and opens for writing in
 * one syscall, so we never clobber an existing session — the route maps this to
 * a 500 (`fork_conflict`).
 */
export class ForkExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForkExistsError';
  }
}

/**
 * Reads + parses `<chatsDir>/<parentId>.jsonl`. Returns `null` (= "not
 * forkable") when the file is missing, empty, or yields zero valid records. A
 * single corrupt line is skipped, not fatal.
 */
export async function readParentRecords(
  chatsDir: string,
  parentId: string,
): Promise<ForkRecord[] | null> {
  let text: string;
  try {
    text = await readFile(join(chatsDir, `${parentId}.jsonl`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const records: ForkRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (obj && typeof obj === 'object') {
        records.push(obj as ForkRecord);
      }
    } catch {
      // Skip a corrupt line rather than failing the whole fork.
    }
  }
  return records.length > 0 ? records : null;
}

/**
 * Writes the forked transcript to `<chatsDir>/<newId>.jsonl` with an exclusive
 * create (`wx`, mode 0600): mkdir the chats dir first, then open exclusively so
 * an existing file surfaces as {@link ForkExistsError} instead of a clobber.
 */
export async function writeFork(
  chatsDir: string,
  newId: string,
  body: string,
): Promise<void> {
  await mkdir(chatsDir, { recursive: true });
  let handle;
  try {
    handle = await open(join(chatsDir, `${newId}.jsonl`), 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ForkExistsError(`Fork target already exists: ${newId}`);
    }
    throw err;
  }
  try {
    await handle.writeFile(body, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

/**
 * Best-effort unlink of `<chatsDir>/<newId>.jsonl`. Swallows all errors — used
 * to roll back a just-written fork when the daemon's `loadSession` rejects.
 */
export async function removeFork(
  chatsDir: string,
  newId: string,
): Promise<void> {
  try {
    await unlink(join(chatsDir, `${newId}.jsonl`));
  } catch {
    // Best-effort rollback; an absent file (or any error) is fine.
  }
}
