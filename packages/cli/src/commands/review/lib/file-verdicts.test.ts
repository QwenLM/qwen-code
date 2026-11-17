/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real git for the blob listings — content addressing IS git's behaviour, and
// the property under test (a rebase that preserves a file's pair preserves
// its verdict) only means anything against real object ids. The parsing half
// is the usual untrusted-boundary posture: the map lives in a model-promoted
// cache, so malformed → null, never a throw.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NO_BLOB,
  blobsAt,
  blobPairs,
  changedPairs,
  readFileVerdicts,
} from './file-verdicts.js';
import { UNHASHABLE } from './local-anchor.js';
import { isolateHostGitConfig } from './test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-fv-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

describe('blobsAt / blobPairs', () => {
  it('lists mode+oid identities at a ref, absent paths as NO_BLOB', () => {
    write('a.ts', 'A\n');
    write('dir/b.ts', 'B\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'one');
    const sha = git('rev-parse', 'HEAD');
    const blobs = blobsAt(repo, sha, ['a.ts', 'dir/b.ts', 'missing.ts'])!;
    expect(blobs['a.ts']).toMatch(/^100644 [0-9a-f]{40,64}$/);
    expect(blobs['dir/b.ts']).toMatch(/^100644 [0-9a-f]{40,64}$/);
    expect(blobs['missing.ts']).toBe(NO_BLOB);
    // Content-addressed: the oid half equals what hash-object computes.
    expect(blobs['a.ts']).toBe(`100644 ${git('hash-object', '--', 'a.ts')}`);
  });

  it('the identity carries the MODE: an exec-bit flip alone changes the pair', () => {
    write('run.sh', 'echo hi\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('update-index', '--chmod=+x', 'run.sh');
    git('commit', '-q', '--no-verify', '-m', 'chmod only');
    const head = git('rev-parse', 'HEAD');
    const recorded = blobPairs(repo, base, base, ['run.sh'])!;
    const current = blobPairs(repo, base, head, ['run.sh'])!;
    // Same bytes both sides — git diff still prints old/new mode lines, and
    // the pair must move with them.
    expect(changedPairs(recorded, current, ['run.sh'])).toEqual(['run.sh']);
  });

  it('an attribute change retires the verdict, blobs byte-identical or not', () => {
    // What a round REVIEWS is the rendering, and `.gitattributes` decides it:
    // `binary` turns hunks into "Binary files … differ" for the same bytes.
    // A `<mode> <oid>` identity cannot see that, so the clean verdict
    // transferred over a diff no round ever read.
    write('data.txt', 'line1\n');
    write('.gitattributes', 'data.txt binary\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    // The attribute goes away; `data.txt` itself is untouched.
    write('.gitattributes', '\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'attributes only');
    const head = git('rev-parse', 'HEAD');

    const recorded = blobPairs(repo, base, base, ['data.txt'])!;
    const current = blobPairs(repo, base, head, ['data.txt'])!;
    // The pair itself did NOT move — which is exactly the hole.
    expect(recorded['data.txt']).toEqual(current['data.txt']);
    // …and the attributes file was recorded even though the caller never
    // named it, so the consumer can see the move.
    expect(recorded['.gitattributes']).toBeDefined();
    expect(changedPairs(recorded, current, ['data.txt'])).toEqual(['data.txt']);
  });

  it('records the governing .gitattributes of every directory on the path', () => {
    // One `.gitattributes` governs a subtree, so the set that applies to a
    // path is every ancestor's. Recording only the root's would let a nested
    // one change unseen.
    write('pkg/deep/a.ts', 'A\n');
    write('pkg/.gitattributes', '*.ts text\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'nested attributes');
    const sha = git('rev-parse', 'HEAD');
    const pairs = blobPairs(repo, sha, sha, ['pkg/deep/a.ts'])!;
    expect(pairs['pkg/.gitattributes']).toBeDefined();
    expect(pairs['pkg/.gitattributes'].base).not.toBe(NO_BLOB);
    // The ones that do not exist are recorded inert rather than omitted, so
    // their later APPEARANCE is a move the consumer sees.
    expect(pairs['.gitattributes']).toEqual({ base: NO_BLOB, head: NO_BLOB });
    expect(pairs['pkg/deep/.gitattributes']).toEqual({
      base: NO_BLOB,
      head: NO_BLOB,
    });
  });

  it('is cwd-independent: identical listings from the root and a subdirectory', () => {
    write('pkg/deep/a.ts', 'A\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'one');
    const sha = git('rev-parse', 'HEAD');
    const fromRoot = blobsAt(repo, sha, ['pkg/deep/a.ts']);
    const prev = process.cwd();
    process.chdir(join(repo, 'pkg'));
    try {
      // Unpinned, the pathspec would miss from here and read NO_BLOB — the
      // silent everything-absent shape that converts a fallback into a skip.
      expect(blobsAt(repo, sha, ['pkg/deep/a.ts'])).toEqual(fromRoot);
    } finally {
      process.chdir(prev);
    }
  });

  it('returns null — unusable, not "everything absent" — on a bad ref, and on ONE bad side of a pair', () => {
    write('a.ts', 'A\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'one');
    const sha = git('rev-parse', 'HEAD');
    expect(blobsAt(repo, 'deadbeef', ['a.ts'])).toBeNull();
    expect(blobPairs(repo, 'deadbeef', sha, ['a.ts'])).toBeNull();
    expect(blobPairs(repo, sha, 'deadbeef', ['a.ts'])).toBeNull();
  });

  it('pairs survive a history rewrite that preserves content', () => {
    write('a.ts', 'A\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const base1 = git('rev-parse', 'HEAD');
    write('a.ts', 'A2\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'change');
    const head1 = git('rev-parse', 'HEAD');
    // Rewrite history: same tree contents, brand-new shas.
    git('commit', '--amend', '-q', '--no-verify', '-m', 'change (amended)');
    const head2 = git('rev-parse', 'HEAD');
    expect(head2).not.toBe(head1);
    expect(blobPairs(repo, base1, head1, ['a.ts'])).toEqual(
      blobPairs(repo, base1, head2, ['a.ts']),
    );
  });

  it('records a file literally named __proto__ at capture, not only on compare', () => {
    // On a plain object the producer's `out['__proto__'] = …` is a silent
    // no-op and the path would read absent at both refs — a pair that never
    // transfers, so the failure is over-review, but the record would be
    // wrong. Null-prototype maps on the producer side are what this pins.
    write('__proto__', 'A\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'proto');
    const sha = git('rev-parse', 'HEAD');
    expect(blobsAt(repo, sha, ['__proto__'])!['__proto__']).toMatch(
      /^100644 [0-9a-f]{40,64}$/,
    );
    expect(blobPairs(repo, sha, sha, ['__proto__'])!['__proto__'].head).toMatch(
      /^100644 [0-9a-f]{40,64}$/,
    );
  });

  it('a batch past 200 paths still maps every file', () => {
    const many: string[] = [];
    for (let i = 0; i < 201; i++) {
      const p = `many/f${String(i).padStart(3, '0')}.txt`;
      write(p, String(i));
      many.push(p);
    }
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'many');
    const sha = git('rev-parse', 'HEAD');
    const blobs = blobsAt(repo, sha, many)!;
    for (const p of many) expect(blobs[p]).toMatch(/^100644 [0-9a-f]{40,64}$/);
  });
});

describe('blobsAt — pathspec magic', () => {
  // ':' is a reserved NTFS character (drive / ADS separator): the write
  // itself throws on Windows, where the merge-queue leg runs this suite.
  it.skipIf(process.platform === 'win32')(
    'a colon-prefixed filename lists literally under --literal-pathspecs',
    () => {
      write(':weird.ts', 'W\n');
      git('add', '-A');
      git('commit', '-q', '--no-verify', '-m', 'colon');
      const sha = git('rev-parse', 'HEAD');
      const blobs = blobsAt(repo, sha, [':weird.ts'])!;
      expect(blobs[':weird.ts']).toMatch(/^100644 [0-9a-f]{40,64}$/);
    },
  );
});

describe('blobsAt — decode aliasing', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses the whole listing when a path cannot decode faithfully',
    () => {
      // U+FFFD in a decoded path is ambiguous by construction: it is either
      // a filename literally containing the replacement character (this
      // fixture) or a filename whose invalid byte the decode destroyed. The
      // two collapse to one key, so a plan path could resolve to the OTHER
      // file's tree entry on both sides and carry its clean verdict over an
      // edited file. Unusable beats wrong — the caller degrades to full.
      const mangled = 'a\uFFFD.ts';
      writeFileSync(join(repo, mangled), 'A\n');
      git('add', '-A');
      git('commit', '-q', '--no-verify', '-m', 'replacement-char name');
      const sha = git('rev-parse', 'HEAD');
      expect(blobsAt(repo, sha, [mangled])).toBeNull();
      expect(blobPairs(repo, sha, sha, [mangled])).toBeNull();
    },
  );
});

describe('readFileVerdicts', () => {
  it('round-trips a valid map and rejects every malformation', () => {
    const good = { 'a.ts': { base: 'b1', head: 'h1' } };
    expect(readFileVerdicts(good)).toEqual(good);
    for (const bad of [
      null,
      'nope',
      { 'a.ts': { base: 'b1' } },
      { 'a.ts': { base: 1, head: 'h' } },
      { 'a.ts': null },
    ]) {
      expect(readFileVerdicts(bad)).toBeNull();
    }
  });
});

describe('changedPairs', () => {
  const recorded = {
    'same.ts': { base: 'b1', head: 'h1' },
    'moved-base.ts': { base: 'b2', head: 'h2' },
    'moved-head.ts': { base: 'b3', head: 'h3' },
  };
  it('flags a moved base, a moved head, and an unrecorded path; keeps identical pairs', () => {
    const current = {
      'same.ts': { base: 'b1', head: 'h1' },
      'moved-base.ts': { base: 'bX', head: 'h2' },
      'moved-head.ts': { base: 'b3', head: 'hX' },
      'new.ts': { base: NO_BLOB, head: 'h4' },
    };
    expect(
      changedPairs(recorded, current, [
        'same.ts',
        'moved-base.ts',
        'moved-head.ts',
        'new.ts',
      ]),
    ).toEqual(['moved-base.ts', 'moved-head.ts', 'new.ts']);
  });

  it('an ABSENT-BASE pair never transfers, identical or not', () => {
    // The rename hole: a pure rename records (absent, blob) for its
    // destination, and a keep-both restructure reproduces the same pair
    // while the file became an all-new addition no round ever read.
    const rec = { 'added.ts': { base: NO_BLOB, head: 'h1' } };
    const cur = { 'added.ts': { base: NO_BLOB, head: 'h1' } };
    expect(changedPairs(rec, cur, ['added.ts'])).toEqual(['added.ts']);
  });

  it('an identical DELETION pair (blob, NO_BLOB) transfers — only absent-BASE never does', () => {
    const rec = { 'gone.ts': { base: '100644 b1', head: NO_BLOB } };
    const cur = { 'gone.ts': { base: '100644 b1', head: NO_BLOB } };
    expect(changedPairs(rec, cur, ['gone.ts'])).toEqual([]);
  });

  it('an attribute path present on only one side retires every verdict', () => {
    // A plan-set shift between rounds: the current record carries a
    // `dir/.gitattributes` the recorded one never saw. Nothing about `a.ts`
    // moved, and it must still re-enter — an attribute change no round read.
    const pair = { base: '100644 b', head: '100644 h', attrs: 'x' };
    const rec = { 'a.ts': pair };
    const cur = {
      'a.ts': pair,
      'dir/.gitattributes': { base: NO_BLOB, head: '100644 g' },
    };
    expect(changedPairs(rec, cur, ['a.ts'])).toEqual(['a.ts']);
    expect(changedPairs(cur, rec, ['a.ts'])).toEqual(['a.ts']);
  });

  it('a path named __proto__ compares as an ordinary key', () => {
    const rec = JSON.parse(
      '{"__proto__": {"base": "b1", "head": "h1"}}',
    ) as Record<string, { base: string; head: string }>;
    expect(changedPairs(rec, {}, ['__proto__'])).toEqual(['__proto__']);
  });
});
describe('blobPairs — the rendering the reviewer actually gets', () => {
  it('moves when an UNTRACKED .gitattributes changes how git renders', () => {
    // The two blobs answer "did the content move". They cannot answer "would
    // git render it the same way": a `.gitattributes` that is untracked in
    // the reviewer's checkout governs `git diff` while recording
    // absent-on-both-sides in the trees, so round 1 could read
    // "Binary files … differ", round 2 (same trees, file since removed) full
    // hunks — pairs byte-identical, clean verdict transferred over hunks no
    // round ever read.
    write('x.txt', 'hello\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    // Untracked, so it is in NEITHER tree.
    write('.gitattributes', 'x.txt binary\n');
    const withAttr = blobPairs(repo, base, base, ['x.txt'])!;
    rmSync(join(repo, '.gitattributes'));
    const withoutAttr = blobPairs(repo, base, base, ['x.txt'])!;

    // Same trees, same blobs — and git renders them differently, so the
    // record has to differ.
    expect(withAttr['x.txt'].base).toBe(withoutAttr['x.txt'].base);
    expect(withAttr['x.txt'].head).toBe(withoutAttr['x.txt'].head);
    expect(changedPairs(withAttr, withoutAttr, ['x.txt'])).toContain('x.txt');
  });
});
describe('the attrs component survives the cache, and fails closed', () => {
  it('round-trips through readFileVerdicts, so a verdict can transfer', () => {
    // The validated reader rebuilt each pair as `{base, head}` and dropped
    // the component `changedPairs` compares — so a record read back from the
    // cache always differed from a freshly computed one, every attrs-bearing
    // file read as changed every round, and no verdict ever transferred. The
    // fold and the comparison were both right; the reader made them inert.
    write('x.txt', 'hello\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    const fresh = blobPairs(repo, base, base, ['x.txt'])!;
    const roundTripped = readFileVerdicts(JSON.parse(JSON.stringify(fresh)))!;

    expect(roundTripped['x.txt'].attrs).toBe(fresh['x.txt'].attrs);
    expect(changedPairs(roundTripped, fresh, ['x.txt'])).toEqual([]);
  });

  it('never transfers a verdict over a rendering the probe could not report', () => {
    // `renderingAttributes` answers `{}` from a blanket catch when the probe
    // itself fails. Recording nothing for those paths let two rounds whose
    // probes both failed compare `undefined === undefined` — a clean verdict
    // over a rendering neither round certified. The sentinel is never equal,
    // and the COMPARISON is what makes it so: a plain constant equals itself.
    const unanswered = {
      'x.txt': { base: 'b', head: 'h', attrs: 'unanswered' },
    };
    expect(changedPairs(unanswered, unanswered, ['x.txt'])).toEqual(['x.txt']);
  });

  it('never transfers a verdict over a rendering the probe called UNHASHABLE', () => {
    // `renderingAttributes` answers UNHASHABLE for a `diff` attribute spelled
    // `set`/`unset` — `check-attr` reports the state and a driver so named
    // byte-identically, and they render differently — and `blobPairs`
    // records the answer verbatim. It is a plain constant, so left to the
    // string comparison it equalled itself: a repo with `data.bin diff=unset`
    // promoted a clean verdict, the machine-local config then gained
    // `diff.unset.binary`, and after a rebase the verdict transferred over a
    // "Binary files … differ" no round ever read. `local-anchor`'s standard —
    // never equal, not even to itself — applies here too.
    const unhashable = {
      'data.bin': { base: 'b', head: 'h', attrs: UNHASHABLE },
    };
    expect(changedPairs(unhashable, unhashable, ['data.bin'])).toEqual([
      'data.bin',
    ]);

    // …and the real answer, through git: identical trees, identical
    // records, still changed.
    write('data.bin', 'payload\n');
    write('.gitattributes', 'data.bin diff=unset\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    const recorded = blobPairs(repo, base, base, ['data.bin'])!;
    expect(recorded['data.bin'].attrs).toBe(UNHASHABLE);
    const roundTripped = readFileVerdicts(
      JSON.parse(JSON.stringify(recorded)),
    )!;
    expect(changedPairs(roundTripped, recorded, ['data.bin'])).toEqual([
      'data.bin',
    ]);
  });
});
