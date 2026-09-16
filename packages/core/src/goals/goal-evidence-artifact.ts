/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

interface FrozenFile {
  path: string;
  stat: Stats;
}

function unchanged(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Paths come only from recorded host metadata, never from tool output text. */
export class GoalEvidenceArtifact {
  private readonly files: FrozenFile[];
  readonly totalBytes: number;

  constructor(root: string, paths: readonly string[]) {
    const directory = realpathSync(root);
    if (paths.length === 0 || paths.length > 64)
      throw new Error('Invalid persisted evidence file count');
    this.files = [...new Set(paths)].map((path) => {
      const canonical = realpathSync(path);
      const local = relative(directory, canonical);
      if (
        !local ||
        isAbsolute(local) ||
        local === '..' ||
        local.startsWith(`..${sep}`)
      )
        throw new Error(
          'Persisted evidence is outside the project artifact directory',
        );
      const stat = statSync(canonical);
      if (!stat.isFile())
        throw new Error('Persisted evidence is not a regular file');
      return { path: canonical, stat };
    });
    this.totalBytes = this.files.reduce((sum, file) => sum + file.stat.size, 0);
  }

  assertUnchanged(): void {
    for (const file of this.files) {
      if (!unchanged(file.stat, statSync(file.path)))
        throw new Error(
          'Persisted evidence changed after the snapshot was frozen',
        );
    }
  }

  read(start: number, length: number): Buffer {
    const output = Buffer.alloc(Math.min(length, this.totalBytes - start));
    let offset = 0;
    let written = 0;
    for (const file of this.files) {
      const end = offset + file.stat.size;
      if (end > start && written < output.length) {
        const fd = openSync(file.path, 'r');
        try {
          if (!unchanged(file.stat, fstatSync(fd)))
            throw new Error(
              'Persisted evidence changed after the snapshot was frozen',
            );
          const position = Math.max(0, start - offset);
          const count = Math.min(
            file.stat.size - position,
            output.length - written,
          );
          let received = 0;
          while (received < count) {
            const bytes = readSync(
              fd,
              output,
              written + received,
              count - received,
              position + received,
            );
            if (!bytes)
              throw new Error(
                'Persisted evidence ended before its frozen length',
              );
            received += bytes;
          }
          if (!unchanged(file.stat, fstatSync(fd)))
            throw new Error('Persisted evidence changed while reading');
          written += received;
        } finally {
          closeSync(fd);
        }
      }
      offset = end;
    }
    this.assertUnchanged();
    return output;
  }
}
