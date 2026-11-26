/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { openNoFollow } from '../utils/no-follow-open.js';
import {
  rebuildProjectMemoryIndexLocked,
  recoverProjectMemoryIndex,
} from './indexer.js';
import { withProjectMemoryCommit } from './project-commit.js';
import {
  AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
  AUTO_MEMORY_INDEX_FILENAME,
  AUTO_MEMORY_METADATA_FILENAME,
  getAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
  getUserAutoMemoryIndexPath,
  getUserAutoMemoryRoot,
  type ProjectMemoryOwner,
} from './paths.js';
import { resolveTrustedMemoryRoot } from './trusted-memory-filesystem.js';
import {
  AUTO_MEMORY_SCHEMA_VERSION,
  type AutoMemoryExtractCursor,
  type AutoMemoryMetadata,
} from './types.js';

const debugLogger = createDebugLogger('AUTO_MEMORY_STORE');

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
  owner?: ProjectMemoryOwner,
): Promise<void> {
  const root = getAutoMemoryRoot(projectRoot, owner);
  const stateDir = path.dirname(root);
  await withProjectMemoryCommit(
    root,
    async () => {
      await fs.mkdir(root, { recursive: true });
      for (const [filePath, state] of [
        [
          path.join(stateDir, AUTO_MEMORY_METADATA_FILENAME),
          createDefaultAutoMemoryMetadata(now),
        ],
        [
          path.join(stateDir, AUTO_MEMORY_EXTRACT_CURSOR_FILENAME),
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
          await atomicWriteFile(
            filePath,
            `${JSON.stringify(state, null, 2)}\n`,
            {
              encoding: 'utf-8',
              noFollow: true,
            },
          );
        }
      }
      const indexExists = await fs
        .lstat(path.join(root, AUTO_MEMORY_INDEX_FILENAME))
        .then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return false;
          },
        );
      if (!indexExists) await rebuildProjectMemoryIndexLocked(root, owner);
    },
    owner,
  );
}

export async function readAutoMemoryIndex(
  projectRoot: string,
  owner?: ProjectMemoryOwner,
): Promise<string | null> {
  return (
    (await readAutoMemoryIndexWithStats(projectRoot, owner))?.content ?? null
  );
}

async function readMemoryIndexWithStats(
  indexPath: string,
  verifyRegularFile = false,
): Promise<AutoMemoryIndexRead | null> {
  try {
    const handle = await (verifyRegularFile
      ? openNoFollow(indexPath, { nonBlocking: true })
      : fs.open(indexPath, 'r'));
    try {
      const stats = await handle.stat();
      if (verifyRegularFile && !stats.isFile()) {
        throw new Error(
          `Project memory index requires a regular file: ${indexPath}`,
        );
      }
      const content = await handle.readFile('utf-8');
      return { content, stats };
    } finally {
      await handle.close();
    }
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
  owner?: ProjectMemoryOwner,
): Promise<AutoMemoryIndexRead | null> {
  const root = getAutoMemoryRoot(projectRoot, owner);
  const anchor = getMemoryRootTrustedAnchor(root, owner);
  await recoverProjectMemoryIndex(root, owner).catch((error: unknown) => {
    debugLogger.warn('Failed to repair the project memory index:', error);
  });
  const trustedRoot = await resolveTrustedMemoryRoot(root, anchor);
  return trustedRoot
    ? readMemoryIndexWithStats(
        path.join(trustedRoot, AUTO_MEMORY_INDEX_FILENAME),
        true,
      )
    : null;
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
