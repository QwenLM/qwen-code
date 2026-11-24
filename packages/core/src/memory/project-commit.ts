/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { openNoFollow } from '../utils/no-follow-open.js';
import { realpathNearestExisting } from '../utils/paths.js';
import {
  AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
  AUTO_MEMORY_METADATA_FILENAME,
  getAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
  type ProjectMemoryOwner,
} from './paths.js';
import type { AutoMemoryExtractCursor, AutoMemoryMetadata } from './types.js';

const pending = new Map<string, Promise<unknown>>();

async function trustedStateDirectory(
  root: string,
  create: boolean,
  owner?: ProjectMemoryOwner,
): Promise<string> {
  const anchor = getMemoryRootTrustedAnchor(root, owner);
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

async function readState<T>(
  root: string,
  filename: string,
  owner?: ProjectMemoryOwner,
): Promise<T> {
  const directory = await trustedStateDirectory(root, false, owner);
  const file = path.join(directory, filename);
  if (!(await fs.lstat(file)).isFile()) {
    throw new Error(`Project memory state requires a regular file: ${file}`);
  }
  const handle = await openNoFollow(file, { nonBlocking: true });
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Project memory state requires a regular file: ${file}`);
    }
    return JSON.parse(await handle.readFile('utf-8')) as T;
  } finally {
    await handle.close();
  }
}

export async function withProjectMemoryCommit<T>(
  memoryRoot: string,
  operation: () => Promise<T>,
  owner?: ProjectMemoryOwner,
): Promise<T> {
  const queueKey = getProjectMemoryQueueKey(memoryRoot);
  const previous = pending.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const target = path.join(
        await trustedStateDirectory(memoryRoot, true, owner),
        `.${path.basename(memoryRoot)}-commit`,
      );
      const release = await lockfile.lock(target, {
        realpath: false,
        retries: { retries: 120, minTimeout: 10, maxTimeout: 100 },
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  pending.set(queueKey, next);
  try {
    return await next;
  } finally {
    if (pending.get(queueKey) === next) pending.delete(queueKey);
  }
}

export function getProjectMemoryQueueKey(memoryRoot: string): string {
  return realpathNearestExisting(memoryRoot);
}

export async function readProjectMemoryCursor(
  memoryRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<AutoMemoryExtractCursor | undefined> {
  try {
    return await readState<AutoMemoryExtractCursor>(
      memoryRoot,
      AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
      owner,
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
    },
  );
}

export async function markProjectMemoryIndexPendingLocked(
  memoryRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<void> {
  const cursor = (await readProjectMemoryCursor(memoryRoot, owner)) ?? {
    updatedAt: new Date(0).toISOString(),
  };
  if (!cursor.projectIndexRebuildPending) {
    await writeProjectMemoryCursorLocked(memoryRoot, {
      ...cursor,
      projectIndexRebuildPending: true,
    });
  }
}

export async function updateProjectMemoryMetadata(
  projectRoot: string,
  now: Date,
  update: (metadata: AutoMemoryMetadata) => void,
  owner?: ProjectMemoryOwner,
): Promise<void> {
  const root = getAutoMemoryRoot(projectRoot, owner);
  await withProjectMemoryCommit(
    root,
    async () => {
      const filePath = path.join(
        path.dirname(root),
        AUTO_MEMORY_METADATA_FILENAME,
      );
      const metadata = await readState<AutoMemoryMetadata>(
        root,
        AUTO_MEMORY_METADATA_FILENAME,
        owner,
      );
      update(metadata);
      const updatedAt = now.toISOString();
      if (updatedAt > metadata.updatedAt) metadata.updatedAt = updatedAt;
      await atomicWriteFile(
        filePath,
        `${JSON.stringify(metadata, null, 2)}\n`,
        {
          encoding: 'utf-8',
          noFollow: true,
        },
      );
    },
    owner,
  );
}

export function readProjectMemoryMetadata(
  projectRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<AutoMemoryMetadata> {
  return readState<AutoMemoryMetadata>(
    getAutoMemoryRoot(projectRoot, owner),
    AUTO_MEMORY_METADATA_FILENAME,
    owner,
  );
}
