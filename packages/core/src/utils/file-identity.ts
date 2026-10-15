/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * True iff `ino` can be used as proof of file identity.
 *
 * FAT/exFAT and some SMB-style filesystems do not expose inode numbers, and
 * Node reports `Stats.ino === 0` for every file on them. Comparing or keying
 * by `dev:ino` there collapses unrelated files onto one identity, so callers
 * that rely on inode identity for a correctness or security decision must
 * treat zero as "unverifiable" rather than as a value that can match.
 *
 * `ino` is a `bigint` under `stat(..., { bigint: true })`, and `0n !== 0` is
 * `true` in JS, so the comparison goes through `Number` to cover both shapes.
 */
export function hasVerifiableInode(ino: number | bigint): boolean {
  return Number(ino) !== 0;
}
