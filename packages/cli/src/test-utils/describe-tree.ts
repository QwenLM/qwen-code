/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every entry under `root` with its bytes and identity (inode, modification
 * and change times), to prove a read leaves the tree exactly as it found it.
 */
export function describeTree(root: string): string[] {
  const lines: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const entryPath = path.join(directory, entry);
      const stats = fs.lstatSync(entryPath, { bigint: true });
      const identity = `${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`;
      if (stats.isDirectory()) {
        lines.push(`${path.relative(root, entryPath)}/ ${identity}`);
        walk(entryPath);
      } else {
        lines.push(
          `${path.relative(root, entryPath)} ${identity} ${
            stats.isFile() ? fs.readFileSync(entryPath, 'utf8') : 'link'
          }`,
        );
      }
    }
  };
  walk(root);
  return lines;
}
