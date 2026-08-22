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
import { join } from 'node:path';
import { isSameFile } from './same-file.js';

// Lets a test pose as a volume that exposes no inode numbers: statSync
// reports ino 0 while enabled, everything else delegates to the real thing.
const inoZeroVolume = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((filePath: string) => {
    const stats = actual.statSync(filePath);
    if (inoZeroVolume.enabled) stats.ino = 0;
    return stats;
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
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
    // Hard-link identity rides dev/ino; on volumes that expose no inode
    // numbers (ino 0) the comparison degrades to canonical spellings by
    // design and cannot see through a hard link.
    if (Number(statSync(original).ino) === 0) {
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
