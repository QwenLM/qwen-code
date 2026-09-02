/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

/**
 * Redirect the review settings the phase gates read away from the operator's
 * own — the same shape as `isolateHostGitConfig`, for the same reason.
 *
 * `review.sandbox` is a setting a maintainer turns on for their OWN reviews,
 * and the gates then correctly refuse to run anything uncontained. Under
 * `required` that refusal is the right answer to give a review and the wrong
 * answer to give a fixture: 101 tests across this directory stop measuring
 * what they are about and start reporting the operator's preference back at
 * them. `QWEN_HOME` is the lever because policy is the STRICTEST of settings
 * and environment, so no environment value can loosen a settings-side opt-in.
 *
 * Call in beforeEach and `dispose()` in afterEach.
 */
export function isolateOperatorReviewSettings(): {
  home: string;
  dispose: () => void;
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-review-home-')));
  const saved = process.env['QWEN_HOME'];
  process.env['QWEN_HOME'] = home;
  return {
    home,
    dispose() {
      if (saved === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = saved;
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
 * A diff adding `n` lines to a new file, shaped like real source: top-level
 * declarations separated by blank lines, so the planner has somewhere to cut.
 */
export function makeDiff(path: string, n: number): string {
  const body: string[] = [];
  while (body.length < n) {
    body.push(`+function f${body.length}() {`);
    for (let k = 0; k < 8 && body.length < n; k++)
      body.push(`+  const x = ${k};`);
    body.push('+}');
    body.push('+');
  }
  body.length = n;
  return [
    `diff --git a/${path} b/${path}`,
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${n} @@`,
    ...body,
    '',
  ].join('\n');
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
 * A checkout-shaped tree holding all the review roots and a `dist/cli.js`
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
  const utils = join(repo, 'packages', 'cli', 'src', 'utils');
  fs.mkdirSync(utils, { recursive: true });
  fs.writeFileSync(join(utils, 'findings.ts'), 'validates the findings');
  fs.writeFileSync(join(utils, 'shell-args.ts'), 'tokenizes the args');
  fs.writeFileSync(join(utils, 'paths.ts'), 'flattens the slug');
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

/**
 * The admin entry `<tree>/.git` names, spelled the way git spelled it.
 *
 * Read rather than derived: the gates ask git where the repository is, so a
 * fixture that guesses the entry's path can build a plant git never resolves.
 */
export function adminEntryOf(tree: string): string {
  return readFileSync(join(tree, '.git'), 'utf8')
    .trim()
    .replace('gitdir: ', '');
}

/**
 * A repository the reviewed code planted, carrying a content filter git
 * EXECUTES. The oracle every host-execution witness shares, so a fixture that
 * quietly stops being an attack fails in one place instead of in each suite.
 *
 * `filter` names the driver to arm, because the routes differ in what makes
 * git run one: `clean` (the default) for the READ routes, where an index
 * refresh re-hashes a file whose stat changed and re-hashing runs the clean
 * filter; `smudge` for the CHECKOUT routes; `process` where a suite has to
 * slip past the repo-local `smudge|clean` screen and still execute. `clean`
 * and `smudge` pass the content through — a filter that swallows it turns the
 * command into a different failure than the one under test.
 *
 * The marker goes in `info/attributes`, not a `.gitattributes`: the tree's own
 * working files are not the subject, and a tracked one would show up as residue.
 */
export function plantRepository(
  dir: string,
  from: string,
  canary: string,
  filter: 'clean' | 'smudge' | 'process' = 'clean',
): string {
  cpSync(from, dir, { recursive: true });
  // The copy carries the real repository's admin entries; leaving them makes
  // the plant answer for trees it was never given.
  rmSync(join(dir, 'worktrees'), { recursive: true, force: true });
  const command =
    filter === 'process'
      ? `sh -c "echo PWNED > ${canary}"`
      : `sh -c "echo PWNED > ${canary}; cat"`;
  appendFileSync(
    join(dir, 'config'),
    `\n[filter "evil"]\n\t${filter} = ${command}\n`,
  );
  mkdirSync(join(dir, 'info'), { recursive: true });
  writeFileSync(join(dir, 'info', 'attributes'), '* filter=evil\n');
  return dir;
}

/**
 * Rewrite `<tree>/.git` to name an admin entry the reviewed code planted,
 * copying `from` so the plant is coherent: it round-trips, and `rev-parse`
 * through it answers the shas the identity gates pin.
 *
 * The backpointer in `<entry>/gitdir` is BARE, which is the only form git
 * writes there. The `gitdir: ` prefix belongs to the TREE's own `.git` file; a
 * prefixed backpointer fails the round-trip identity check the residue and
 * probe-tree routes run first, which turns a witness into a green statement
 * about the wrong refusal.
 */
export function plantAdminEntry(
  entry: string,
  from: string,
  tree: string,
  commonDir: string,
): string {
  cpSync(from, entry, { recursive: true });
  writeFileSync(join(entry, 'commondir'), `${commonDir}\n`);
  writeFileSync(join(entry, 'gitdir'), `${join(tree, '.git')}\n`);
  rmSync(join(tree, '.git'), { force: true });
  writeFileSync(join(tree, '.git'), `gitdir: ${entry}\n`);
  return entry;
}
