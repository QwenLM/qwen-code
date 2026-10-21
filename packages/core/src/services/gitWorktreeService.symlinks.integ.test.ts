/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `GitWorktreeService.symlinkConfiguredDirectories()`
 * (Phase D-2). Uses real git invocations + real `fs.symlink` against a
 * temp repo because the unit-test file mocks simple-git too heavily to
 * exercise the actual symlink loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitWorktreeService } from './gitWorktreeService.js';

async function initRepo(dir: string): Promise<void> {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
    cwd: dir,
  });
}

/** Creates `<dir>/<file>` holding `body`. */
async function mkdirWith(dir: string, file: string, body: string) {
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, file), body);
}

const exists = (p: string) =>
  fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);

const isSymlink = (p: string) =>
  fs
    .lstat(p)
    .then((s) => s.isSymbolicLink())
    .catch(() => false);

describe('GitWorktreeService.createUserWorktree() — symlinkDirectories', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  // The repo lives one level DOWN inside a per-test parent dir so that
  // tests needing a sibling of the repo (`../foo` traversal coverage)
  // have a private place to put it. Rooting the repo directly at
  // `os.tmpdir()` would make `path.dirname(repoRoot)` the machine-wide
  // temp dir, where a fixed sibling name collides with any concurrent
  // run on the same host — and stays behind forever once a run is
  // killed mid-test, wedging every later run on that machine.
  let repoParent: string;
  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-symlinks-'));
    // Resolve symlinks (macOS /var → /private/var) so path comparisons
    // line up with what GitWorktreeService produces internally.
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    await initRepo(repoRoot);
  });

  afterEach(async () => {
    // Removes the repo AND anything a test parked beside it.
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  /** Creates worktree `slug` off main, asserts success, returns the result. */
  async function create(
    slug: string,
    symlinkDirectories: string[],
    root = repoRoot,
  ) {
    const service = new GitWorktreeService(root);
    const result = await service.createUserWorktree(slug, 'main', {
      symlinkDirectories,
    });
    expect(result.success).toBe(true);
    return result;
  }

  it('symlinks a configured directory into the new worktree', async () => {
    // Create a fake node_modules in the main repo so there's something
    // to link.
    const nm = path.join(repoRoot, 'node_modules');
    await mkdirWith(nm, 'marker', 'real');

    const result = await create('linked', ['node_modules']);
    expect(result.worktree).toBeDefined();

    const dest = path.join(result.worktree!.path, 'node_modules');
    expect(await fs.readlink(dest)).toBe(nm);
    // Reading through the symlink resolves to the real file.
    expect(await fs.readFile(path.join(dest, 'marker'), 'utf8')).toBe('real');
  });

  it('silently skips a missing source directory', async () => {
    // Worktree creation still succeeds.
    const result = await create('missing-source', ['does-not-exist']);
    expect(result.worktree).toBeDefined();
    // Nothing was created at the would-be destination.
    const dest = path.join(result.worktree!.path, 'does-not-exist');
    expect(await exists(dest)).toBe(false);
  });

  it('silently skips an existing destination (no overwrite)', async () => {
    await mkdirWith(path.join(repoRoot, 'node_modules'), 'marker', 'real');

    // `git worktree add` creates the worktree dir, so it cannot be
    // pre-populated before creation, and a second create at the same slug
    // fails (the branch exists). In practice this case is reachable only when
    // a user pre-populates the worktree (e.g. via a custom checkout hook).
    // Simulate it: create the worktree with no symlinks, hand-place a
    // node_modules dir under it, then call the private
    // symlinkConfiguredDirectories directly.
    const service = new GitWorktreeService(repoRoot);
    const first = await service.createUserWorktree('preexisting', 'main', {
      symlinkDirectories: [],
    });
    expect(first.success).toBe(true);
    const wt = first.worktree!.path;
    await mkdirWith(path.join(wt, 'node_modules'), 'preexisting', 'wins');

    // TypeScript collapses the class intersected with a redeclared-as-public
    // method to `never`, so describe ONLY the method's shape and double-cast
    // through `unknown` to bypass the private check at test time.
    type SymlinkProbe = {
      symlinkConfiguredDirectories: (
        worktreePath: string,
        configured: readonly string[],
      ) => Promise<void>;
    };
    await (service as unknown as SymlinkProbe).symlinkConfiguredDirectories(
      wt,
      ['node_modules'],
    );

    // The preexisting file survived — no overwrite happened.
    const marker = await fs.readFile(
      path.join(wt, 'node_modules', 'preexisting'),
      'utf8',
    );
    expect(marker).toBe('wins');
    // And `wt/node_modules` is still the original dir, not a symlink to the
    // main repo's node_modules.
    const stat = await fs.lstat(path.join(wt, 'node_modules'));
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it('rejects absolute paths', async () => {
    const result = await create('abs', ['/etc']);
    // Nothing at /etc-named inside the worktree.
    expect(await exists(path.join(result.worktree!.path, 'etc'))).toBe(false);
  });

  it('rejects paths that traverse outside the repo root', async () => {
    // Put a sibling directory next to the repo so `../sibling` resolves to
    // something real — proving the guard fires on traversal shape rather
    // than on "source missing". `path.dirname(repoRoot)` is this test's
    // own parent temp dir, so the fixed name below is private to this
    // run: no cross-run collision, and afterEach reclaims it even if the
    // process is killed before the cleanup below.
    const siblingDir = path.join(path.dirname(repoRoot), 'qwen-wt-sibling');

    try {
      await mkdirWith(siblingDir, 'marker', 'outside');
      const result = await create('traverse', ['../qwen-wt-sibling']);
      // No symlink was created inside the worktree directory.
      const stat = await fs
        .lstat(path.join(result.worktree!.path, 'qwen-wt-sibling'))
        .catch(() => null);
      expect(stat).toBeNull();
      // Sibling itself is untouched.
      const marker = await fs.readFile(path.join(siblingDir, 'marker'), 'utf8');
      expect(marker).toBe('outside');
    } finally {
      await fs.rm(siblingDir, { recursive: true, force: true });
    }
  });

  it('rejects paths inside .git (security guard)', async () => {
    // `.git` is git-internal; symlinking any of it into the worktree
    // would shadow the worktree's gitlink file and silently break
    // commits / status / diff. Verify the guard fires.
    const result = await create('reject-git', ['.git/hooks']);
    // Nothing at <worktree>/.git/hooks beyond what `git worktree add`
    // itself populates — and certainly NOT a symlink that we wrote.
    // The guard rejects pre-mkdir, so no `hooks` entry should exist
    // (the worktree gets its own per-worktree .git file, not directory).
    const hooks = path.join(result.worktree!.path, '.git', 'hooks');
    expect(await isSymlink(hooks)).toBe(false);
  });

  it('rejects paths inside .qwen (security guard)', async () => {
    // `.qwen` is CLI metadata: symlinking `.qwen/worktrees` would create
    // a worktrees-inside-worktrees loop; symlinking `.qwen/projects` or
    // `.qwen/tmp` would alias session metadata users have no legitimate
    // reason to share across worktrees. Guard rejects the whole subtree.
    await fs.mkdir(path.join(repoRoot, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.qwen', 'projects'), 'data');

    const result = await create('reject-qwen', ['.qwen/projects']);
    // No symlink at <worktree>/.qwen/projects.
    const dest = path.join(result.worktree!.path, '.qwen', 'projects');
    expect(await isSymlink(dest)).toBe(false);
  });

  it('works when the repo path itself contains a symlink boundary (round-7 self-inflicted regression guard)', async () => {
    // Round 7 introduced `realSource = await fs.realpath(sourceAbs)` and
    // compared it against `repoRootAbs = path.resolve(sourceRepoPath)` —
    // canonical vs lexical. On any system where the user's repo path
    // contains a symlink component (macOS /tmp → /private/tmp, or a
    // user-symlinked source tree on Linux/Windows), the prefixes diverge
    // and `isWithinRoot` silently rejects EVERY configured entry.
    //
    // This guard provisions the same shape independently of the
    // shared beforeEach (which realpaths `repoRoot` upfront, masking
    // the bug). We point `GitWorktreeService` at a symlink path so
    // `sourceRepoPath` differs from its canonical realpath.
    const realDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-realdir-')),
    );
    const linkParent = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-linkdir-')),
    );
    const repoViaSymlink = path.join(linkParent, 'repo-via-symlink');
    await fs.symlink(realDir, repoViaSymlink);

    try {
      await initRepo(realDir);
      // Create node_modules in the real dir so realpath resolves to a
      // canonical path under realDir, NOT repoViaSymlink.
      await mkdirWith(path.join(realDir, 'node_modules'), 'marker', 'real');

      // Service rooted at the SYMLINK path — that's the production shape
      // since git rev-parse --show-toplevel returns the user-supplied
      // path, not the canonical realpath.
      const result = await create(
        'symlinkedrepo',
        ['node_modules'],
        repoViaSymlink,
      );

      // The configured entry must have been linked. Pre-fix: realSource
      // = realDir/node_modules, repoRootAbs = repoViaSymlink (lexical) →
      // isWithinRoot fails → entry silently rejected → dest absent.
      const dest = path.join(result.worktree!.path, 'node_modules');
      const lst = await fs.lstat(dest).catch(() => null);
      expect(
        lst,
        'symlinkDirectories entry was silently rejected — canonical vs lexical isWithinRoot mismatch',
      ).not.toBeNull();
      expect(lst!.isSymbolicLink()).toBe(true);

      // Reading through the link reaches the real file.
      const marker = await fs.readFile(path.join(dest, 'marker'), 'utf8');
      expect(marker).toBe('real');
    } finally {
      // Remove via the realpath, not the symlink, so rm-rf clears the
      // backing directory cleanly; the dangling symlink goes with linkParent.
      await fs.rm(realDir, { recursive: true, force: true });
      await fs.rm(linkParent, { recursive: true, force: true });
    }
  });

  it('refuses sources whose realpath escapes the repo root or lands in .git/.qwen (committed-symlink bypass)', async () => {
    // Round-7 security fix: the lexical `isWithinRoot(sourceAbs, …)` and
    // `.git`/`.qwen` blocklist checks DON'T resolve symlinks, so a symlink
    // committed into the source repo HEAD (or set up out-of-band by a
    // malicious post-install script / repo tarball) can chain through to
    // arbitrary targets. Two flavours:
    // 1. `escape-to-git` → .git: `fs.stat` follows it and succeeds, so without
    //    the realpath guard we'd create `<wt>/escape-to-git → <repo>/.git`,
    //    giving any tool in the worktree read/write access to .git/hooks,
    //    .git/config, etc.
    // 2. `escape-to-outside` → a dir OUTSIDE the repo (e.g. /etc, ~/.aws).
    // Both are set up out-of-band (no `git add`) so EEXIST-from-checkout
    // cannot mask the issue: the worktree's dest path is empty when the
    // symlink loop runs, so without the guard `fs.symlink` would succeed.
    await fs.symlink('.git', path.join(repoRoot, 'escape-to-git'));

    const outsideResolved = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-outside-')),
    );
    await fs.writeFile(path.join(outsideResolved, 'secret'), 'should-not-leak');
    await fs.symlink(outsideResolved, path.join(repoRoot, 'escape-to-outside'));

    try {
      const names = ['escape-to-git', 'escape-to-outside'];
      const wt = (await create('bypass', names)).worktree!.path;

      // Neither entry should have produced a symlink we wrote: the
      // realpath check refuses .git-chain and out-of-repo targets.
      for (const name of names) {
        expect(
          await exists(path.join(wt, name)),
          `realpath guard must refuse to create <wt>/${name} — committed symlink escape would chain through to a sensitive location`,
        ).toBe(false);
      }

      // Belt-and-suspenders: the outside file remains unreachable from
      // the worktree (no path to it via any symlink we created).
      const leak = await fs
        .readFile(path.join(wt, 'escape-to-outside', 'secret'), 'utf8')
        .catch(() => null);
      expect(leak).toBeNull();
    } finally {
      await fs.rm(outsideResolved, { recursive: true, force: true });
    }
  });

  it("rejects any entry containing a '..' segment (docs contract)", async () => {
    // `foo/../bar` resolves to `bar` (inside the repo), so the
    // post-resolve isWithinRoot check would accept it. But the
    // user-facing description for `worktree.symlinkDirectories`
    // promises rejection of any entry containing `..`. Verify the
    // contract is enforced syntactically, before path.resolve.
    //
    // Provision a real `bar/` source so this test would fail loudly
    // if the syntactic guard were removed (we'd see a symlink at
    // `<worktree>/bar` pointing back to the source).
    await mkdirWith(path.join(repoRoot, 'bar'), 'marker', 'bar');

    const wt = (await create('dotdot', ['foo/../bar'])).worktree!.path;
    // Nothing at <worktree>/bar (the resolved name)…
    expect(await exists(path.join(wt, 'bar'))).toBe(false);
    // …nor at <worktree>/foo (the raw first segment).
    expect(await exists(path.join(wt, 'foo'))).toBe(false);
  });

  it('handles multiple entries — some present, some missing', async () => {
    await mkdirWith(path.join(repoRoot, 'present-a'), 'x', 'a');
    await mkdirWith(path.join(repoRoot, 'present-b'), 'y', 'b');

    const result = await create('multi', ['present-a', 'absent', 'present-b']);
    const wt = result.worktree!.path;
    expect(await fs.readlink(path.join(wt, 'present-a'))).toBe(
      path.join(repoRoot, 'present-a'),
    );
    expect(await fs.readlink(path.join(wt, 'present-b'))).toBe(
      path.join(repoRoot, 'present-b'),
    );
    // Absent: nothing created.
    expect(await exists(path.join(wt, 'absent'))).toBe(false);
  });

  // Phase D-3 sanity check: fetchPullRequestRef's error taxonomy. We
  // keep happy-path PR-worktree coverage in cli/src/startup/worktreeStartup.test.ts
  // (which exercises the full setupStartupWorktree → createUserWorktree
  // flow against a local fake remote); here we just verify the error
  // messages so reviewers can grep them in this file.
  describe('Phase D-3: fetchPullRequestRef error messages', () => {
    it('returns the "origin remote" error when origin is missing', async () => {
      const service = new GitWorktreeService(repoRoot);
      const res = await service.fetchPullRequestRef(1, { timeoutMs: 10000 });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toContain('#1');
        expect(res.error.toLowerCase()).toContain('origin');
      }
    });

    it('rejects out-of-range PR numbers without firing git', async () => {
      const service = new GitWorktreeService(repoRoot);
      // 0
      let res = await service.fetchPullRequestRef(0);
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.toLowerCase()).toContain('invalid');
      // negative
      res = await service.fetchPullRequestRef(-5);
      expect(res.success).toBe(false);
      // absurdly large
      res = await service.fetchPullRequestRef(9_999_999_999);
      expect(res.success).toBe(false);
    });

    it('handles "no such ref" when origin is reachable but the PR does not exist', async () => {
      // Set up a bare upstream with only main — no pull/<N>/head refs.
      const upstreamResolved = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-pr-no-such-ref-')),
      );
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], {
        cwd: upstreamResolved,
      });
      execFileSync('git', ['remote', 'add', 'origin', upstreamResolved], {
        cwd: repoRoot,
      });
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repoRoot });

      try {
        const service = new GitWorktreeService(repoRoot);
        const res = await service.fetchPullRequestRef(99999, {
          timeoutMs: 10000,
        });
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.error).toContain('#99999');
          // Either the "PR does not exist" branch fired (preferred) or
          // the generic "PR may not exist or origin unreachable"
          // fallback — both are acceptable depending on the git version.
          expect(res.error.toLowerCase()).toMatch(
            /pr.*not exist|origin.*unreachable/,
          );
        }
      } finally {
        await fs.rm(upstreamResolved, { recursive: true, force: true });
      }
    });
  });

  it('is a no-op when symlinkDirectories is omitted or empty', async () => {
    await fs.mkdir(path.join(repoRoot, 'node_modules'));
    const service = new GitWorktreeService(repoRoot);

    const noOpts = await service.createUserWorktree('no-opts', 'main');
    expect(noOpts.success).toBe(true);
    const noOptsWt = noOpts.worktree!.path;
    expect(await exists(path.join(noOptsWt, 'node_modules'))).toBe(false);

    const emptyArr = await service.createUserWorktree('empty-arr', 'main', {
      symlinkDirectories: [],
    });
    expect(emptyArr.success).toBe(true);
    const emptyArrWt = emptyArr.worktree!.path;
    expect(await exists(path.join(emptyArrWt, 'node_modules'))).toBe(false);
  });
});
