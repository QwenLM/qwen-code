/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PARSE_ARGS_REPORT } from './paths.js';
import { DIGEST_FILE } from './stale-bundle.js';

/**
 * Redirect every git the process (and its children) spawns away from the
 * host's real config: a throwaway HOME + GIT_CONFIG_GLOBAL, and
 * GIT_CONFIG_NOSYSTEM=1 for the system file. Call in beforeEach and
 * `dispose()` in afterEach. Without this a fixture suite inherits whatever
 * the host accumulated: a global `commit.gpgsign=true` fails every fixture
 * commit for want of a key, a global `core.hooksPath` executes host hooks
 * on each commit, and a global `diff.external` kills plain `git diff` —
 * the incident class from run 31516789251, where a persistent CI runner's
 * polluted ~/.gitconfig failed suites the branch never touched. The home
 * path is realpath'd so suites can compare it against paths git reports.
 */
export function isolateHostGitConfig(): {
  home: string;
  dispose: () => void;
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'git-isolated-home-')));
  writeFileSync(join(home, '.gitconfig'), '');
  const savedEnv = { ...process.env };
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
  process.env['HOME'] = home;
  return {
    home,
    dispose() {
      process.env = savedEnv;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

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
