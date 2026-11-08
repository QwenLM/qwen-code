/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isSameFile } from './same-file.js';

// Lets a test pose as a volume that exposes no inode numbers: statSync
// reports ino 0 while enabled, everything else delegates to the real thing.
const inoZeroVolume = vi.hoisted(() => ({ enabled: false }));
// Lets a test pose as a volume whose 64-bit file ids exceed the JS
// safe-integer range (NTFS): while set, every stat reports the id the pose
// returns — a constant, or a function of the path and the path's REAL id, so
// a test can lift genuine ids above 2^60 and keep a hard-linked pair sharing
// one id while unrelated files stay distinct — as a bigint when the caller
// asks for bigint stats, and as the rounded (unsafe) double a number-backed
// `Stats` would carry. Only `ino` is posed: `dev` stays the real stat's, so
// the inode comparison below is what decides.
const bigInodeVolume = vi.hoisted(() => ({
  inode: undefined as
    | bigint
    | ((filePath: string, realInode: bigint) => bigint)
    | undefined,
}));
// Lets a test pose as a case-insensitive volume (FAT/exFAT/SMB): every
// registered case-variant spelling stats and canonicalises as the file it
// names. The NATIVE canonicaliser reports the on-disk spelling — that is
// what GetFinalPathNameByHandleW does on Windows — while the JS walker
// echoes the caller's own spelling back.
const caseInsensitiveVolume = vi.hoisted(() => ({
  aliases: new Map<string, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const resolveAlias = (filePath: string): string =>
    caseInsensitiveVolume.aliases.get(filePath) ?? filePath;
  // Forward the stat options through (precedent: no-follow-open.test.ts,
  // session-writer-lease.test.ts): production stats with `{ bigint: true }`,
  // and a mock that dropped the options bag would hand back a number-backed
  // `Stats` — posing the unsafe-rounding case even when the code under test
  // asked for the exact id, and letting the bigint cases below pass without
  // exercising the path they name.
  const statSync = ((filePath: string, options?: { bigint?: boolean }) => {
    const bigint = options?.bigint === true;
    const stats = actual.statSync(resolveAlias(String(filePath)), { bigint });
    const posed = stats as { ino: number | bigint };
    if (inoZeroVolume.enabled) {
      posed.ino = bigint ? 0n : 0;
    } else if (bigInodeVolume.inode !== undefined) {
      const pose = bigInodeVolume.inode;
      const inode =
        typeof pose === 'function'
          ? pose(String(filePath), BigInt(stats.ino))
          : pose;
      posed.ino = bigint ? inode : Number(inode);
    }
    return stats;
  }) as typeof actual.statSync;
  const realpathSync = Object.assign(
    (filePath: Parameters<typeof actual.realpathSync>[0]) => {
      const caller = String(filePath);
      const resolved = actual.realpathSync(resolveAlias(caller));
      return caseInsensitiveVolume.aliases.has(caller)
        ? join(dirname(resolved), basename(caller))
        : resolved;
    },
    {
      native: (filePath: Parameters<typeof actual.realpathSync>[0]) =>
        actual.realpathSync(resolveAlias(String(filePath))),
    },
  ) as unknown as typeof actual.realpathSync;
  return {
    ...actual,
    statSync,
    realpathSync,
    default: { ...actual, statSync, realpathSync },
  };
});

describe('isSameFile', () => {
  let dir: string;

  beforeEach(() => {
    // realpath, so the spellings compared below are physical ones, the same
    // space the helper computes in.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'same-file-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats two hard links to one file as the same file', (ctx) => {
    const original = join(dir, 'original.json');
    writeFileSync(original, '{}');
    const linked = join(dir, 'linked.json');
    linkSync(original, linked);
    // Hard-link identity rides dev/ino, so this test needs a volume that
    // exposes an id at all. `tryStat` stats with `{ bigint: true }` (the
    // #11848 conversion), so a 64-bit NTFS file index above 2^53 arrives
    // exact and the dev/ino comparison decides there too — the gate below
    // covers the ino === 0 case alone (FAT/exFAT/SMB), where degrading to
    // canonical spellings is BY DESIGN, pinned by 'decides by canonical
    // spelling when inodes are unverifiable' below.
    const inode = statSync(original).ino;
    if (inode <= 0) {
      ctx.skip();
      return;
    }
    expect(isSameFile(original, linked)).toBe(true);
    expect(isSameFile(linked, original)).toBe(true);
  });

  it('decides by canonical spelling when inodes are unverifiable', () => {
    // FAT/exFAT-style volumes report ino 0 for every file; the comparison
    // must fall back to canonical spellings there — never equating distinct
    // files through a shared zero, never missing two spellings of one path.
    const left = join(dir, 'ino-left.json');
    const right = join(dir, 'ino-right.json');
    writeFileSync(left, '{}');
    writeFileSync(right, '{}');
    mkdirSync(join(dir, 'ino-real'));
    writeFileSync(join(dir, 'ino-real', 'aliased.json'), '{}');
    symlinkSync(join(dir, 'ino-real'), join(dir, 'ino-link'));
    const aliased = join(dir, 'ino-real', 'aliased.json');
    const throughLink = join(dir, 'ino-link', 'aliased.json');
    inoZeroVolume.enabled = true;
    try {
      expect(isSameFile(left, right)).toBe(false);
      expect(isSameFile(aliased, throughLink)).toBe(true);
      expect(isSameFile(throughLink, aliased)).toBe(true);
    } finally {
      inoZeroVolume.enabled = false;
    }
  });

  it('equates case-variant spellings when inodes are unverifiable', () => {
    // FAT/exFAT/SMB volumes are case-insensitive AND report ino 0 for every
    // file, so both spellings of one file stat there. The fallback must
    // compare through the canonicaliser that folds case (realpathSync.native
    // — GetFinalPathNameByHandleW on Windows), not the JS walker that echoes
    // the caller's spelling: a false `false` silently disables the
    // anti-clobber guards that consume this predicate.
    const real = join(dir, 'Report.md');
    writeFileSync(real, '{}');
    const variant = join(dir, 'report.md');
    caseInsensitiveVolume.aliases.set(variant, real);
    inoZeroVolume.enabled = true;
    try {
      expect(isSameFile(real, variant)).toBe(true);
      expect(isSameFile(variant, real)).toBe(true);
      // Two genuinely distinct files stay distinct under the same pose.
      const other = join(dir, 'other.md');
      writeFileSync(other, '{}');
      expect(isSameFile(real, other)).toBe(false);
    } finally {
      inoZeroVolume.enabled = false;
      caseInsensitiveVolume.aliases.clear();
    }
  });

  it('keeps distinct files distinct above the safe-integer range', () => {
    // 2^60+1 and 2^60+2 are distinct 64-bit NTFS file ids that round to the
    // same double. A number-backed `Stats` cannot tell this pair apart —
    // which is exactly why the comparison used to refuse unsafe inodes and
    // degrade to canonical spellings. With bigint stats the ids are exact,
    // and dev/ino alone decides: distinct files stay distinct.
    const left = join(dir, 'unsafe-left.json');
    const right = join(dir, 'unsafe-right.json');
    writeFileSync(left, '{}');
    writeFileSync(right, '{}');
    bigInodeVolume.inode = (filePath) =>
      filePath.endsWith('unsafe-left.json') ? 2n ** 60n + 1n : 2n ** 60n + 2n;
    try {
      expect(isSameFile(left, right)).toBe(false);
      expect(isSameFile(right, left)).toBe(false);
    } finally {
      bigInodeVolume.inode = undefined;
    }
  });

  it('detects hard-link identity through an exact inode above the safe-integer range', () => {
    // The #11848 acceptance case: on a volume whose 64-bit file ids exceed
    // 2^53 (NTFS), two names of ONE inode must compare as one file.
    // Number-backed stats rounded the id into the unsafe range, the
    // comparison degraded to canonical spellings, and a hard link — two
    // names, two spellings — was never seen through: the alias guards
    // consuming this verdict (findings, repo-context, save-artifact) failed
    // open. Bigint stats keep the id exact, so dev/ino decides and the
    // canonical-spelling fallback is reserved for volumes reporting no id
    // at all.
    //
    // The pose LIFTS each path's real id above 2^60 rather than reporting a
    // constant, the shape `standalone-deletion-journal.test.ts` uses: the
    // hard-linked pair keeps sharing one id and the unrelated file below
    // keeps a different one, so the `toBe(true)` half fails if the
    // comparator degrades to spellings again (the pre-fix shape) and the
    // `toBe(false)` half fails if `{ bigint: true }` is dropped from
    // `tryStat` — under a number-backed `Stats` the lifted ids round into
    // one double and every pair on the volume would compare equal. A
    // constant pose passes both halves for the wrong reason: it equates
    // unrelated files too, so the hard link it creates is not load-bearing.
    const original = join(dir, 'original.json');
    writeFileSync(original, '{}');
    const linked = join(dir, 'linked.json');
    linkSync(original, linked);
    const unrelated = join(dir, 'unrelated.json');
    writeFileSync(unrelated, '{}');
    bigInodeVolume.inode = (_filePath, realInode) => 2n ** 60n + realInode;
    try {
      expect(isSameFile(original, linked)).toBe(true);
      expect(isSameFile(linked, original)).toBe(true);
      expect(isSameFile(original, unrelated)).toBe(false);
      expect(isSameFile(unrelated, linked)).toBe(false);
    } finally {
      bigInodeVolume.inode = undefined;
    }
  });

  it('treats two distinct files as different files', () => {
    const left = join(dir, 'left.json');
    const right = join(dir, 'right.json');
    writeFileSync(left, '{}');
    writeFileSync(right, '{}');
    expect(isSameFile(left, right)).toBe(false);
  });

  it('compares an existing side against an absent one by canonical spelling', () => {
    const present = join(dir, 'present.json');
    writeFileSync(present, '{}');
    expect(isSameFile(present, join(dir, 'absent.json'))).toBe(false);
    expect(isSameFile(join(dir, 'absent.json'), present)).toBe(false);
  });

  it('compares absent paths by their canonical spelling', () => {
    // Neither side has an inode yet; identity is the canonicalised deepest
    // existing ancestor with the missing tail re-appended.
    expect(isSameFile(join(dir, 'a.json'), join(dir, 'a.json'))).toBe(true);
    expect(isSameFile(join(dir, 'a.json'), join(dir, 'b.json'))).toBe(false);
  });

  it('walks up two or more missing components to canonicalise an absent path', () => {
    // The walk-up's verdict matters only when the aliasing sits in a
    // directory component below the deepest existing ancestor: `link` and
    // `real` name one directory, and `a/b/f.json` is missing on both sides.
    // A climb that stops at the first missing component returns the raw
    // spellings and turns this false — the exact mutant the guard's own
    // tests cannot see, because they place collisions one level below an
    // existing directory.
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const throughLink = join(dir, 'link/a/b/f.json');
    const throughReal = join(dir, 'real/a/b/f.json');
    expect(isSameFile(throughLink, throughReal)).toBe(true);
    expect(isSameFile(throughReal, throughLink)).toBe(true);
    // Same absent chain, different tail — still two different files.
    expect(isSameFile(throughLink, join(dir, 'real/a/b/other.json'))).toBe(
      false,
    );
  });
});
