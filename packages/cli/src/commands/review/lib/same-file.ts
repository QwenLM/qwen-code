/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// `tryStat` asks for `{ bigint: true }` so a 64-bit NTFS file index arrives
// EXACT rather than rounded at the JS boundary. With a number-backed
// `Stats`, an id above 2^53 loses precision — two distinct files can
// surface with an equal `ino` — which is why this comparison used to refuse
// such ids (via the shared `hasVerifiableInode` safe-integer predicate) and
// degrade to canonical spellings: a fail-open for hard-link aliases, which
// no spelling comparison can see through (#11848). Under bigint stats the
// id is exact end to end, so dev/ino decides whenever the volume reports an
// id at all. The shared predicate module is deliberately left untouched —
// its number-typed contract is still what the conversation-identity checks
// consume, and core's looser predicate (`Number(ino) !== 0`) stays as-is so
// `assertVerifiableTranscriptIdentity` does not flip on >2^53 Windows
// transcript inodes.
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
 * compare sees through, and statSync follows a symlinked directory
 * component on the way to the file. Stats are taken with `{ bigint: true }`,
 * so a 64-bit NTFS file index is exact and verifiable; the only
 * unverifiable case left is a volume reporting no id at all (`ino === 0`:
 * FAT/exFAT/SMB-style), where comparing ids would collapse unrelated files
 * onto one identity — there the comparison falls back to canonical
 * spellings, losing hard-link identity but never equating distinct files.
 * Where a side is absent, the deepest existing ancestor is canonicalised
 * instead, keeping the comparison honest for files a command is about to
 * create.
 */
export function isSameFile(left: string, right: string): boolean {
  if (left === right) return true;
  const leftStat = tryStat(left);
  const rightStat = tryStat(right);
  if (leftStat !== undefined && rightStat !== undefined) {
    if (leftStat.ino !== 0n && rightStat.ino !== 0n) {
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
