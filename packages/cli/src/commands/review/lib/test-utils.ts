/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PARSE_ARGS_REPORT } from './paths.js';
import { DIGEST_FILE } from './stale-bundle.js';

/** Seed the report `parse-args` tees, so the effort fallback has something to read. */
export function seedParseArgs(dir: string, effort: unknown): void {
  mkdirSync(join(dir, dirname(PARSE_ARGS_REPORT)), { recursive: true });
  writeFileSync(
    join(dir, PARSE_ARGS_REPORT),
    JSON.stringify({ effort, effortSource: 'flag' }),
    'utf8',
  );
}

/**
 * The fs calls the fixture builders make. Callers hand over their own
 * bindings: the parse-args suite mocks `node:fs` for the whole file, so
 * bindings this module imported itself would write into the mock instead of
 * the tree the check under test reads.
 */
export type FixtureFs = Pick<
  typeof import('node:fs'),
  'mkdtempSync' | 'mkdirSync' | 'writeFileSync'
>;

/**
 * A checkout-shaped tree holding all four review roots and a `dist/cli.js`
 * bundle — what the staleness check needs to reach a verdict. With only some
 * of the roots present the check answers 'could not check' instead.
 */
export function makeStaleBundleFixture(
  fs: FixtureFs,
  prefix: string,
): { repo: string; argv1: string } {
  const repo = fs.mkdtempSync(join(tmpdir(), prefix));
  fs.mkdirSync(join(repo, 'dist'), { recursive: true });
  const argv1 = join(repo, 'dist', 'cli.js');
  fs.writeFileSync(argv1, 'bundle');
  const commands = join(repo, 'packages', 'cli', 'src', 'commands');
  const reviewDir = join(commands, 'review');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(join(reviewDir, 'drive.ts'), 'the built behaviour');
  fs.writeFileSync(join(commands, 'review.ts'), 'registers');
  const services = join(repo, 'packages', 'cli', 'src', 'services');
  fs.mkdirSync(services, { recursive: true });
  fs.writeFileSync(
    join(services, 'review-worktree-lease.ts'),
    'leases the review worktree',
  );
  const skillDir = join(
    repo,
    'packages',
    'core',
    'src',
    'skills',
    'bundled',
    'review',
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(join(skillDir, 'SKILL.md'), '# skill');
  return { repo, argv1 };
}

/**
 * Well-formed (64 hex) but matching no real tree: a malformed stamp is
 * unmeasured, not stale, so the mismatch branch needs a plausible digest.
 */
export const FOREIGN_DIGEST = 'ab'.repeat(32);

/** Write (or overwrite) the stamp beside the fixture's bundle. */
export function stampDigest(fs: FixtureFs, repo: string, digest: string): void {
  fs.writeFileSync(join(repo, 'dist', DIGEST_FILE), digest);
}
