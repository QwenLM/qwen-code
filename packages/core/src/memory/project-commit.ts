/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, lstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import {
  AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
} from './paths.js';
import type { AutoMemoryExtractCursor, AutoMemoryMetadata } from './types.js';

const pending = new Map<string, Promise<unknown>>();
const activeCommit = new AsyncLocalStorage<() => void>();

export function assertProjectMemoryCommit(): void {
  activeCommit.getStore()?.();
}

async function trustedStateDirectory(
  root: string,
  create: boolean,
): Promise<string> {
  const anchor = getMemoryRootTrustedAnchor(root);
  if (create) await fs.mkdir(anchor, { recursive: true });
  let directory = await fs.realpath(anchor);
  const parent = path.dirname(root);
  const relative = path.relative(anchor, parent);
  if (
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error('Project memory state is outside its runtime directory.');
  }
  for (const component of relative.split(path.sep).filter(Boolean)) {
    directory = path.join(directory, component);
    if (create) {
      await fs.mkdir(directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    }
    if (!(await fs.lstat(directory)).isDirectory()) {
      throw new Error(
        `Project memory state requires a real directory: ${directory}`,
      );
    }
  }
  return directory;
}

async function readState<T>(root: string, filename: string): Promise<T> {
  const directory = await trustedStateDirectory(root, false);
  const file = path.join(directory, filename);
  if (!(await fs.lstat(file)).isFile()) {
    throw new Error(`Project memory state requires a regular file: ${file}`);
  }
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Project memory state requires a regular file: ${file}`);
    }
    return JSON.parse(await handle.readFile('utf-8')) as T;
  } finally {
    await handle.close();
  }
}

export async function withProjectMemoryExtraction<T>(
  memoryRoot: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const target = path.join(
    await trustedStateDirectory(memoryRoot, true),
    `.${path.basename(memoryRoot)}-extraction`,
  );
  while (true) {
    signal?.throwIfAborted();
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(target, { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      await setTimeout(100, undefined, { signal });
      continue;
    }
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await release();
    }
  }
}

export async function withProjectMemoryCommit<T>(
  memoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeCommit.getStore()) {
    throw new Error('Project memory commit locks cannot be nested.');
  }
  const target = path.join(
    await trustedStateDirectory(memoryRoot, true),
    `.${path.basename(memoryRoot)}-commit`,
  );
  const previous = pending.get(target) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      let lost: Error | undefined;
      const release = await lockfile.lock(target, {
        realpath: false,
        retries: { retries: 120, minTimeout: 10, maxTimeout: 100 },
        onCompromised: (error) => {
          lost = error;
        },
      });
      const lockPath = `${target}.lock`;
      const original = lstatSync(lockPath, { bigint: true });
      const assertOwned = () => {
        if (lost) throw lost;
        const current = lstatSync(lockPath, {
          bigint: true,
          throwIfNoEntry: false,
        });
        if (
          !current?.isDirectory() ||
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          current.birthtimeNs !== original.birthtimeNs
        ) {
          lost = new Error(
            'Project memory commit lock changed before publication.',
          );
          throw lost;
        }
      };
      try {
        return await activeCommit.run(assertOwned, operation);
      } finally {
        // A stale holder must not try to remove the successor's lock directory.
        try {
          assertOwned();
        } catch (error) {
          lost = error as Error;
        }
        if (!lost) await release();
      }
    });
  pending.set(target, next);
  try {
    return await next;
  } finally {
    if (pending.get(target) === next) pending.delete(target);
  }
}

export async function readProjectMemoryCursor(
  memoryRoot: string,
): Promise<AutoMemoryExtractCursor | undefined> {
  try {
    return await readState<AutoMemoryExtractCursor>(
      memoryRoot,
      AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export function writeProjectMemoryCursorLocked(
  memoryRoot: string,
  cursor: AutoMemoryExtractCursor,
): Promise<void> {
  return atomicWriteFile(
    path.join(path.dirname(memoryRoot), AUTO_MEMORY_EXTRACT_CURSOR_FILENAME),
    `${JSON.stringify(cursor, null, 2)}\n`,
    {
      encoding: 'utf-8',
      noFollow: true,
      assertCanCommit: assertProjectMemoryCommit,
    },
  );
}

export async function updateProjectMemoryMetadata(
  projectRoot: string,
  now: Date,
  update: (metadata: AutoMemoryMetadata) => void,
): Promise<void> {
  await withProjectMemoryCommit(getAutoMemoryRoot(projectRoot), async () => {
    const filePath = getAutoMemoryMetadataPath(projectRoot);
    const metadata = await readProjectMemoryMetadata(projectRoot);
    update(metadata);
    const updatedAt = now.toISOString();
    if (updatedAt > metadata.updatedAt) metadata.updatedAt = updatedAt;
    await atomicWriteFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf-8',
      noFollow: true,
      assertCanCommit: assertProjectMemoryCommit,
    });
  });
}

export function readProjectMemoryMetadata(
  projectRoot: string,
): Promise<AutoMemoryMetadata> {
  return readState<AutoMemoryMetadata>(
    getAutoMemoryRoot(projectRoot),
    path.basename(getAutoMemoryMetadataPath(projectRoot)),
  );
}
