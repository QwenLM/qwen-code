/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The pure halves of the local anchor. The cache is model-written prose-gated
// JSON, so `readLocalCache` is an untrusted-input boundary (malformed → null,
// never a throw and never a skip), and the byte slicer is pinned against the
// re-encode hazard: it must reproduce the exact bytes of the sections it keeps.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  UNHASHABLE,
  changedSince,
  isPathProvablyAbsent,
  readLocalCache,
  stateIdOf,
} from './local-anchor.js';
import { sliceDiffByLines } from './diff-plan.js';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Spy-mode interception so the Windows-shaped arms below can force the leaf
// lstat verdict; everything else delegates to the real implementation.
vi.mock('node:fs', { spy: true });

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

describe('stateIdOf', () => {
  it('is order-independent over files and sensitive to every field', () => {
    const a = stateIdOf('head1', { 'a.ts': 'h1', 'b.ts': 'h2' });
    expect(stateIdOf('head1', { 'b.ts': 'h2', 'a.ts': 'h1' })).toBe(a);
    expect(stateIdOf('head2', { 'a.ts': 'h1', 'b.ts': 'h2' })).not.toBe(a);
    expect(stateIdOf('head1', { 'a.ts': 'hX', 'b.ts': 'h2' })).not.toBe(a);
    expect(stateIdOf(null, { 'a.ts': 'h1', 'b.ts': 'h2' })).not.toBe(a);
  });

  it('field separators prevent adjacency collisions', () => {
    expect(stateIdOf('h', { ab: 'c' })).not.toBe(stateIdOf('h', { a: 'bc' }));
  });
});

describe('changedSince', () => {
  it('reports modified, added, and removed paths — nothing else', () => {
    const changed = changedSince(
      { 'same.ts': 'h1', 'mod.ts': 'h2', 'gone.ts': 'h3' },
      { 'same.ts': 'h1', 'mod.ts': 'hX', 'new.ts': 'h4' },
    );
    expect(changed.sort()).toEqual(['gone.ts', 'mod.ts', 'new.ts']);
  });

  it('UNHASHABLE never compares equal — not even to itself', () => {
    // "Could not capture it twice" is not "unchanged": a submodule pointer,
    // a mangled filename, an unreadable file all re-enter scope every round.
    expect(changedSince({ sub: UNHASHABLE }, { sub: UNHASHABLE })).toEqual([
      'sub',
    ]);
  });

  it('a legacy string identity still compares as an ordinary stable value', () => {
    // Older caches may carry values no current producer emits ('absent',
    // bare oids); they compare as opaque strings — equal is equal.
    expect(
      changedSince({ 'del.ts': 'absent' }, { 'del.ts': 'absent' }),
    ).toEqual([]);
  });

  it('prototype-member names behave as ordinary keys in the comparison', () => {
    expect(changedSince({ toString: 'h1' }, { toString: 'h1' })).toEqual([]);
    expect(changedSince({ toString: 'h1' }, {})).toEqual(['toString']);
  });
});

describe('readLocalCache', () => {
  const write = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'local-anchor-'));
    const p = join(dir, 'cache.json');
    writeFileSync(p, content);
    return p;
  };

  it('round-trips a valid cache, optional lastModelId included', () => {
    const cache = {
      v: 1,
      target: 'local',
      headSha: 'abc',
      files: { 'a.ts': 'h1' },
      stateId: 's1',
      lastModelId: 'm1',
      round: 2, // model-written extras must not fail validation
    };
    const p = write(JSON.stringify(cache));
    const parsed = readLocalCache(p)!;
    expect(parsed.files).toEqual({ 'a.ts': 'h1' });
    expect(parsed.lastModelId).toBe('m1');
    expect(parsed.headSha).toBe('abc');
    rmSync(join(p, '..'), { recursive: true, force: true });
  });

  it('null on every malformation — absent file, bad JSON, wrong shapes', () => {
    expect(readLocalCache('/no/such/file.json')).toBeNull();
    for (const bad of [
      'null', // JSON.parse succeeds; the object guard must still refuse
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: null,
        files: {},
        stateId: 5,
      }),
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: null,
        files: 'x',
        stateId: 's',
      }),
      'not json',
      JSON.stringify({
        v: 2,
        target: 't',
        headSha: null,
        files: {},
        stateId: 's',
      }),
      JSON.stringify({ v: 1, headSha: null, files: {}, stateId: 's' }),
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: 5,
        files: {},
        stateId: 's',
      }),
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: null,
        files: { a: 5 },
        stateId: 's',
      }),
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: null,
        files: null,
        stateId: 's',
      }),
      // typeof [] === 'object': an array-shaped map must refuse, not pass
      // with index-string keys.
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: null,
        files: ['blob-a'],
        stateId: 's',
      }),
    ]) {
      const p = write(bad);
      expect(readLocalCache(p)).toBeNull();
      rmSync(join(p, '..'), { recursive: true, force: true });
    }
  });
});

describe('sliceDiffByLines', () => {
  it('keeps exact bytes of the kept ranges, in line order', () => {
    const diff = Buffer.from('l1\nl2\nl3\nl4\nl5\n', 'utf8');
    const out = sliceDiffByLines(diff, [
      { startLine: 4, endLine: 5 },
      { startLine: 1, endLine: 2 },
    ]);
    expect(out.toString('utf8')).toBe('l1\nl2\nl4\nl5\n');
  });

  it('does not re-encode: non-UTF-8 bytes survive verbatim', () => {
    // 0x80 alone is invalid UTF-8; a decode/re-encode would replace it.
    const diff = Buffer.concat([
      Buffer.from('keep '),
      Buffer.from([0x80, 0x81]),
      Buffer.from('\ndrop\n'),
    ]);
    const out = sliceDiffByLines(diff, [{ startLine: 1, endLine: 1 }]);
    expect([...out.subarray(5, 7)]).toEqual([0x80, 0x81]);
    expect(out.toString('latin1')).not.toContain('drop');
  });

  it('preserves lone \\r bytes — the CRLF-normalising idiom must never touch this path', () => {
    // All three text wrappers in lib/git.ts apply `.replace(/\\r\\n/g, '\\n')`;
    // a regression routing the slice through one of them rewrites every hunk
    // touching a CRLF file.
    const diff = Buffer.from('a\r\nb\nkeep\r\n', 'utf8');
    const out = sliceDiffByLines(diff, [{ startLine: 1, endLine: 3 }]);
    expect([...out]).toEqual([...diff]);
  });

  it('a range past the last line clamps to the buffer end', () => {
    const diff = Buffer.from('a\nb', 'utf8'); // no trailing newline
    expect(
      sliceDiffByLines(diff, [{ startLine: 2, endLine: 9 }]).toString('utf8'),
    ).toBe('b');
  });
});

describe('isPathProvablyAbsent', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'local-anchor-absent-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('treats ENOENT under an existing directory as genuine absence', () => {
    mkdirSync(join(repo, 'src'));
    expect(isPathProvablyAbsent(repo, join('src', 'missing.ts'))).toBe(true);
  });

  it('keeps an existing path present', () => {
    writeFileSync(join(repo, 'present.ts'), 'x\n');
    expect(isPathProvablyAbsent(repo, 'present.ts')).toBe(false);
  });

  it('refuses absence under a regular-file component — unmeasurable, not absent', () => {
    // POSIX raises ENOTDIR for the leaf; Windows raises ENOENT and the
    // ancestor walk finds the regular FILE as nearest existing ancestor.
    // Either way the answer is false (R19-2: only ENOENT-proven absence may
    // exempt a flagged path).
    writeFileSync(join(repo, 'f'), 'a regular file, not a directory\n');
    expect(isPathProvablyAbsent(repo, join('f', 'missing.ts'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'a symlink-to-directory ancestor still proves absence',
    () => {
      mkdirSync(join(repo, 'target'));
      symlinkSync(join(repo, 'target'), join(repo, 'link'));
      expect(isPathProvablyAbsent(repo, join('link', 'missing.ts'))).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a broken symlink ancestor is walked past, not mistaken for a file',
    () => {
      symlinkSync(join(repo, 'nowhere'), join(repo, 'broken'));
      expect(isPathProvablyAbsent(repo, join('broken', 'missing.ts'))).toBe(
        true,
      );
    },
  );

  // Platform-independent arms of the Windows-shaped walk. On POSIX a leaf
  // under a regular-file component raises ENOTDIR and exits BEFORE the
  // ancestor walk, so only a spied lstatSync can force the ENOENT leaf
  // shape Windows reports for that same path — the exact shape a future
  // "leaf ENOENT ⇒ absent" simplification would restore while every
  // real-fs test on every POSIX lane stays green (the R19-3 incident).
  const errno = (code: string) => Object.assign(new Error(code), { code });

  const withLeafErrno = (leaf: string, code: string, run: () => void) => {
    vi.mocked(lstatSync).mockImplementation(((p: PathLike) => {
      if (p === leaf) throw errno(code);
      return realFs.lstatSync(p);
    }) as unknown as typeof lstatSync);
    try {
      run();
    } finally {
      vi.mocked(lstatSync).mockRestore();
    }
  };

  it('Windows shape: an ENOENT leaf below a regular-file ancestor stays unmeasurable', () => {
    writeFileSync(join(repo, 'f'), 'a regular file, not a directory\n');
    const leaf = join(repo, 'f', 'missing.ts');
    withLeafErrno(leaf, 'ENOENT', () => {
      expect(isPathProvablyAbsent(repo, join('f', 'missing.ts'))).toBe(false);
    });
  });

  it('Windows shape: an ENOENT leaf below a directory ancestor is genuine absence', () => {
    mkdirSync(join(repo, 'src'));
    const leaf = join(repo, 'src', 'missing.ts');
    withLeafErrno(leaf, 'ENOENT', () => {
      expect(isPathProvablyAbsent(repo, join('src', 'missing.ts'))).toBe(true);
    });
  });

  it('a non-ENOENT leaf error is never absence', () => {
    writeFileSync(join(repo, 'locked.ts'), 'x\n');
    const leaf = join(repo, 'locked.ts');
    withLeafErrno(leaf, 'EACCES', () => {
      expect(isPathProvablyAbsent(repo, 'locked.ts')).toBe(false);
    });
  });

  // R1-6: one enumeration shares its ancestor probes.
  it('probes a shared missing ancestor chain once, not once per path', () => {
    // The whole `a/` subtree is unmaterialized, as out-of-cone paths are in
    // a sparse checkout: without the shared memo, every path re-walks the
    // same missing chain all the way to the repo root.
    const memo = new Map<string, boolean>();
    vi.mocked(statSync).mockClear();
    expect(isPathProvablyAbsent(repo, join('a', 'b', 'x.ts'), memo)).toBe(true);
    expect(isPathProvablyAbsent(repo, join('a', 'b', 'y.ts'), memo)).toBe(true);
    expect(isPathProvablyAbsent(repo, join('a', 'c', 'z.ts'), memo)).toBe(true);
    // The first path probes a/b, a, then the existing repo root; the second
    // hits the memoized a/b at once; the third probes only a/c before the
    // memoized a. Without the memo this is 9 ancestor probes (3 per path).
    expect(vi.mocked(statSync).mock.calls).toHaveLength(4);
    // The memo stores only ancestor-walk verdicts — never the leaf lstat.
    expect(memo.has(join(repo, 'a', 'b', 'x.ts'))).toBe(false);
  });

  it('a non-ENOENT ancestor probe stays unmeasurable, even through the memo', () => {
    mkdirSync(join(repo, 'src'));
    const locked = join(repo, 'src');
    vi.mocked(statSync).mockImplementation(((p: PathLike) => {
      if (p === locked) throw errno('EACCES');
      return realFs.statSync(p);
    }) as unknown as typeof statSync);
    try {
      const memo = new Map<string, boolean>();
      expect(isPathProvablyAbsent(repo, join('src', 'x.ts'), memo)).toBe(false);
      // The memoized verdict for the EACCES ancestor IS the refusal: a
      // sibling path sharing the chain answers the same without re-probing.
      expect(memo.get(locked)).toBe(false);
      vi.mocked(statSync).mockClear();
      expect(isPathProvablyAbsent(repo, join('src', 'y.ts'), memo)).toBe(false);
      expect(vi.mocked(statSync).mock.calls).toHaveLength(0);
    } finally {
      vi.mocked(statSync).mockRestore();
    }
  });
});
