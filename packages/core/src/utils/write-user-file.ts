/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { atomicWriteFile } from './atomicFileWrite.js';
import type { AtomicWriteFileOptions } from './atomicFileWrite.js';
import { isNodeError } from './errors.js';

export async function writeUserFile(
  filePath: string,
  data: string | Buffer,
  options?: Pick<AtomicWriteFileOptions, 'encoding' | 'assertCanCommit'>,
): Promise<void> {
  let stats: Stats | undefined;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  if (stats?.isFile()) {
    try {
      await fs.access(filePath, constants.W_OK);
    } catch (error) {
      // Windows access reports EPERM for a read-only file; writes use EACCES.
      if (
        process.platform === 'win32' &&
        isNodeError(error) &&
        error.code === 'EPERM'
      ) {
        throw Object.assign(
          new Error(`EACCES: permission denied, access '${filePath}'`),
          { code: 'EACCES', path: filePath, syscall: 'access' },
        );
      }
      throw error;
    }

    // Replacing this name would split the links. All aliases, including those
    // outside the workspace, must keep sharing the new content.
    if (stats.nlink > 1) {
      options?.assertCanCommit?.();
      await fs.writeFile(filePath, data, {
        encoding: options?.encoding ?? 'utf-8',
        flush: true,
      });
      return;
    }
  }

  await atomicWriteFile(filePath, data, options);
}
