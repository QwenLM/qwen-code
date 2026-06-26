/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getTeamAutoMemoryIndexPath,
  getUserAutoMemoryIndexPath,
  getUserAutoMemoryRoot,
} from './paths.js';
import {
  AUTO_MEMORY_SCHEMA_VERSION,
  type AutoMemoryExtractCursor,
  type AutoMemoryMetadata,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

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
  await fs.mkdir(root, { recursive: true });

  await writeFileIfMissing(
    getAutoMemoryIndexPath(projectRoot),
    createDefaultAutoMemoryIndex(),
  );
  await writeFileIfMissing(
    getAutoMemoryMetadataPath(projectRoot),
    JSON.stringify(createDefaultAutoMemoryMetadata(now), null, 2) + '\n',
  );
  await writeFileIfMissing(
    getAutoMemoryExtractCursorPath(projectRoot),
    JSON.stringify(createDefaultAutoMemoryExtractCursor(now), null, 2) + '\n',
  );
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

/**
 * Read the team (in-repo, git-tracked) memory index. The team directory is
 * created lazily on first write (the write tool mkdirs it), so a missing file
 * is normal and returns null.
 */
export async function readTeamAutoMemoryIndex(
  projectRoot: string,
): Promise<string | null> {
  try {
    return await fs.readFile(getTeamAutoMemoryIndexPath(projectRoot), 'utf-8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    // config.ts reads this via `.catch(() => null)`, so non-ENOENT errors
    // (EACCES/EIO/ELOOP) would otherwise vanish — log before re-throwing.
    debugLogger.debug(
      `Failed to read team auto-memory index (${nodeError.code ?? 'unknown'}): ${
        nodeError.path ?? getTeamAutoMemoryIndexPath(projectRoot)
      }`,
    );
    throw error;
  }
}

export { AUTO_MEMORY_INDEX_FILENAME };
