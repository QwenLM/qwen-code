/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { dirname } from 'node:path';

/**
 * Reads a configuration file without repairing anything. Returns `undefined`
 * only when the file is really absent: a dangling link on the path, a
 * non-regular file, a read failure or a file that changes while it is read
 * throws, so a caller never mistakes unreadable configuration for none.
 */
export function readConfigFile(filePath: string): string | undefined {
  let before: fs.Stats;
  try {
    before = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let ancestor = filePath;
    for (;;) {
      try {
        fs.lstatSync(ancestor);
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw entryError;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) throw entryError;
        ancestor = parent;
        continue;
      }
      // The closest existing entry must be a directory reached without a
      // dangling link; statting a dangling link throws.
      if (!fs.statSync(ancestor).isDirectory()) {
        throw error;
      }
      return undefined;
    }
  }
  if (!before.isFile()) {
    throw new Error('Configuration path is not a regular file.');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const after = fs.statSync(filePath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error('Configuration file changed while it was read.');
  }
  return content;
}
