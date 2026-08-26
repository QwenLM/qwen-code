/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hasVerifiableInode } from '@qwen-code/qwen-code-core';

function tryStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

// A path that does not exist yet has no inode; its identity is the canonical
// spelling of the deepest ancestor that does exist with the missing tail
// re-appended, so a symlinked directory component is normalised away before
// the file is created.
function identityOfAbsent(path: string): string {
  const missing: string[] = [basename(path)];
  let current = dirname(path);
  for (;;) {
    try {
      let identity = realpathSync(current);
      for (let i = missing.length - 1; i >= 0; i--) {
        identity = join(identity, missing[i]);
      }
      return identity;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * True when two paths name the same file. Where both exist and the
 * filesystem exposes verifiable inode numbers, filesystem identity (dev/ino)
 * decides: hard links and case-variant spellings are one file under names no
 * string compare sees through, and statSync follows a symlinked directory
 * component on the way to the file. Where inodes are unverifiable
 * (`hasVerifiableInode`: FAT/exFAT-style volumes reporting `ino === 0`),
 * dev/ino would collapse unrelated files onto one identity, so the
 * comparison falls back to canonical spellings — losing hard-link identity
 * there, but never equating distinct files. Where a side is absent, the
 * deepest existing ancestor is canonicalised instead, keeping the comparison
 * honest for files a command is about to create.
 */
export function isSameFile(left: string, right: string): boolean {
  if (left === right) return true;
  const leftStat = tryStat(left);
  const rightStat = tryStat(right);
  if (leftStat !== undefined && rightStat !== undefined) {
    if (hasVerifiableInode(leftStat.ino) && hasVerifiableInode(rightStat.ino)) {
      return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
    }
    // realpathSync.native canonicalises case the way the volume does
    // (GetFinalPathNameByHandleW on Windows); the JS walker echoes the
    // caller's spelling — and every volume that reports ino 0 is
    // case-insensitive, so the walker is wrong exactly where this branch
    // fires.
    return realpathSync.native(left) === realpathSync.native(right);
  }
  const leftIdentity =
    leftStat !== undefined ? realpathSync(left) : identityOfAbsent(left);
  const rightIdentity =
    rightStat !== undefined ? realpathSync(right) : identityOfAbsent(right);
  return leftIdentity === rightIdentity;
}
