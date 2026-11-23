/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { rebuildProjectMemoryIndexLocked } from './indexer.js';
import {
  assertProjectMemoryCommit,
  withProjectMemoryCommit,
} from './project-commit.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getUserAutoMemoryIndexPath,
  getUserAutoMemoryRoot,
} from './paths.js';
import {
  AUTO_MEMORY_SCHEMA_VERSION,
  type AutoMemoryExtractCursor,
  type AutoMemoryMetadata,
} from './types.js';

export function createDefaultAutoMemoryMetadata(
  now = new Date(),
): AutoMemoryMetadata {
  const iso = now.toISOString();
  return {
    version: AUTO_MEMORY_SCHEMA_VERSION,
    createdAt: iso,
    updatedAt: iso,
  };
}

export function createDefaultAutoMemoryExtractCursor(
  now = new Date(),
): AutoMemoryExtractCursor {
  return {
    updatedAt: now.toISOString(),
  };
}

export function createDefaultAutoMemoryIndex(): string {
  return '';
}

export interface AutoMemoryIndexRead {
  content: string;
  stats: Stats;
}

async function writeFileIfMissing(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EEXIST') {
      throw error;
    }
  }
}

export async function ensureAutoMemoryScaffold(
  projectRoot: string,
  now = new Date(),
): Promise<void> {
  const root = getAutoMemoryRoot(projectRoot);
  await withProjectMemoryCommit(root, async () => {
    await fs.mkdir(root, { recursive: true });
    for (const [filePath, state] of [
      [
        getAutoMemoryMetadataPath(projectRoot),
        createDefaultAutoMemoryMetadata(now),
      ],
      [
        getAutoMemoryExtractCursorPath(projectRoot),
        createDefaultAutoMemoryExtractCursor(now),
      ],
    ] as const) {
      try {
        if (!(await fs.lstat(filePath)).isFile()) {
          throw new Error(
            `Project memory state requires a regular file: ${filePath}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await atomicWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: 'utf-8',
          noFollow: true,
          assertCanCommit: assertProjectMemoryCommit,
        });
      }
    }
    const indexExists = await fs
      .lstat(getAutoMemoryIndexPath(projectRoot))
      .then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        },
      );
    if (!indexExists) await rebuildProjectMemoryIndexLocked(root);
  });
}

export async function readAutoMemoryIndex(
  projectRoot: string,
): Promise<string | null> {
  try {
    return await fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readMemoryIndexWithStats(
  indexPath: string,
): Promise<AutoMemoryIndexRead | null> {
  try {
    const stats = await fs.stat(indexPath);
    const content = await fs.readFile(indexPath, 'utf-8');
    return { content, stats };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readAutoMemoryIndexWithStats(
  projectRoot: string,
): Promise<AutoMemoryIndexRead | null> {
  return readMemoryIndexWithStats(getAutoMemoryIndexPath(projectRoot));
}

/**
 * Ensure the user-level (cross-project) auto-memory dir + empty index exist.
 * Unlike the per-project scaffold, this does NOT seed meta.json or
 * extract-cursor.json — user memory has no per-project state to track.
 */
export async function ensureUserAutoMemoryScaffold(): Promise<void> {
  await fs.mkdir(getUserAutoMemoryRoot(), { recursive: true });
  await writeFileIfMissing(
    getUserAutoMemoryIndexPath(),
    createDefaultAutoMemoryIndex(),
  );
}

export async function readUserAutoMemoryIndex(): Promise<string | null> {
  try {
    return await fs.readFile(getUserAutoMemoryIndexPath(), 'utf-8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readUserAutoMemoryIndexWithStats(): Promise<AutoMemoryIndexRead | null> {
  return readMemoryIndexWithStats(getUserAutoMemoryIndexPath());
}

export { AUTO_MEMORY_INDEX_FILENAME };
