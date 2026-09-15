/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hasVerifiableInode } from '@qwen-code/qwen-code-core/utils/file-identity.js';

// Stats are read with `{ bigint: true }` so the 64-bit NTFS file index
// arrives EXACTLY. A number-backed `Stats` rounds it at the JS boundary, and
// the strict number predicate in conversation-directory-identity.ts
// (`Number.isSafeInteger(ino) && ino > 0`) then withholds verifiability from
// every id above 2^53 — degrading this comparator to canonical spellings on
// exactly the volumes where hard links must be seen through (#11848). With
// exact bigints the only unverifiable case left is a zero ino (FAT/exFAT and
// some SMB mounts), which keeps the canonical-spelling fallback below. The
// gate is core's canonical `hasVerifiableInode`, already typed
// `(ino: number | bigint)` — the strict CLI predicate keeps its
// `(ino: number)` signature for its number-backed consumers and is not
// widened for this comparator (#11848's "conversions stay local"
// constraint).

function tryStat(path: string): BigIntStats | undefined {
  try {
    return statSync(path, { bigint: true });
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
 * filesystem exposes inode numbers, filesystem identity (dev/ino) decides:
 * hard links and case-variant spellings are one file under names no string
 * compare sees through, and statSync follows a symlinked directory component
 * on the way to the file. The stats are read as bigints, so a 64-bit NTFS
 * file index is compared exactly rather than after double-rounding. Where
 * inodes are unverifiable (FAT/exFAT/SMB-style volumes reporting `ino ===
 * 0n`), dev/ino would collapse unrelated files onto one identity, so the
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
