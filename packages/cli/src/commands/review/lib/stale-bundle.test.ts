/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// One listed file can be made unreadable, to reach the branch where the tree
// changes underneath the walk. Everything else passes through to the real fs.
const unreadable = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('node:fs');
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (unreadable.path && String(p) === unreadable.path) {
      throw Object.assign(new Error('ENOENT: vanished mid-walk'), {
        code: 'ENOENT',
      });
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

import {
  bundleStaleness,
  reviewSourceRoots,
  reviewSourcesDigest,
  staleBundleWarning,
  type ReviewSourceRoot,
} from './stale-bundle.js';

// The build stamps this digest from `scripts/copy_bundle_assets.js`, which
// cannot import this module — it runs before the package is built. The two
// implementations are held equal by `scripts/tests/review-source-digest.test.ts`,
// which is the side of the boundary allowed to reach across it.

const code = (path: string): ReviewSourceRoot => ({ path, kind: 'code' });
const skill = (path: string): ReviewSourceRoot => ({ path, kind: 'skill' });

describe('reviewSourcesDigest', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stale-bundle-'));
    dir = join(root, 'src');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('changes when a source changes', () => {
    writeFileSync(join(dir, 'drive.ts'), 'before');
    const before = reviewSourcesDigest(root, [code(dir)]);
    writeFileSync(join(dir, 'drive.ts'), 'after');
    expect(reviewSourcesDigest(root, [code(dir)])).not.toBe(before);
  });

  it('does not change when only timestamps do', () => {
    // The whole reason this is a digest. `git checkout` re-stamps every file
    // that differs between two commits, so returning to the branch a bundle
    // was built from makes its sources look newer while being byte-for-byte
    // what was built — a timestamp check calls that stale and is wrong.
    const file = join(dir, 'drive.ts');
    writeFileSync(file, 'same');
    const before = reviewSourcesDigest(root, [code(dir)]);
    const later = new Date(Date.now() + 86_400_000);
    utimesSync(file, later, later);
    expect(reviewSourcesDigest(root, [code(dir)])).toBe(before);
  });

  it('changes when a source is added, and comes back when it is removed', () => {
    writeFileSync(join(dir, 'a.ts'), 'x');
    const one = reviewSourcesDigest(root, [code(dir)]);
    writeFileSync(join(dir, 'b.ts'), 'y');
    expect(reviewSourcesDigest(root, [code(dir)])).not.toBe(one);
    rmSync(join(dir, 'b.ts'));
    expect(reviewSourcesDigest(root, [code(dir)])).toBe(one);
  });

  it('folds the path, so moving a file changes the digest', () => {
    // The same bytes under a different name is a different source: a command
    // that moved is a command that no longer registers where it did.
    writeFileSync(join(dir, 'a.ts'), 'x');
    const before = reviewSourcesDigest(root, [code(dir)]);
    rmSync(join(dir, 'a.ts'));
    writeFileSync(join(dir, 'b.ts'), 'x');
    expect(reviewSourcesDigest(root, [code(dir)])).not.toBe(before);
  });

  it('is independent of where the checkout sits', () => {
    // Relative to `repoRoot` with separators normalised, so a bundle built in
    // CI and a tree cloned elsewhere agree.
    writeFileSync(join(dir, 'a.ts'), 'x');
    const here = reviewSourcesDigest(root, [code(dir)]);

    const other = mkdtempSync(join(tmpdir(), 'stale-bundle-elsewhere-'));
    const otherDir = join(other, 'src');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'a.ts'), 'x');
    expect(reviewSourcesDigest(other, [code(otherDir)])).toBe(here);
    rmSync(other, { recursive: true, force: true });
  });

  it('finds a source nested below the root', () => {
    writeFileSync(join(dir, 'a.ts'), 'x');
    const flat = reviewSourcesDigest(root, [code(dir)]);
    const deep = join(dir, 'lib', 'nested');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'ledger.ts'), 'y');
    expect(reviewSourcesDigest(root, [code(dir)])).not.toBe(flat);
  });

  it('accepts a single file as a root, not only a directory', () => {
    // `review.ts` registers every subcommand and lives beside the directory,
    // not in it — a new command or a changed dispatch is a change there and
    // nowhere else.
    const lone = join(root, 'review.ts');
    writeFileSync(lone, 'registers');
    const before = reviewSourcesDigest(root, [code(lone)]);
    expect(before).toBeDefined();
    writeFileSync(lone, 'registers one more');
    expect(reviewSourcesDigest(root, [code(lone)])).not.toBe(before);
  });

  it('does not depend on the order the files are found in', () => {
    // `readdir` order is a property of the filesystem, so without the sort a
    // bundle built in CI and a tree cloned locally hash the same source
    // differently — and the check calls a correct bundle stale.
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'x');
    writeFileSync(b, 'y');
    expect(reviewSourcesDigest(root, [code(a), code(b)])).toBe(
      reviewSourcesDigest(root, [code(b), code(a)]),
    );
  });

  it('ignores test files, which the bundle never contains', () => {
    // esbuild follows imports from the CLI entry and no test is reachable that
    // way, so an edit to one cannot change a byte of the bundle. Folding them
    // in would warn about a build that is exactly correct.
    writeFileSync(join(dir, 'drive.ts'), 'x');
    const before = reviewSourcesDigest(root, [code(dir)]);
    writeFileSync(join(dir, 'drive.test.ts'), 'a test');
    expect(reviewSourcesDigest(root, [code(dir)])).toBe(before);
    writeFileSync(join(dir, 'drive.spec.tsx'), 'another');
    expect(reviewSourcesDigest(root, [code(dir)])).toBe(before);
  });

  it('ignores a fixtures directory, which the bundle never contains', () => {
    // Measured: none of the four files under `review/__fixtures__` appears in
    // `dist`. A fixture is loaded by a test at runtime, from no import the
    // bundler follows.
    writeFileSync(join(dir, 'drive.ts'), 'x');
    const before = reviewSourcesDigest(root, [code(dir)]);
    const fixtures = join(dir, '__fixtures__');
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, 'responder.mjs'), 'export const a = 1;');
    writeFileSync(join(fixtures, 'comment.md'), '# a comment');
    expect(reviewSourcesDigest(root, [code(dir)])).toBe(before);
  });

  it('ignores a test file passed as a root in its own right', () => {
    const lone = join(root, 'review.test.ts');
    writeFileSync(lone, 'x');
    expect(reviewSourcesDigest(root, [code(lone)])).toBeUndefined();
  });

  it('ignores symlinks, and terminates on a directory cycle', () => {
    // The walk documents this and nothing pinned it: a mutant that follows
    // links survived the whole suite. A cycle would send the first command of
    // every review into unbounded recursion; a file link would fold foreign
    // content into the digest and accuse a correct bundle.
    writeFileSync(join(dir, 'drive.ts'), 'x');
    const before = reviewSourcesDigest(root, [code(dir)]);

    const outside = join(root, 'outside.ts');
    writeFileSync(outside, 'not this tree');
    symlinkSync(outside, join(dir, 'linked.ts'));
    symlinkSync(dir, join(dir, 'cycle'));

    expect(reviewSourcesDigest(root, [code(dir)])).toBe(before);
  });

  it('measures nothing when a listed file cannot be read', () => {
    // A concurrent checkout deleting a source mid-walk. Hashing the survivors
    // would differ from the stamp and accuse a tree that is merely mid-change;
    // the honest answer is that nothing was measured.
    writeFileSync(join(dir, 'a.ts'), 'x');
    writeFileSync(join(dir, 'b.ts'), 'y');
    unreadable.path = join(dir, 'b.ts');
    try {
      expect(reviewSourcesDigest(root, [code(dir)])).toBeUndefined();
    } finally {
      unreadable.path = '';
    }
  });

  it('yields nothing when there are no sources to hash', () => {
    expect(
      reviewSourcesDigest(root, [code(join(root, 'nope'))]),
    ).toBeUndefined();
  });

  it('ignores stray files no build can fold into the bundle', () => {
    // A conflicted rebase leaves `drive.ts.orig` and `drive.ts.rej`, an editor
    // leaves a swapfile, a reader leaves a note — none of them can reach
    // `cli.js`, so none of them may move the digest. The blocklist this check
    // once used had been patched four times for this class; the allowlist
    // ends the class instead of extending it.
    writeFileSync(join(dir, 'drive.ts'), 'x');
    const before = reviewSourcesDigest(root, [code(dir)]);
    writeFileSync(join(dir, 'drive.ts.orig'), 'rebase droppings');
    writeFileSync(join(dir, 'drive.ts.rej'), 'a rejected hunk');
    writeFileSync(join(dir, 'notes.md'), 'scratch');
    writeFileSync(join(dir, 'drive.ts.swp'), 'an editor swapfile');
    writeFileSync(join(dir, '.DS_Store'), 'finder droppings');
    expect(reviewSourcesDigest(root, [code(dir)])).toBe(before);
  });

  it('digests a skill root by the documents the copier ships', () => {
    // The skill root is copied whole, not imported: its allowlist is the
    // markdown it holds. Stray files are the same class the code roots'
    // allowlist ends — a `SKILL.md.orig` from a rebase must not accuse a
    // correct bundle.
    const skillDir = join(root, 'skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# skill');
    const before = reviewSourcesDigest(root, [skill(skillDir)]);
    expect(before).toBeDefined();
    writeFileSync(join(skillDir, 'SKILL.md.orig'), 'droppings');
    writeFileSync(join(skillDir, 'scratch.txt'), 'x');
    expect(reviewSourcesDigest(root, [skill(skillDir)])).toBe(before);
    writeFileSync(join(skillDir, 'DESIGN.md'), '# design');
    expect(reviewSourcesDigest(root, [skill(skillDir)])).not.toBe(before);
  });
});

describe('bundleStaleness', () => {
  it('is stale only when both digests are known and differ', () => {
    expect(bundleStaleness('aaa', 'bbb').stale).toBe(true);
    expect(bundleStaleness('aaa', 'aaa').stale).toBe(false);
    expect(bundleStaleness('aaa', 'aaa').unmeasured).toBeUndefined();
  });

  it.each([
    [
      'no stamp beside the bundle',
      undefined,
      'aaa',
      'the bundle carries no source digest',
    ],
    [
      'no sources to compare',
      'aaa',
      undefined,
      'no review sources found to compare',
    ],
    ['neither', undefined, undefined, 'the bundle carries no source digest'],
  ])(
    'says it could not measure with %s, and does not accuse the build',
    (_n, stamped, current, reason) => {
      // An installed package has neither half. A check that cannot see both
      // must not report the build as stale, and must say why rather than pass
      // silently.
      const s = bundleStaleness(stamped, current);
      expect(s.stale).toBe(false);
      // The reason itself, not just that there is one: swapping the two
      // arguments at the call site keeps every stale/fresh assertion green
      // while telling a pre-stamp checkout its sources are missing.
      expect(s.unmeasured).toBe(reason);
      expect(staleBundleWarning(s)).toBeUndefined();
    },
  );
});

describe('staleBundleWarning', () => {
  it('says what runs from the bundle, not just that it is old', () => {
    // "Rebuild" alone leaves a reader to guess what is at risk; the whole
    // point is that the results they are about to trust may be the old
    // build's.
    const w = staleBundleWarning({ stale: true })!;
    expect(w).toContain('NOT built from the review sources in this tree');
    expect(w).toContain('runs the BUILT bundle, not the working tree');
    expect(w).toContain('npm run build:packages && npm run bundle');
  });

  it('says nothing when nothing is wrong', () => {
    expect(staleBundleWarning({ stale: false })).toBeUndefined();
  });
});

describe('reviewSourceRoots', () => {
  it('covers the directory, the registration file beside it, and the skill', () => {
    // Built with the platform's `join`, so the expectation is too — a literal
    // with forward slashes passes on Linux and fails every element on the
    // Windows leg of the merge queue, which the PR event never runs.
    expect(reviewSourceRoots('/w')).toEqual([
      {
        path: join('/w', 'packages', 'cli', 'src', 'commands', 'review'),
        kind: 'code',
      },
      // A subcommand added without a rebuild is a change here and nowhere
      // under `review/`.
      {
        path: join('/w', 'packages', 'cli', 'src', 'commands', 'review.ts'),
        kind: 'code',
      },
      {
        path: join(
          '/w',
          'packages',
          'core',
          'src',
          'skills',
          'bundled',
          'review',
        ),
        kind: 'skill',
      },
    ]);
  });
});
