/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../../utils/errors.js';

export interface TranscriptPathFileSystem {
  realpath(filePath: string): Promise<string>;
}

const nodePathFileSystem: TranscriptPathFileSystem = {
  realpath: (filePath) => fs.realpath(filePath),
};

/**
 * Produces one path key for existing files, symlink aliases and files whose
 * final path components do not exist yet.
 */
export async function canonicalizeTranscriptPath(
  filePath: string,
  fileSystem: TranscriptPathFileSystem = nodePathFileSystem,
): Promise<string> {
  const absolutePath = path.resolve(filePath);
  try {
    return await fileSystem.realpath(absolutePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const missingSegments: string[] = [];
  let existingAncestor = absolutePath;
  while (true) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      return absolutePath;
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
    try {
      const canonicalAncestor = await fileSystem.realpath(existingAncestor);
      return path.join(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
