/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The review source digest is computed twice: once by the build, which stamps
// it beside the bundle, and once by the review commands (`parse-args`, and
// `drive` for a resumed run), which re-derive it from the tree and compare.
// A rule stated twice is a rule that will be true in one
// place, and the two cannot share code — the build script runs before the
// package it would import has been built. So this is the test that keeps them
// equal, and it lives here because a package test is not allowed to reach into
// `scripts/`. It runs under `npm run test:scripts` (part of `npm run
// test:ci`), not `npm test` — a digest change verified only against the
// package suite never reaches it.

import { describe, expect, it } from 'vitest';
import {
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
      writeFileSync(join(cli, 'review', 'drive.ts'), 'drives');
      writeFileSync(join(cli, 'review', 'lib', 'ledger.ts'), 'ledgers');
      writeFileSync(join(skillDir, 'SKILL.md'), '# skill');
      writeFileSync(join(skillDir, 'DESIGN.md'), '# design');

      expect(reviewSourceDigestForBuild(root).digest).toBe(
        reviewSourcesDigest(root, reviewSourceRoots(root)),
      );
      expect(reviewSourceDigestForBuild(root).count).toBe(5);

      // ...and neither a test file, nor a spec, nor a fixture moves either.
      writeFileSync(join(cli, 'review', 'drive.test.ts'), 'a test');
      writeFileSync(join(cli, 'review', 'drive.spec.tsx'), 'a spec');
      // The `[cm]?` group, pinned on both sides: the two files above would
      // still agree if one side lost the `c` or the `m`, so a one-sided edit
      // there used to pass both parity cases.
      writeFileSync(join(cli, 'review', 'drive.test.mts'), 'an mts test');
      writeFileSync(join(cli, 'review', 'drive.spec.cts'), 'a cts spec');
      // The NOT_BUNDLED_FILE entry and a snapshot dir, pinned on both sides:
      // neither exists in the repo tree, so only a synthetic one can catch a
      // one-sided edit to either.
      writeFileSync(join(cli, 'review', 'lib', 'test-utils.ts'), 'test help');
      writeFileSync(join(cli, 'review', '.DS_Store'), 'finder droppings');
      mkdirSync(join(cli, 'review', '__snapshots__'), { recursive: true });
      writeFileSync(
        join(cli, 'review', '__snapshots__', 'x.test.ts.snap'),
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
      expect(reviewSourceDigestForBuild(root).count).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the skill allowlist covers everything the copier would ship', () => {
    // The copier copies all of a bundled skill but test files and `.DS_Store`;
    // the digest's skill root admits its extension allowlist. A file the
    // copier ships but the digest cannot see is a silent false negative — the
    // direction this whole check exists not to produce. The skill is two
    // markdown files today, so this holds; the day it grows a script the
    // allowlist must grow with it, and the failure belongs here, not in a
    // review that quietly stops noticing.
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
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (
          e.isFile() &&
          e.name !== '.DS_Store' &&
          !BUNDLED_SKILL_TEST_FILE_RE.test(e.name)
        )
          shipped.push(full);
      }
    };
    walk(skillDir);
    expect(shipped.length).toBeGreaterThan(0);
    for (const f of shipped) {
      expect(DIGESTED_EXTENSIONS.skill.has(extname(f))).toBe(true);
    }
  });
});
