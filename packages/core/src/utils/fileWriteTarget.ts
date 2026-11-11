/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { isNodeError } from './errors.js';

export class FileWriteContentChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileWriteContentChangedError';
  }
}

export class FileWriteTargetChangedError extends Error {
  constructor() {
    super('File target changed before writing. Read it again before retrying.');
  }
}

/** Resolve existing parents without creating a new path or following a new link later. */
export function resolveFileWritePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    // Dangling links must not silently become ordinary new-file targets.
    try {
      if (lstatSync(filePath).isSymbolicLink())
        throw new FileWriteTargetChangedError();
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'ENOENT') throw e;
    }
    const parent = dirname(filePath);
    if (parent === filePath) throw error;
    return resolve(resolveFileWritePath(parent), basename(filePath));
  }
}

export function pinFileWriteTarget(filePath: string, expectedPath: string) {
  const ioPath = resolveFileWritePath(filePath);
  if (ioPath !== expectedPath) throw new FileWriteTargetChangedError();
  const identity = () => {
    try {
      const s = statSync(ioPath);
      return `${s.dev}:${s.ino}`;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const original = identity();
  return {
    ioPath,
    recheckBeforeWrite() {
      if (resolveFileWritePath(filePath) !== ioPath || identity() !== original)
        throw new FileWriteTargetChangedError();
    },
  };
}

const writes = new Map<string, Promise<void>>();
/** Per-process path queue, independent of session-owned read records. */
export async function withFileWriteLock<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  write: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  const previous = writes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  writes.set(key, current);
  await previous;
  try {
    signal?.throwIfAborted();
    return await write();
  } finally {
    release();
    if (writes.get(key) === current) writes.delete(key);
  }
}
