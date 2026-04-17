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

export { AUTO_MEMORY_INDEX_FILENAME };
