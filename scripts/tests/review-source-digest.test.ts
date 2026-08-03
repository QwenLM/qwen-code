/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The review source digest is computed twice: once by the build, which stamps
// it beside the bundle, and once by `parse-args`, which re-derives it from the
// tree and compares. A rule stated twice is a rule that will be true in one
// place, and the two cannot share code — the build script runs before the
// package it would import has been built. So this is the test that keeps them
// equal, and it lives here because a package test is not allowed to reach into
// `scripts/`.

import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reviewSourceDigestForBuild } from '../copy_bundle_assets.js';
import {
  DIGEST_FILE,
  reviewSourceRoots,
  reviewSourcesDigest,
} from '../../packages/cli/src/commands/review/lib/stale-bundle.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** The literal `copy_bundle_assets.js` writes. Read from the built artifact
 *  below rather than copied by hand, so this cannot agree by coincidence. */
const STAMP_FILENAME_IN_BUILD = readFileSync(
  join(repoRoot, 'scripts', 'copy_bundle_assets.js'),
  'utf8',
).match(/writeFileSync\(\s*join\(distDir, '([^']+)'\)/)?.[1];

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
    expect(DIGEST_FILE).toBe(STAMP_FILENAME_IN_BUILD);
  });

  it('counts the same files', () => {
    // Same digest with different file sets is not possible in practice, but
    // the count is what a build log shows a human, so it is worth being the
    // same number.
    const { count } = reviewSourceDigestForBuild(repoRoot);
    expect(count).toBeGreaterThan(50);
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
      writeFileSync(join(cli, 'review.ts'), 'registers everything');
      writeFileSync(join(cli, 'review', 'drive.ts'), 'drives');
      writeFileSync(join(cli, 'review', 'lib', 'ledger.ts'), 'ledgers');
      writeFileSync(
        join(root, 'packages/core/src/skills/bundled/review/SKILL.md'),
        '# skill',
      );

      expect(reviewSourceDigestForBuild(root).digest).toBe(
        reviewSourcesDigest(root, reviewSourceRoots(root)),
      );
      expect(reviewSourceDigestForBuild(root).count).toBe(4);

      // ...and neither a test file, nor a spec, nor a fixture moves either.
      writeFileSync(join(cli, 'review', 'drive.test.ts'), 'a test');
      writeFileSync(join(cli, 'review', 'drive.spec.tsx'), 'a spec');
      mkdirSync(join(cli, 'review', '__fixtures__'), { recursive: true });
      writeFileSync(
        join(cli, 'review', '__fixtures__', 'responder.mjs'),
        'export const a = 1;',
      );
      expect(reviewSourceDigestForBuild(root).digest).toBe(
        reviewSourcesDigest(root, reviewSourceRoots(root)),
      );
      expect(reviewSourceDigestForBuild(root).count).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
