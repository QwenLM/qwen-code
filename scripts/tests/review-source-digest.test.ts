/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The review source digest is computed twice: once by the build, which stamps
// it beside the bundle, and once by the review commands (`parse-args`, and
// `drive`, which agents can reach directly without `parse-args` ever running
// first), which re-derive it from the tree and compare.
// A rule stated twice is a rule that will be true in one
// place, and the two cannot share code — the build script runs before the
// package it would import has been built. So this is the test that keeps them
// equal, and it lives here because a package test is not allowed to reach into
// `scripts/`. It runs under `npm run test:scripts` (part of `npm run
// test:ci`), not `npm test` — a digest change verified only against the
// package suite never reaches it.

import { describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_SKILL_TEST_FILE_RE,
  copyBundleAssets,
  reviewSourceDigestForBuild,
} from '../copy_bundle_assets.js';
import { isAllowedDistEntry } from '../create-standalone-package.js';
import {
  DIGESTED_EXTENSIONS,
  DIGEST_FILE,
  NOT_BUNDLED_SKILL_FILE,
  reviewSourceRoots,
  reviewSourcesDigest,
} from '../../packages/cli/src/commands/review/lib/stale-bundle.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * The name the build actually writes, taken by running it — not by matching a
 * pattern against its source, which is how the first version of this broke:
 * the literal moved into a `stampPath` variable and the regex quietly returned
 * `undefined`, so the assertion compared against nothing and the test went red
 * only when something else happened to run it.
 */
function stampNameWrittenByBuild(): string | undefined {
  const root = mkdtempSync(join(tmpdir(), 'stamp-name-'));
  // The copier logs or warns about every asset class it meets; without a
  // stub, this case adds that noise to the suite's output on every run —
  // `package-assets.test.js` stubs for exactly this reason.
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const cli = join(root, 'packages', 'cli', 'src', 'commands');
    mkdirSync(join(cli, 'review'), { recursive: true });
    writeFileSync(join(cli, 'review', 'drive.ts'), 'export const a = 1;');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'cli.js'), 'bundle');
    const before = new Date(Date.now() - 60_000);
    utimesSync(join(cli, 'review', 'drive.ts'), before, before);
    copyBundleAssets({ root });
    return readdirSync(join(root, 'dist')).find((f) => f.endsWith('.sha256'));
  } finally {
    log.mockRestore();
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the build stamp and the staleness check agree', () => {
  it('hashes this repository to the same digest', () => {
    const fromCheck = reviewSourcesDigest(
      repoRoot,
      reviewSourceRoots(repoRoot),
    );
    expect(fromCheck).toBeDefined();
    expect(reviewSourceDigestForBuild(repoRoot).digest).toBe(fromCheck);
  });

  it('writes and reads the same filename', () => {
    // The build stamps a literal and the check reads `DIGEST_FILE`. A
    // one-sided rename leaves the read throwing, the comparison unmeasured,
    // and the warning silently never firing again — with the digest parity
    // above still green, because it never touches the name.
    expect(stampNameWrittenByBuild()).toBe(DIGEST_FILE);
  });

  it('stamps a file the standalone packager will accept', () => {
    // `createStandalonePackage` fails on any top-level dist entry outside its
    // allowlist, and no PR-time job runs it — so without this, dropping the
    // entry or renaming the stamp on one side is discovered when a release is
    // cut, on all five targets at once.
    expect(isAllowedDistEntry(DIGEST_FILE)).toBe(true);
  });

  it('agrees on a synthetic tree too, including a file-shaped root', () => {
    // The repo case cannot vary; this one can. A root that is a single file is
    // how `review.ts` — where every subcommand is registered — is covered, and
    // it is the part of the walk most likely to drift between two copies.
    const root = mkdtempSync(join(tmpdir(), 'digest-parity-'));
    try {
      const cli = join(root, 'packages', 'cli', 'src', 'commands');
      mkdirSync(join(cli, 'review', 'lib'), { recursive: true });
      mkdirSync(
        join(root, 'packages', 'core', 'src', 'skills', 'bundled', 'review'),
        { recursive: true },
      );
      const skillDir = join(
        root,
        'packages',
        'core',
        'src',
        'skills',
        'bundled',
        'review',
      );
      writeFileSync(join(cli, 'review.ts'), 'registers everything');
      // The lease is the other file-shaped root, and the only one outside
      // `commands/`. Materialized here so its pin is local: the repo-tree
      // case holds it only through the real file, and would silently drop
      // the pin the day that file moved.
      const services = join(root, 'packages', 'cli', 'src', 'services');
      mkdirSync(services, { recursive: true });
      writeFileSync(
        join(services, 'review-worktree-lease.ts'),
        'leases the worktree',
      );
      writeFileSync(join(cli, 'review', 'drive.ts'), 'drives');
      writeFileSync(join(cli, 'review', 'lib', 'ledger.ts'), 'ledgers');
      // One production file per admitted code extension: dropping a member
      // from one implementation's allowlist used to keep every suite green,
      // because `.ts` was the only extension this tree exercised.
      writeFileSync(join(cli, 'review', 'view.jsx'), 'export const v = 1;');
      writeFileSync(join(cli, 'review', 'mod.mts'), 'export const m = 1;');
      writeFileSync(join(cli, 'review', 'mod.cts'), 'export const c = 1;');
      writeFileSync(join(cli, 'review', 'util.js'), 'export const u = 1;');
      writeFileSync(join(cli, 'review', 'util.mjs'), 'export const w = 1;');
      writeFileSync(join(cli, 'review', 'data.json'), '{}');
      writeFileSync(join(skillDir, 'SKILL.md'), '# skill');
      // A fixture directory under the SKILL root is still digested: the
      // directory exclusions are a code-root concern (`kind !== 'code'`),
      // and nothing pinned the qualifier — it survived removal on both sides.
      mkdirSync(join(skillDir, '__fixtures__'), { recursive: true });
      writeFileSync(join(skillDir, '__fixtures__', 'example.md'), '# fixture');
      // DESIGN.md is the copier's deliberate skip, so it must move neither
      // side of the digest — pinned by the count below staying at 12.
      writeFileSync(join(skillDir, 'DESIGN.md'), '# design');

      expect(reviewSourceDigestForBuild(root).digest).toBe(
        reviewSourcesDigest(root, reviewSourceRoots(root)),
      );
      expect(reviewSourceDigestForBuild(root).count).toBe(12);

      // ...and neither a test file, nor a spec, nor a fixture moves either.
      writeFileSync(join(cli, 'review', 'drive.test.ts'), 'a test');
      writeFileSync(join(cli, 'review', 'drive.spec.tsx'), 'a spec');
      // The `[cm]?` group, pinned on both sides: the two files above would
      // still agree if one side lost the `c` or the `m`, so a one-sided edit
      // there used to pass both parity cases.
      writeFileSync(join(cli, 'review', 'drive.test.mts'), 'an mts test');
      writeFileSync(join(cli, 'review', 'drive.spec.cts'), 'a cts spec');
      // The `j` alternative of `[jt]sx?`: every fixture above resolves
      // through the `t` branch, and the real roots hold no `.js` tests.
      writeFileSync(join(cli, 'review', 'drive.test.js'), 'a js test');
      // The `(?:d\.)?` group: without it, even a TEST declaration file
      // escapes exclusion, because `.ts` admits it and `test.d.ts` breaks
      // the plain match.
      writeFileSync(join(cli, 'review', 'drive.test.d.ts'), 'export {};');
      // The NOT_BUNDLED_FILE entry and a snapshot dir, pinned on both sides.
      // The snapshot half exists only here: no `__snapshots__` directory
      // lives in the repo tree, so this synthetic one is the only pin. The
      // NOT_BUNDLED_FILE half is different — `lib/test-utils.ts` is a real
      // file in the tree, so the repo-level parity case above pins that rule
      // too; deleting the real file would silently drop that second pin and
      // leave only this synthetic one.
      writeFileSync(join(cli, 'review', 'lib', 'test-utils.ts'), 'test help');
      writeFileSync(join(cli, 'review', '.DS_Store'), 'finder droppings');
      mkdirSync(join(cli, 'review', '__snapshots__'), { recursive: true });
      // A digested extension and a non-test name: only the directory rule
      // can keep this out, where the `.snap` it replaced was already
      // rejected by the extension allowlist and pinned nothing.
      writeFileSync(
        join(cli, 'review', '__snapshots__', 'snapshot-helper.ts'),
        'exports[`a`] = `b`;',
      );
      mkdirSync(join(cli, 'review', '__fixtures__'), { recursive: true });
      writeFileSync(
        join(cli, 'review', '__fixtures__', 'responder.mjs'),
        'export const a = 1;',
      );
      // Stray files no build can fold into the bundle, pinned on both sides:
      // the allowlist is what ends this class, and a one-sided widening would
      // accuse a byte-for-byte correct bundle on one side of the boundary.
      writeFileSync(join(cli, 'review', 'drive.ts.orig'), 'rebase droppings');
      writeFileSync(join(cli, 'review', 'notes.md'), 'scratch');
      writeFileSync(join(skillDir, 'SKILL.md.orig'), 'droppings');
      writeFileSync(join(skillDir, 'scratch.txt'), 'x');
      expect(reviewSourceDigestForBuild(root).digest).toBe(
        reviewSourcesDigest(root, reviewSourceRoots(root)),
      );
      expect(reviewSourceDigestForBuild(root).count).toBe(12);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // chmod is the only lever this case has: on Windows it is a no-op, and a
  // root user reads through it, so the branch under test is unreachable
  // there. The case skips rather than measuring a readable tree and failing
  // red against the throw-and-nothing-measured assertions.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'neither side measures a tree whose subdirectory cannot be listed',
    () => {
      // The unreadable-DIRECTORY case, on both sides of the boundary at once:
      // the build refuses and the runtime check reports unmeasured, so neither
      // accuses a bundle that is merely unreadable. The tree holds two files,
      // because with exactly one, hashing the survivors and measuring nothing
      // are the same answer and a one-sided fix would keep both sides equal.
      const root = mkdtempSync(join(tmpdir(), 'digest-unreadable-'));
      try {
        const cli = join(root, 'packages', 'cli', 'src', 'commands');
        const lib = join(cli, 'review', 'lib');
        mkdirSync(lib, { recursive: true });
        mkdirSync(
          join(root, 'packages', 'core', 'src', 'skills', 'bundled', 'review'),
          { recursive: true },
        );
        writeFileSync(join(cli, 'review', 'drive.ts'), 'drives');
        writeFileSync(join(lib, 'ledger.ts'), 'ledgers');
        chmodSync(lib, 0o000);
        try {
          expect(() => reviewSourceDigestForBuild(root)).toThrow();
          expect(
            reviewSourcesDigest(root, reviewSourceRoots(root)),
          ).toBeUndefined();
        } finally {
          chmodSync(lib, 0o755);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('the skill allowlist covers everything the copier would ship', () => {
    // The copier copies all of a bundled skill but test files, DESIGN.md and
    // `.DS_Store`; the digest's skill root admits its extension allowlist. A
    // file the copier ships but the digest cannot see is a silent false
    // negative — the direction this whole check exists not to produce. The
    // skill ships a single markdown file today, so this holds; the day it
    // grows a script the allowlist must grow with it, and the failure belongs
    // here, not in a review that quietly stops noticing.
    const skillDir = join(
      repoRoot,
      'packages',
      'core',
      'src',
      'skills',
      'bundled',
      'review',
    );
    const shipped: string[] = [];
    const admitted: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          if (
            e.name !== '.DS_Store' &&
            e.name !== 'DESIGN.md' &&
            !BUNDLED_SKILL_TEST_FILE_RE.test(e.name)
          )
            shipped.push(full);
          if (
            DIGESTED_EXTENSIONS.skill.has(extname(e.name)) &&
            !NOT_BUNDLED_SKILL_FILE.has(e.name)
          )
            admitted.push(full);
        }
      }
    };
    walk(skillDir);
    expect(shipped.length).toBeGreaterThan(0);
    for (const f of shipped) {
      expect(DIGESTED_EXTENSIONS.skill.has(extname(f))).toBe(true);
    }
    // …and the reverse: nothing the digest folds in is a file the copier
    // skips. Today `skill = {.md}` makes the two lists equal; the day a code
    // extension joins the skill set, `SKILL.test.ts` becomes digested while
    // the copier does not ship it, and an edit to it would move the digest
    // without being able to change a byte of the bundle.
    expect(admitted).toEqual(shipped);
  });
});
