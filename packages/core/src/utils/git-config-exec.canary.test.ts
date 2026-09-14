/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// One property, asked of every git call a session reaches without the user
// asking for it: a repository that plants a program-valued key in its own
// `.git/config` must not get that program run.
//
// The fixture is the attack, not a shape — a real repository carrying a real
// plant, plus a canary the plant writes — and the control cases assert the
// canary IS written when the same command runs ungated. A fixture that quietly
// stops being an attack then fails here instead of certifying the guards it
// walked around.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRecentGitStatus } from './gitUtils.js';
import { getGitWorkingTreeStatus } from './gitDiff.js';
import { isGitIgnored } from './git-ignore.js';
import { GitWorktreeService } from '../services/gitWorktreeService.js';
import { __test__ as worktreeCleanupInternals } from '../services/worktreeCleanup.js';

// The plant is a `/bin/sh` script, so the attack itself does not exist on
// Windows and the question has no answer there.
const itWherePlantRuns = it.skipIf(process.platform === 'win32');

// Each case builds a repository and spawns a handful of git processes, which
// blows the package's 15s local ceiling under coverage on a loaded machine.
const PLANT_TIMEOUT_MS = 30_000;

/** The program-valued keys a tree obtained as files can carry. */
type Plant =
  | 'core.fsmonitor'
  | 'diff.external'
  | 'diff.pwn.textconv'
  | 'gpg.program'
  | 'post-index-change';

const DIFF_PLANTS: Plant[] = ['diff.external', 'diff.pwn.textconv'];

describe('a planted git program reaches no automatic git call', () => {
  const made: string[] = [];

  beforeEach(() => {
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A repository whose own config names a helper that writes `canary`, with one
   * tracked file dirty so the index refresh actually re-stats and the diff has
   * content to render.
   */
  const planted = (plant: Plant = 'core.fsmonitor') => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-fsmonitor-')));
    made.push(repo);
    const canary = join(repo, 'PWNED');
    // Hermetic setup: a host global `core.hooksPath` would otherwise run the
    // developer's own hooks on this commit.
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const g = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    // Committed with the tree, which is how the textconv plant gets bound to a
    // path — `diff.pwn.textconv` alone does nothing without this.
    writeFileSync(join(repo, '.gitattributes'), 'a.ts diff=pwn\n');
    g('add', 'a.ts', '.gitignore', '.gitattributes');
    g('commit', '-qm', 'init');

    const helper =
      plant === 'post-index-change'
        ? join(repo, '.git', 'hooks', 'post-index-change')
        : join(repo, 'plant.sh');
    // An fsmonitor helper reports "trust nothing" by failing, so the status
    // stays correct; a textconv or external diff helper is expected to exit
    // clean and hand git the rendered content on stdout.
    writeFileSync(
      helper,
      plant === 'core.fsmonitor' || plant === 'gpg.program'
        ? `#!/bin/sh\ntouch '${canary}'\nexit 1\n`
        : `#!/bin/sh\ntouch '${canary}'\ncat /dev/null\n`,
    );
    chmodSync(helper, 0o755);
    if (plant === 'gpg.program') {
      g('config', 'gpg.program', helper);
      g('config', 'log.showSignature', 'true');
      const parent = g('rev-parse', 'HEAD');
      const tree = g('rev-parse', 'HEAD^{tree}');
      const signedCommit = [
        `tree ${tree}`,
        `parent ${parent}`,
        'author t <t@t.t> 0 +0000',
        'committer t <t@t.t> 0 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' fake',
        ' -----END PGP SIGNATURE-----',
        '',
        'signed',
        '',
      ].join('\n');
      const oid = execFileSync(
        'git',
        ['hash-object', '-t', 'commit', '-w', '--stdin'],
        { cwd: repo, encoding: 'utf8', env, input: signedCommit },
      ).trim();
      g('update-ref', 'HEAD', oid);
    } else if (plant !== 'post-index-change') {
      g('config', plant, helper);
    }
    // A dirty tracked file: the refresh only re-stats what changed.
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');

    const fired = () => {
      const hit = existsSync(canary);
      if (hit) unlinkSync(canary);
      return hit;
    };
    return { repo, fired };
  };

  itWherePlantRuns(
    'the fixture is a live attack: an ungated status runs the plant',
    () => {
      const { repo, fired } = planted();
      // The exact command `getRecentGitStatus` used to run. `--no-optional-locks`
      // is kept to pin that it does NOT suppress the hook.
      execFileSync(
        'git',
        ['--no-optional-locks', 'status', '--short', '--branch'],
        { cwd: repo, encoding: 'utf8' },
      );
      expect(fired()).toBe(true);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'startup context collection does not run it',
    () => {
      const { repo, fired } = planted();
      const snapshot = getRecentGitStatus(repo);
      expect(fired()).toBe(false);
      // The guard must not have cost the output it exists to produce.
      expect(snapshot).toContain('Current branch: main');
      expect(snapshot).toContain('a.ts');
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'the gpg fixture is a live attack: an ungated log runs the plant',
    () => {
      const { repo, fired } = planted('gpg.program');
      execFileSync('git', ['log', '--oneline', '-n', '5'], { cwd: repo });
      expect(fired()).toBe(true);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'startup context collection does not run a configured gpg program',
    () => {
      const { repo, fired } = planted('gpg.program');
      const snapshot = getRecentGitStatus(repo);
      expect(fired()).toBe(false);
      expect(snapshot).toContain('Current branch: main');
      expect(snapshot).toContain('signed');
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'the working-tree status behind the daemon routes does not run it',
    async () => {
      const { repo, fired } = planted();
      // Every git call in `gitDiff` goes through one `runGit`, so guarding it
      // there covers the index-refreshing ones — `status`, `ls-files`, `diff`,
      // `diff-tree` — along with any call site added later.
      const status = await getGitWorkingTreeStatus(repo);
      expect(fired()).toBe(false);
      expect(status?.branch).toBe('main');
      expect(status?.unstaged).toBe(1);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'the ignore probe does not run it',
    () => {
      const { repo, fired } = planted();
      expect(isGitIgnored(repo, 'ignored.txt')).toBe(true);
      expect(fired()).toBe(false);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns.each(['core.fsmonitor', 'post-index-change'] as const)(
    'the stale-worktree cleanup probe does not run %s',
    async (plant) => {
      const { repo, fired } = planted(plant);
      // `hasTrackedChanges` fail-closes to `true`, so asserting only the dirty
      // answer cannot tell a real status read from a swallowed git error. Read
      // the clean tree first: only a successful `status` can return `false`.
      writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
      expect(await worktreeCleanupInternals.hasTrackedChanges(repo)).toBe(
        false,
      );
      writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
      expect(await worktreeCleanupInternals.hasTrackedChanges(repo)).toBe(true);
      expect(fired()).toBe(false);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns.each(['core.fsmonitor', 'post-index-change'] as const)(
    'the exit-tool dirty probes do not run %s',
    async (plant) => {
      const { repo, fired } = planted(plant);
      const service = new GitWorktreeService(repo);
      expect(await service.hasWorktreeChanges(repo)).toBe(true);
      expect(fired()).toBe(false);
      // Both probes swallow git errors into their fail-closed answer, so a
      // broken guard would look identical here — the counts are what shows the
      // status was actually read.
      expect(await service.countWorktreeChanges(repo)).toEqual({
        tracked: 1,
        untracked: plant === 'core.fsmonitor' ? 1 : 0,
      });
      expect(fired()).toBe(false);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'the exit-tool probes inherit the environment and read the global excludesFile',
    async () => {
      const { repo } = planted('post-index-change');
      // A clean tracked tree plus one untracked `*.log` that a global
      // `core.excludesFile` ignores. If the probe clobbered the child
      // environment (`.env('GIT_OPTIONAL_LOCKS', '0')` replaces it outright),
      // git would never read this config and would report the file untracked.
      // The config and ignore files live OUTSIDE the repo so they do not
      // themselves show up as untracked entries.
      writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
      writeFileSync(join(repo, 'x.log'), 'ignored noise\n');
      const outside = mkdtempSync(join(tmpdir(), 'qwen-globalcfg-'));
      made.push(outside);
      const ignoreFile = join(outside, 'global-ignore');
      writeFileSync(ignoreFile, '*.log\n');
      const globalConfig = join(outside, 'global-config');
      writeFileSync(globalConfig, `[core]\n  excludesFile = ${ignoreFile}\n`);
      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);

      const service = new GitWorktreeService(repo);
      expect(await service.hasWorktreeChanges(repo)).toBe(false);
      expect(await service.countWorktreeChanges(repo)).toEqual({
        tracked: 0,
        untracked: 0,
      });
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'the exit-tool probes pin --untracked-files=all so a hidden untracked mode cannot read a worktree clean',
    async () => {
      const { repo, fired } = planted('post-index-change');
      // Clean the tracked file and leave a single untracked file. An ambient
      // `status.showUntrackedFiles=no` (a user's `~/.gitconfig`, or a
      // tree-shipped `.git/config` a linked worktree inherits) would make a
      // bare `status --porcelain` read the worktree clean and destroy the
      // untracked output — unless the probe pins `--untracked-files=all`.
      writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
      execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
        cwd: repo,
        encoding: 'utf8',
      });
      writeFileSync(join(repo, 'agent-output.ts'), 'untracked agent output\n');

      const service = new GitWorktreeService(repo);
      expect(await service.hasWorktreeChanges(repo)).toBe(true);
      expect(await service.countWorktreeChanges(repo)).toEqual({
        tracked: 0,
        untracked: 1,
      });
      expect(fired()).toBe(false);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'the post-index-change fixture is a live attack: an ungated status runs it',
    () => {
      const { repo, fired } = planted('post-index-change');
      execFileSync('git', ['status', '--porcelain'], { cwd: repo });
      expect(fired()).toBe(true);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns(
    'staging a worktree to diff it does not run it',
    async () => {
      const { repo, fired } = planted();
      // This path stages everything, diffs against the base and resets — and
      // `add --all`, `diff` and `reset` were each measured to refresh the
      // index, so guarding only the read-only commands would leave it open.
      const diff = await new GitWorktreeService(repo).getWorktreeDiff(
        repo,
        'main',
      );
      expect(fired()).toBe(false);
      expect(diff).not.toContain('Error getting diff');
      expect(diff).toContain('a.ts');
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns.each(DIFF_PLANTS)(
    'the %s fixture is a live attack: an ungated diff runs it',
    (plant) => {
      const { repo, fired } = planted(plant);
      // The exact pair of commands the worktree diff path runs.
      execFileSync('git', ['add', '--all'], { cwd: repo });
      execFileSync('git', ['diff', '--binary', '--cached', 'main'], {
        cwd: repo,
      });
      expect(fired()).toBe(true);
    },
    PLANT_TIMEOUT_MS,
  );

  itWherePlantRuns.each(DIFF_PLANTS)(
    'a planted %s does not run when a worktree is diffed',
    async (plant) => {
      const { repo, fired } = planted(plant);
      const diff = await new GitWorktreeService(repo).getWorktreeDiff(
        repo,
        'main',
      );
      expect(fired()).toBe(false);
      expect(diff).not.toContain('Error getting diff');
      expect(diff).toContain('a.ts');
    },
    PLANT_TIMEOUT_MS,
  );
});
