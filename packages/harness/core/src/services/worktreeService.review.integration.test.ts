/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Review-ref (GitHub PR / GitLab MR) coverage for worktree creation.
 *
 * Git 操作均真实执行；竞态用例仅在命令边界插入另一轮真实 fetch。
 *
 * A local bare repository stands in for the forge. Provider detection reads the
 * origin URL, so the fixture directory is named to contain "github"/"gitlab".
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import childProcess, {
  execFileSync,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { getOrCreateWorktree } from './worktreeService.js';

const tempPathSlug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
const reviewFetchRefRoot = `refs/${tempPathSlug}/worktree-fetch`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

interface Fixture {
  root: string;
  repoRoot: string;
  /** Commit that only exists under the review ref. */
  reviewSha: string;
}

/**
 * Build a clone whose origin exposes `refName` pointing at a commit that is not
 * reachable from any branch, so a successful checkout proves the fetch happened.
 */
async function createReviewFixture(
  forgeName: string,
  refName: string,
): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-review-'));
  const originPath = path.join(root, `${forgeName}-origin.git`);
  const seedPath = path.join(root, 'seed');
  const repoRoot = path.join(root, 'clone');

  git(root, 'init', '-q', '--bare', '-b', 'main', originPath);

  await fs.mkdir(seedPath, { recursive: true });
  git(seedPath, 'init', '-q', '-b', 'main');
  git(seedPath, 'config', 'user.email', 'review@test.invalid');
  git(seedPath, 'config', 'user.name', 'Review Test');
  git(seedPath, 'config', 'core.hooksPath', '/dev/null');
  await fs.writeFile(path.join(seedPath, 'base.txt'), 'base\n');
  git(seedPath, 'add', '-A');
  git(seedPath, 'commit', '-qm', 'base');
  git(seedPath, 'remote', 'add', 'origin', originPath);
  git(seedPath, 'push', '-q', 'origin', 'main');

  // The review commit lives only under refName, never on a branch.
  await fs.writeFile(path.join(seedPath, 'review-only.txt'), 'from review\n');
  git(seedPath, 'add', '-A');
  git(seedPath, 'commit', '-qm', 'review change');
  const reviewSha = git(seedPath, 'rev-parse', 'HEAD').trim();
  git(seedPath, 'push', '-q', 'origin', `HEAD:${refName}`);
  git(seedPath, 'reset', '-q', '--hard', 'HEAD~1');

  git(root, 'clone', '-q', originPath, repoRoot);
  git(repoRoot, 'config', 'user.email', 'review@test.invalid');
  git(repoRoot, 'config', 'user.name', 'Review Test');
  git(repoRoot, 'config', 'core.hooksPath', '/dev/null');

  return { root, repoRoot, reviewSha };
}

describe(
  'getOrCreateWorktree review refs (real git)',
  // Each case builds a bare origin, a seed clone, and fetches a review ref.
  // The repository-root vitest config does not raise the default 5s timeout.
  { timeout: 60_000 },
  () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    while (fixtures.length > 0) {
      const dir = fixtures.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fetches a GitHub pull request head', async () => {
    const fixture = await createReviewFixture('github', 'refs/pull/11/head');
    fixtures.push(fixture.root);

    const result = await getOrCreateWorktree(fixture.repoRoot, 'pr-11', {
      prNumber: 11,
    });

    expect(result.headCommit).toBe(fixture.reviewSha);
    await expect(
      fs.readFile(path.join(result.worktreePath, 'review-only.txt'), 'utf-8'),
    ).resolves.toBe('from review\n');
  });

  it('fetches a GitLab merge request head', async () => {
    const fixture = await createReviewFixture(
      'gitlab',
      'refs/merge-requests/22/head',
    );
    fixtures.push(fixture.root);

    const result = await getOrCreateWorktree(fixture.repoRoot, 'pr-22', {
      prNumber: 22,
    });

    expect(result.headCommit).toBe(fixture.reviewSha);
    await expect(
      fs.readFile(path.join(result.worktreePath, 'review-only.txt'), 'utf-8'),
    ).resolves.toBe('from review\n');
  });

  it.each(['after-fetch', 'before-checkout'] as const)(
    'keeps the requested review commit when another fetch runs %s',
    async (boundary) => {
      const fixture = await createReviewFixture('github', 'refs/pull/11/head');
      fixtures.push(fixture.root);
      const execFile = childProcess.execFile;
      let interfered = false;
      let fetchedRefspec: string | undefined;
      const interfere = () => {
        if (interfered) return;
        interfered = true;
        git(fixture.repoRoot, 'fetch', 'origin', 'main');
      };
      vi.spyOn(childProcess, 'execFile').mockImplementation(((
        command: string,
        args: readonly string[],
        options: ExecFileOptionsWithStringEncoding,
        callback: (
          error: ExecFileException | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        fetchedRefspec ??= args.find((arg) => arg.startsWith('pull/11/head:'));
        if (boundary === 'before-checkout' && args.includes('add')) interfere();
        return execFile(command, args, options, (error, stdout, stderr) => {
          if (
            boundary === 'after-fetch' &&
            !error &&
            args.some((arg) => arg.startsWith('pull/11/head'))
          )
            interfere();
          callback(error, stdout, stderr);
        });
      }) as typeof execFile);
      syncBuiltinESMExports();

      const result = await getOrCreateWorktree(fixture.repoRoot, 'pr-11', {
        prNumber: 11,
      });

      expect(interfered).toBe(true);
      expect(fetchedRefspec).toEqual(
        expect.stringContaining(`pull/11/head:${reviewFetchRefRoot}/`),
      );
      expect(result.headCommit).toBe(fixture.reviewSha);
      expect(git(result.worktreePath, 'rev-parse', 'HEAD').trim()).toBe(
        fixture.reviewSha,
      );
      await expect(
        fs.readFile(path.join(result.worktreePath, 'review-only.txt'), 'utf-8'),
      ).resolves.toBe('from review\n');
      expect(
        git(
          fixture.repoRoot,
          'for-each-ref',
          '--format=%(refname)',
          reviewFetchRefRoot,
        ).trim(),
      ).toBe('');
    },
  );

  it('reports a helpful error when the review ref does not exist', async () => {
    const fixture = await createReviewFixture('github', 'refs/pull/11/head');
    fixtures.push(fixture.root);

    await expect(
      getOrCreateWorktree(fixture.repoRoot, 'pr-999', { prNumber: 999 }),
    ).rejects.toThrow(/Failed to fetch PR\/MR #999/);
    expect(
      git(
        fixture.repoRoot,
        'for-each-ref',
        '--format=%(refname)',
        reviewFetchRefRoot,
      ).trim(),
    ).toBe('');
  });

    it('ignores baseRef when a review number is requested', async () => {
      // `head` must not win over an explicit PR/MR: the user asked for the
      // review branch, not the local checkout.
      const fixture = await createReviewFixture('github', 'refs/pull/33/head');
      fixtures.push(fixture.root);

      const result = await getOrCreateWorktree(fixture.repoRoot, 'pr-33', {
        prNumber: 33,
        baseRef: 'head',
      });

      expect(result.headCommit).toBe(fixture.reviewSha);
    });
  },
);
