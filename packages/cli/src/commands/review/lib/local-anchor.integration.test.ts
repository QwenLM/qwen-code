/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git check-attr`, over paths that only real git renders faithfully.
// The property under test is byte-fidelity of a NUL-delimited protocol, and a
// mocked wrapper cannot break it the way the real one did.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedSince,
  hashWorktreeFiles,
  revisionIdentities,
  UNHASHABLE,
  invisibleTrackedPaths,
} from './local-anchor.js';
import { isolateHostGitConfig } from './test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'anchor-attr-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'core.autocrlf', 'false');
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

describe('hashWorktreeFiles — the attributes probe is not buffer-bound', () => {
  it('answers for a path count whose check-attr output passes 1 MB', () => {
    // `check-attr --stdin -z` emits roughly three NUL records per path, so a
    // few thousand files pass `execFileSync`'s 1 MB default and the call
    // throws ENOBUFS. The blanket catch then answers an empty attribute map
    // and every identity becomes UNHASHABLE — which never equals itself, so
    // every path reads as changed on every round. Nothing surfaces: the
    // stateId stays stable, so the anchor still validates and no refusal ever
    // prints, while the whole target is silently re-reviewed for ever and the
    // unchanged-since stop is unreachable.
    const paths: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const rel = `f${i}-${'p'.repeat(60)}.ts`;
      writeFileSync(join(repo, rel), 'export const a = 1;\n');
      paths.push(rel);
    }

    const out = hashWorktreeFiles(repo, paths);

    expect(Object.keys(out)).toHaveLength(paths.length);
    // Attributes reached the identity — an ENOBUFS would have left every one
    // of these UNHASHABLE instead.
    expect(out[paths[0]]).toContain('diff=');
    expect(Object.values(out).some((v) => v === 'unhashable')).toBe(false);
  });
});

describe('hashWorktreeFiles — the attributes probe is byte-faithful', () => {
  it('keeps the record of a path that begins with whitespace', () => {
    // A leading space is legal in a path on Linux and macOS, and
    // `check-attr --stdin -z` echoes the path back as each record's key. Read
    // through a wrapper that trims, the first record's key loses that byte:
    // it no longer matches the path that was asked about, every record shifts
    // onto a phantom key, and the path gets a MALFORMED identity rather than
    // an honest UNHASHABLE.
    //
    // That fails OPEN in one direction. The stolen record is the `diff`
    // attribute, so a `diff=<driver>` path never folds its driver's `binary`
    // setting in — and the config-side binary↔text flip the identity exists
    // to track becomes invisible between rounds.
    const leading = ' leading.ts';
    writeFileSync(join(repo, leading), 'export const a = 1;\n');
    writeFileSync(join(repo, 'plain.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, '.gitattributes'), '" leading.ts" diff=custom\n');

    const out = hashWorktreeFiles(repo, [leading, 'plain.ts']);

    // The whitespace path is answered for, under its own name…
    expect(Object.keys(out)).toContain(leading);
    // …and its record is the one git gave for IT: the driver name survives,
    // which is what the config-side `binary` lookup keys on.
    expect(out[leading]).toContain('diff=custom');
    // The sibling is unaffected either way — it is the control that shows the
    // probe ran at all rather than falling back wholesale.
    expect(out['plain.ts']).toContain('diff=unspecified');
  });

  it("folds a driver's binary flag only into the paths naming THAT driver", () => {
    // The fold used to match the record string by substring, so a driver
    // whose name is a PREFIX of another (`md` / `mdbook`) folded its config
    // into the other's paths: toggling `diff.md.binary` then re-reviewed
    // every `mdbook` file each round although its bytes, mode and own driver
    // never moved — the wasted re-review the attribute component exists to
    // prevent.
    writeFileSync(join(repo, 'a.md'), '# a\n');
    writeFileSync(join(repo, 'book.md'), '# book\n');
    writeFileSync(
      join(repo, '.gitattributes'),
      'a.md diff=md\nbook.md diff=mdbook\n',
    );
    git('config', 'diff.md.binary', 'true');

    const out = hashWorktreeFiles(repo, ['a.md', 'book.md']);

    // The fold lands on the path naming the driver…
    expect(out['a.md']).toContain('diff=md');
    expect(out['a.md']).toContain('md.binary=true');
    // …and the PREFIXED driver's path keeps its identity clean of it.
    expect(out['book.md']).toContain('diff=mdbook');
    expect(out['book.md']).not.toContain('md.binary');
  });

  it('folds a driver whose NAME CONTAINS A COMMA — matched as a value, never re-parsed', () => {
    // `*.bin diff=a,b` is a legal gitattributes line, and the fold used to
    // re-parse the comma-joined attribute serialization — `split(',')` can
    // never match a value containing a comma. The flag was silently dropped
    // from the identity, so flipping it changed how `git diff` rendered the
    // same bytes while the identity stood still: the next round's gate
    // compared equal and sliced the file out of scope, carrying the previous
    // verdict forward against a different rendering. `.gitattributes` is
    // worktree content of the reviewed PR, so the driver name is plantable.
    writeFileSync(join(repo, 'data.bin'), 'x\n');
    writeFileSync(join(repo, '.gitattributes'), 'data.bin diff=a,b\n');
    git('config', 'diff.a,b.binary', 'true');

    const on = hashWorktreeFiles(repo, ['data.bin']);
    expect(on['data.bin']).toContain('a,b.binary=true');

    git('config', 'diff.a,b.binary', 'false');
    const off = hashWorktreeFiles(repo, ['data.bin']);
    expect(off['data.bin']).toContain('a,b.binary=false');
    expect(off['data.bin']).not.toBe(on['data.bin']);
  });

  it('a driver literally named `set` is uncertifiable — the answer is ambiguous', () => {
    // `data.bin diff=set` is a legal gitattributes line naming a DRIVER
    // `set`, and `check-attr` answers it byte-identically to the `set`
    // attribute STATE. Folding the spelling into the identity — even with
    // the `diff.set.binary` config folded beside it — collapsed two
    // DIFFERENT rendering states into one identity: plain `diff` renders
    // readable hunks under `diff.set.binary=true` while `diff=set` renders
    // "Binary files differ" (probed, git 2.39.5), yet both answer `set` and
    // both fold the same config, so the pair can never be told apart on
    // this stream. The fold existed to track the config-side flip; the
    // state-vs-name conflation is one entrance it cannot close, and the
    // module's standard for a rendering it cannot capture is UNHASHABLE —
    // re-reviewed every round rather than certified across the flip.
    // `.gitattributes` is worktree content of the reviewed PR, so the driver
    // name is plantable; `unset` is plantable the same way (and needs no
    // config at all to diverge — see the sibling suite below).
    writeFileSync(join(repo, 'data.bin'), 'x\n');
    writeFileSync(join(repo, '.gitattributes'), 'data.bin diff=set\n');
    git('config', 'diff.set.binary', 'true');

    const out = hashWorktreeFiles(repo, ['data.bin']);
    expect(out['data.bin']).toBe(UNHASHABLE);
  });

  it('a plain `diff` attribute is uncertifiable too — the sibling ambiguity', () => {
    // The state half of the pair above: a path whose `diff` attribute is
    // merely SET (no driver) is answered `set`, byte-identically to a
    // driver literally named `set`. Neither half can be certified without
    // the other, so both take UNHASHABLE.
    writeFileSync(join(repo, 'data.bin'), 'x\n');
    writeFileSync(join(repo, '.gitattributes'), 'data.bin diff\n');

    const out = hashWorktreeFiles(repo, ['data.bin']);
    expect(out['data.bin']).toBe(UNHASHABLE);
  });
});
describe('hashWorktreeFiles — a decoded path is not a name', () => {
  it('refuses to hash a path carrying U+FFFD', () => {
    // The capture pins `core.quotePath=false` and decodes with `toString`,
    // so every invalid byte folds to U+FFFD. Beside a file LITERALLY named
    // with one, two plan paths fold to a single key: `lstat` succeeds on the
    // real file, the invalid-byte sibling inherits its identity, is never
    // hashed, and its changes compare unchanged for ever. The `lstat` guard
    // cannot see it, because the stat succeeds.
    writeFileSync(join(repo, '\ufffd.ts'), 'export const a = 1;\n');
    const out = hashWorktreeFiles(repo, ['\ufffd.ts', 'plain.ts']);
    expect(out['\ufffd.ts']).toBe('unhashable');
  });
});
describe('hashWorktreeFiles — every diff-driver spelling reaches the fold', () => {
  it('folds the EMPTY driver name, which git accepts as `diff..binary`', () => {
    // `*.dat diff=` is a legal attributes line, `check-attr --stdin -z`
    // answers it with an empty value, and `git config diff..binary true`
    // flips that section between readable hunks and "Binary files differ"
    // with the mode and the blob standing still (verified against git
    // 2.47.3). Excluding the empty spelling was the last entrance of the
    // family whose `set`/`unset`/`unspecified` siblings were already closed.
    writeFileSync(join(repo, 'a.dat'), 'hello\n');
    writeFileSync(join(repo, '.gitattributes'), '*.dat diff=\n');
    const before = hashWorktreeFiles(repo, ['a.dat'])['a.dat'];

    execFileSync('git', ['config', 'diff..binary', 'true'], { cwd: repo });
    const after = hashWorktreeFiles(repo, ['a.dat'])['a.dat'];

    // The bytes and the mode did not move; the RENDERING did, so the
    // identity has to.
    expect(after).not.toBe(before);
    expect(after).toContain('.binary=true');
  });
});

describe('hashWorktreeFiles — an undecodable driver name unhashes the WHOLE identity', () => {
  it('marks the identity UNHASHABLE, not a composite ending in the slot', () => {
    // The record stream is utf8-decoded, so an invalid byte in a driver NAME
    // folds to U+FFFD and the config probe could never match the raw-byte key
    // git itself matches — `renderingAttributes` answers UNHASHABLE for the
    // path (verified against git 2.39.5: `check-attr --stdin -z` echoes the
    // raw byte back). Composing that answer onto the mode-and-blob prefix
    // produced `100644:<blob>:unhashable` — a string that compares equal to
    // itself across rounds, so flipping `diff.<raw-bytes>.binary` changed
    // the rendering while the identity stood still and the section was
    // sliced out of scope. The module's own standard applies to the WHOLE
    // identity: what cannot be named faithfully cannot be certified.
    writeFileSync(
      join(repo, '.gitattributes'),
      Buffer.concat([
        Buffer.from('data.bin diff='),
        Buffer.from([0xff]),
        Buffer.from('drv\n'),
      ]),
    );
    writeFileSync(join(repo, 'data.bin'), 'x\n');
    writeFileSync(join(repo, 'plain.ts'), 'export const a = 1;\n');

    const out = hashWorktreeFiles(repo, ['data.bin', 'plain.ts']);

    expect(out['data.bin']).toBe('unhashable');
    // The sibling is the control arm: the probe ran and answered normally,
    // so the UNHASHABLE above is the undecodable-name discipline, not a
    // wholesale fallback (an ENOBUFS-style empty answer map would unhash
    // BOTH).
    expect(out['plain.ts']).toContain('diff=unspecified');
  });

  it('re-enters scope on the next round instead of comparing unchanged', async () => {
    // The consequence the identity exists for: UNHASHABLE never equals
    // itself, so a round that hashed the path re-reviews it rather than
    // comparing it unchanged and slicing it out of scope with the previous
    // verdict riding on a rendering no round saw. The composite identity
    // this replaces compared equal to itself, which is exactly what made
    // the rendering flip invisible.
    const { changedSince } = await import('./local-anchor.js');
    writeFileSync(
      join(repo, '.gitattributes'),
      Buffer.concat([
        Buffer.from('data.bin diff='),
        Buffer.from([0xff]),
        Buffer.from('drv\n'),
      ]),
    );
    writeFileSync(join(repo, 'data.bin'), 'x\n');

    const before = hashWorktreeFiles(repo, ['data.bin']);
    const after = hashWorktreeFiles(repo, ['data.bin']);

    expect(changedSince(before, after)).toContain('data.bin');
  });
});

describe('hashWorktreeFiles — a path listed twice is hashed once', () => {
  it('dedups repeated input paths at the module boundary', () => {
    // Two open Criticals citing the SAME file is an ordinary ledger shape,
    // and the blocker date passes its file list straight through.
    // `check-attr` answers once per input OCCURRENCE, so a duplicate used to
    // append the rendering suffix once per listing — an identity that never
    // matches the cache's single-suffix one, read as "moved" under every
    // possible tree state, for ever.
    writeFileSync(join(repo, 'f.ts'), 'export const a = 1;\n');

    const single = hashWorktreeFiles(repo, ['f.ts']);
    const dup = hashWorktreeFiles(repo, ['f.ts', 'f.ts']);

    expect(dup['f.ts']).toBe(single['f.ts']);
    expect(Object.keys(dup)).toEqual(['f.ts']);
  });
});

describe('revisionIdentities — ledger paths are read literally', () => {
  it('survives a path beginning with pathspec magic', () => {
    // The paths come from the model-written ledger, an untrusted-input
    // boundary: a name beginning `:(` is pathspec magic, and known-but-
    // unsupported magic fatals `ls-tree` with exit 128 — the WHOLE batch.
    // The catch then answered `{}`, reading every datable sibling in the
    // call undatable too, so one hostile or malformed ledger path cleared
    // the entire `--fail-on` gate.
    writeFileSync(join(repo, 'sib.md'), 'sib\n');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const head = git('rev-parse', 'HEAD').trim();

    const ids = revisionIdentities(repo, head, [':(glob)notes.md', 'sib.md']);

    // The sibling is dated normally; the magic name is simply absent from
    // the tree — undatable, not fatal.
    expect(ids['sib.md']).toMatch(/^100644:[0-9a-f]{40}:/);
    expect(ids[':(glob)notes.md']).toBeUndefined();
  });
});

describe('hashWorktreeFiles — a state name spelled as a value is uncertifiable', () => {
  // `check-attr` answers an attribute STATE and a VALUE assignment that
  // spells a state name byte-identically, while `git diff` renders them
  // differently: `*.dat -diff` renders "Binary files … differ" and
  // `*.dat diff=unset` renders readable hunks, both answered `diff: unset`
  // (probed, git 2.39.5 — no config involved). The identity cannot carry a
  // distinction the probe stream cannot name, so such a path takes
  // UNHASHABLE — re-reviewed every round rather than certified across a
  // rendering flip.
  it('folds the whole identity to UNHASHABLE when `diff` answers `unset` or `set`', () => {
    writeFileSync(join(repo, 'data.dat'), 'line one\nline two\n');

    writeFileSync(join(repo, '.gitattributes'), '*.dat -diff\n');
    const stateUnset = hashWorktreeFiles(repo, ['data.dat']);
    expect(stateUnset['data.dat']).toBe(UNHASHABLE);

    writeFileSync(join(repo, '.gitattributes'), '*.dat diff=unset\n');
    const namedUnset = hashWorktreeFiles(repo, ['data.dat']);
    expect(namedUnset['data.dat']).toBe(UNHASHABLE);

    writeFileSync(join(repo, '.gitattributes'), '*.dat diff\n');
    const stateSet = hashWorktreeFiles(repo, ['data.dat']);
    expect(stateSet['data.dat']).toBe(UNHASHABLE);
  });

  it('a flip between the two ambiguous spellings re-enters scope', () => {
    // The pre-fix identity was byte-identical across the flip, so
    // `changedSince` read the file as unchanged and the newly-readable
    // section was sliced out of scope carrying the previous verdict.
    writeFileSync(join(repo, 'data.dat'), 'line one\nline two\n');
    writeFileSync(join(repo, '.gitattributes'), '*.dat -diff\n');
    const round1 = hashWorktreeFiles(repo, ['data.dat']);
    writeFileSync(join(repo, '.gitattributes'), '*.dat diff=unset\n');
    const round2 = hashWorktreeFiles(repo, ['data.dat']);
    expect(changedSince(round1, round2)).toEqual(['data.dat']);
  });

  it('keeps unambiguous answers folding — the closure narrows, not widens', () => {
    writeFileSync(join(repo, 'data.dat'), 'line one\nline two\n');
    writeFileSync(join(repo, 'plain.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, '.gitattributes'), '*.dat diff=mydrv\n');

    const ids = hashWorktreeFiles(repo, ['data.dat', 'plain.ts']);
    // A real driver name still folds into the identity…
    expect(ids['data.dat']).toContain('diff=mydrv');
    expect(ids['data.dat']).not.toBe(UNHASHABLE);
    // …and `unspecified` — the answer every unattributed path gets — stays
    // foldable, or the anchor would re-review the entire tree every round.
    expect(ids['plain.ts']).toContain('diff=unspecified');
    expect(ids['plain.ts']).not.toBe(UNHASHABLE);
  });
});

describe('invisibleTrackedPaths — sparse-checkout owns its S bits', () => {
  it('exempts out-of-cone S paths, keeps manual bits and non-sparse absences', () => {
    // R17-5: every out-of-cone tracked path in a sparse checkout is
    // S-tagged by design and absent from the worktree — counting them made
    // the oracle non-empty on every sample, withholding the candidate and
    // all three decided stops on a completely clean materialized tree, for
    // ever. An absent path holds no file to hide an edit in, so under
    // sparse-checkout an absent S path is exempt; an in-cone manually
    // skip-worktree'd file still flags, and outside sparse-checkout an
    // absent S path stays flagged — there the bit is a user's hand and the
    // absence is a deletion it hides.
    writeFileSync(join(repo, 'in.ts'), 'export const a = 1;\n');
    git('add', 'in.ts');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub/out.ts'), 'export const b = 1;\n');
    git('add', 'sub/out.ts');
    git('commit', '-q', '--no-verify', '-m', 'base');

    git('sparse-checkout', 'set', '--cone', '.');
    // Cone mode with only the root: sub/ leaves the worktree, S-tagged.
    expect(existsSync(join(repo, 'sub/out.ts'))).toBe(false);
    expect(invisibleTrackedPaths(repo)).toEqual([]);

    // The assume-unchanged family is never exempted, sparse or not: git
    // does not manage those bits for any feature, so a lowercase tag is
    // always a user's hand. (A manual skip-worktree on an in-cone file is
    // unconstructible here — cone-mode git silently re-clears it, measured
    // on git 2.47.)
    git('update-index', '--assume-unchanged', 'in.ts');
    expect(invisibleTrackedPaths(repo)).toEqual(['in.ts']);
    git('update-index', '--no-assume-unchanged', 'in.ts');

    // Outside sparse-checkout, an absent S path is a hidden deletion and
    // stays flagged.
    git('sparse-checkout', 'disable');
    git('update-index', '--skip-worktree', 'sub/out.ts');
    rmSync(join(repo, 'sub/out.ts'));
    expect(invisibleTrackedPaths(repo)).toEqual(['sub/out.ts']);
  });
});

describe('hashWorktreeFiles — a configured `unspecified` driver is uncertifiable', () => {
  it('takes UNHASHABLE under diff.unspecified.binary, folds nothing without it', () => {
    // R17-3: `check-attr` answers `diff=unspecified` byte-identically for
    // the no-rule state and an explicit `diff=unspecified` value, and the
    // two render differently exactly when `diff.unspecified.binary` is
    // configured — the fold cannot split what the stream spells alike, so
    // the config's presence makes the dimension ambiguous for every path
    // that answered it. Without the config nothing changes.
    writeFileSync(join(repo, 'data.dat'), 'plain bytes\n');
    git('add', 'data.dat');

    const before = hashWorktreeFiles(repo, ['data.dat'])['data.dat'];
    expect(before).not.toBe(UNHASHABLE);
    expect(before).toContain('diff=unspecified');

    git('config', 'diff.unspecified.binary', 'true');
    const after = hashWorktreeFiles(repo, ['data.dat'])['data.dat'];
    expect(after).toBe(UNHASHABLE);
  });
});
