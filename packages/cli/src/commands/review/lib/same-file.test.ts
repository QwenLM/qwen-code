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
import { inodesVerifiable } from './test-utils.js';

// Lets a test pose as a volume that exposes no inode numbers: statSync
// reports ino 0 while enabled, everything else delegates to the real thing.
const inoZeroVolume = vi.hoisted(() => ({ enabled: false }));
// Lets a test pose as a Windows NTFS volume whose 64-bit file indices
// exceed the safe-integer range: a registered path stats with that EXACT id
// under `{ bigint: true }` and with its rounded double under a number
// stat — the two shapes one volume shows a bigint caller and a number
// caller. Keyed by the post-alias path, so a case-variant spelling inherits
// the id of the file it names.
const exactInodeVolume = vi.hoisted(() => ({
  byPath: new Map<string, bigint>(),
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
  const wantsBigint = (opts: unknown): boolean =>
    typeof opts === 'object' &&
    opts !== null &&
    (opts as { bigint?: boolean }).bigint === true;
  const statSync = ((filePath: string, options?: unknown) => {
    const resolved = resolveAlias(String(filePath));
    const forced = exactInodeVolume.byPath.get(resolved);
    if (wantsBigint(options)) {
      const stats = actual.statSync(resolved, { bigint: true });
      if (inoZeroVolume.enabled) stats.ino = 0n;
      else if (forced !== undefined) stats.ino = forced;
      return stats;
    }
    const stats = actual.statSync(resolved);
    if (inoZeroVolume.enabled) stats.ino = 0;
    else if (forced !== undefined) stats.ino = Number(forced);
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
    // Hard-link identity rides dev/ino, so this test is meaningful only
    // where the volume exposes inode numbers at all; the ino-0 fallback is
    // pinned by 'decides by canonical spelling when inodes are
    // unverifiable' below. A 64-bit NTFS file index above 2^53 is NOT a skip
    // case: bigint stats carry it exactly (#11848), and 'equates hard-linked
    // names through an exact inode above the safe-integer range' pins that.
    if (!inodesVerifiable(statSync, original)) {
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

  it('equates hard-linked names through an exact inode above the safe-integer range', () => {
    // NTFS file ids are 64-bit: a number-backed Stats rounds them at the JS
    // boundary, which used to withhold verifiability and degrade the
    // comparison to canonical spellings — a fallback that can never see
    // through a hard link, whose two names realpath to themselves. The alias
    // guards consuming this predicate failed open there (#11848). Bigint
    // stats carry the id exactly, so two names for one inode are one file
    // again. This goes red against the number-stat implementation: the mock
    // reports the rounded double there, the strict number predicate refuses
    // it, and the fallback answers false.
    const original = join(dir, 'original.json');
    const linked = join(dir, 'linked.json');
    writeFileSync(original, '{}');
    linkSync(original, linked);
    // Above 2^53, so the number shape of this id is not a safe integer; pin
    // that or the fixture could silently stop exercising the defect.
    const exact = 2n ** 60n + 12345n;
    expect(Number.isSafeInteger(Number(exact))).toBe(false);
    exactInodeVolume.byPath.set(original, exact);
    exactInodeVolume.byPath.set(linked, exact);
    try {
      expect(isSameFile(original, linked)).toBe(true);
      expect(isSameFile(linked, original)).toBe(true);
    } finally {
      exactInodeVolume.byPath.clear();
    }
  });

  it('keeps distinct files distinct through exact inodes one rounding bucket apart', () => {
    // 2^60+1 and 2^60+2 collapse to the same double but are distinct NTFS
    // file ids; exact bigint comparison must keep the two files apart.
    const left = join(dir, 'bucket-left.json');
    const right = join(dir, 'bucket-right.json');
    writeFileSync(left, '{}');
    writeFileSync(right, '{}');
    const leftIno = 2n ** 60n + 1n;
    const rightIno = 2n ** 60n + 2n;
    // Fixture guard: the case rests on the two ids sharing one double while
    // staying distinct as bigints.
    expect(Number(leftIno)).toBe(Number(rightIno));
    exactInodeVolume.byPath.set(left, leftIno);
    exactInodeVolume.byPath.set(right, rightIno);
    try {
      expect(isSameFile(left, right)).toBe(false);
      expect(isSameFile(right, left)).toBe(false);
    } finally {
      exactInodeVolume.byPath.clear();
    }
  });

  it('equates case-variant spellings through their shared exact inode', () => {
    // The exact-id regime must not over-refuse either: two spellings of ONE
    // file stat the same file, so dev/ino identity equates them without the
    // canonical-spelling fallback ever being consulted.
    const real = join(dir, 'Exact.md');
    writeFileSync(real, '{}');
    const variant = join(dir, 'exact.md');
    caseInsensitiveVolume.aliases.set(variant, real);
    exactInodeVolume.byPath.set(real, 2n ** 60n);
    try {
      expect(isSameFile(real, variant)).toBe(true);
      expect(isSameFile(variant, real)).toBe(true);
    } finally {
      exactInodeVolume.byPath.clear();
      caseInsensitiveVolume.aliases.clear();
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
