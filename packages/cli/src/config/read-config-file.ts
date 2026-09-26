/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { dirname } from 'node:path';

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
      // lstat of a missing child still follows links in its ancestors.
      const resolved = fs.statSync(ancestor);
      if (ancestor === filePath || !resolved.isDirectory()) throw error;
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
    throw new Error('Configuration file changed while reading.');
  }
  return content;
}
