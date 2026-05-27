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

describe('GitWorktreeService.createUserWorktree() — symlinkDirectories', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-symlinks-'));
    // Resolve symlinks (macOS /var → /private/var) so path comparisons
    // line up with what GitWorktreeService produces internally.
    repoRoot = await fs.realpath(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repoRoot,
    });
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: repoRoot,
    });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('symlinks a configured directory into the new worktree', async () => {
    // Create a fake node_modules in the main repo so there's something
    // to link.
    const nm = path.join(repoRoot, 'node_modules');
    await fs.mkdir(nm);
    await fs.writeFile(path.join(nm, 'marker'), 'real');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('linked', 'main', {
      symlinkDirectories: ['node_modules'],
    });
    expect(result.success).toBe(true);
    expect(result.worktree).toBeDefined();

    const dest = path.join(result.worktree!.path, 'node_modules');
    const linkTarget = await fs.readlink(dest);
    expect(linkTarget).toBe(nm);

    // Reading through the symlink resolves to the real file.
    const marker = await fs.readFile(path.join(dest, 'marker'), 'utf8');
    expect(marker).toBe('real');
  });

  it('silently skips a missing source directory', async () => {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('missing-source', 'main', {
      symlinkDirectories: ['does-not-exist'],
    });
    // Worktree creation still succeeds.
    expect(result.success).toBe(true);
    expect(result.worktree).toBeDefined();

    // Nothing was created at the would-be destination.
    const dest = path.join(result.worktree!.path, 'does-not-exist');
    const exists = await fs
      .lstat(dest)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('silently skips an existing destination (no overwrite)', async () => {
    const nm = path.join(repoRoot, 'node_modules');
    await fs.mkdir(nm);
    await fs.writeFile(path.join(nm, 'marker'), 'real');

    const service = new GitWorktreeService(repoRoot);
    // Pre-create the destination inside what will become the worktree.
    // We can't pre-populate the worktree (it doesn't exist yet), so we
    // exploit the fact that `git worktree add` creates the dir — we set
    // the symlinkDirectories to the empty array first to create the
    // worktree, then drop a file at the dest, then exercise the symlink
    // path via a second call on a new slug.
    //
    // Actually, simpler: just test that on a second create attempt at
    // the same slug, the create itself fails (because branch exists),
    // so this case is only reachable in practice if a user pre-populates
    // the worktree (e.g. via a custom checkout hook). Simulate by
    // creating the worktree first with no symlinks, then dropping a
    // marker file, then running the symlink loop manually via a fresh
    // service instance pointed at a SECOND slug that pre-fills the dest.

    // Pre-create the worktree path so `createUserWorktree` errors out
    // on its "already exists" guard — this is the wrong shape. Instead,
    // create the worktree, hand-place a node_modules dir under it (the
    // tool's pre-populated state), then call symlinkConfiguredDirectories
    // directly. The method is private but accessible via prototype here
    // because tests run in the same package.
    const first = await service.createUserWorktree('preexisting', 'main', {
      symlinkDirectories: [],
    });
    expect(first.success).toBe(true);
    const wt = first.worktree!.path;
    await fs.mkdir(path.join(wt, 'node_modules'));
    await fs.writeFile(path.join(wt, 'node_modules', 'preexisting'), 'wins');

    // Invoke the private symlink loop directly.
    // Probe the `private symlinkConfiguredDirectories` method directly.
    // We can't intersect `GitWorktreeService` with a `public` version of
    // the same name (TypeScript collapses class + redeclared-as-public
    // intersection to `never`), so describe ONLY the method's shape and
    // double-cast through `unknown` to bypass the private check at
    // test-time.
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

    // And the directory at `wt/node_modules` is still the original dir,
    // not a symlink to the main repo's node_modules.
    const stat = await fs.lstat(path.join(wt, 'node_modules'));
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it('rejects absolute paths', async () => {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('abs', 'main', {
      symlinkDirectories: ['/etc'],
    });
    expect(result.success).toBe(true);
    // Nothing at /etc-named inside the worktree.
    const dest = path.join(result.worktree!.path, 'etc');
    const exists = await fs
      .lstat(dest)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('rejects paths that traverse outside the repo root', async () => {
    // Put a sibling directory next to the repo so `../sibling` resolves to
    // something real — proving the guard fires on traversal shape rather
    // than on "source missing".
    const siblingDir = path.join(path.dirname(repoRoot), 'qwen-wt-sibling');
    await fs.mkdir(siblingDir);
    await fs.writeFile(path.join(siblingDir, 'marker'), 'outside');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('traverse', 'main', {
      symlinkDirectories: ['../qwen-wt-sibling'],
    });

    try {
      expect(result.success).toBe(true);
      const dest = path.join(result.worktree!.path, '..', 'qwen-wt-sibling');
      // No symlink was created inside the worktree directory.
      const stat = await fs
        .lstat(path.join(result.worktree!.path, 'qwen-wt-sibling'))
        .catch(() => null);
      expect(stat).toBeNull();
      // Sibling itself is untouched.
      const marker = await fs.readFile(path.join(siblingDir, 'marker'), 'utf8');
      expect(marker).toBe('outside');
      // The variable `dest` is not used for assertion — silence unused warning.
      void dest;
    } finally {
      await fs.rm(siblingDir, { recursive: true, force: true });
    }
  });

  it('rejects paths inside .git (security guard)', async () => {
    // `.git` is git-internal; symlinking any of it into the worktree
    // would shadow the worktree's gitlink file and silently break
    // commits / status / diff. Verify the guard fires.
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('reject-git', 'main', {
      symlinkDirectories: ['.git/hooks'],
    });
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    // Nothing at <worktree>/.git/hooks beyond what `git worktree add`
    // itself populates — and certainly NOT a symlink that we wrote.
    // The guard rejects pre-mkdir, so no `hooks` entry should exist
    // (the worktree gets its own per-worktree .git file, not directory).
    const wrote = await fs
      .lstat(path.join(wt, '.git', 'hooks'))
      .then((s) => s.isSymbolicLink())
      .catch(() => false);
    expect(wrote).toBe(false);
  });

  it('rejects paths inside .qwen (security guard)', async () => {
    // `.qwen` is CLI metadata: symlinking `.qwen/worktrees` would create
    // a worktrees-inside-worktrees loop; symlinking `.qwen/projects` or
    // `.qwen/tmp` would alias session metadata users have no legitimate
    // reason to share across worktrees. Guard rejects the whole subtree.
    await fs.mkdir(path.join(repoRoot, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.qwen', 'projects'), 'data');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('reject-qwen', 'main', {
      symlinkDirectories: ['.qwen/projects'],
    });
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    // No symlink at <worktree>/.qwen/projects.
    const wrote = await fs
      .lstat(path.join(wt, '.qwen', 'projects'))
      .then((s) => s.isSymbolicLink())
      .catch(() => false);
    expect(wrote).toBe(false);
  });

  it('refuses sources whose realpath escapes the repo root or lands in .git/.qwen (committed-symlink bypass)', async () => {
    // Round-7 security fix: the lexical `isWithinRoot(sourceAbs, …)` and
    // `.git`/`.qwen` blocklist checks DON'T resolve symlinks, so a symlink
    // committed into the source repo HEAD (or set up out-of-band by a
    // malicious post-install script / repo tarball) can chain through to
    // arbitrary targets. Two flavours covered here:
    //
    //   1. `escape-to-git` is an OUT-OF-BAND symlink pointing at .git.
    //      `fs.stat(<repo>/escape-to-git)` follows the symlink and
    //      succeeds against the .git directory; without the realpath
    //      guard, we'd happily create `<wt>/escape-to-git →
    //      <repo>/escape-to-git → <repo>/.git`, giving any tool inside
    //      the worktree read/write access to .git/hooks, .git/config,
    //      etc.
    //
    //   2. `escape-to-outside` is an OUT-OF-BAND symlink pointing at a
    //      sibling dir OUTSIDE the repo. Same bypass shape; targets
    //      whatever lives at the other end (e.g. /etc, ~/.aws, etc.).
    //
    // Both are intentionally set up out-of-band (no `git add`) so we
    // don't rely on EEXIST-from-checkout masking the issue; the
    // worktree's dest path is empty when the symlink loop runs, so
    // without the realpath guard `fs.symlink` would succeed.
    await fs.symlink('.git', path.join(repoRoot, 'escape-to-git'));

    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-wt-outside-'),
    );
    const outsideResolved = await fs.realpath(outsideDir);
    await fs.writeFile(path.join(outsideResolved, 'secret'), 'should-not-leak');
    await fs.symlink(outsideResolved, path.join(repoRoot, 'escape-to-outside'));

    try {
      const service = new GitWorktreeService(repoRoot);
      const result = await service.createUserWorktree('bypass', 'main', {
        symlinkDirectories: ['escape-to-git', 'escape-to-outside'],
      });
      expect(result.success).toBe(true);

      const wt = result.worktree!.path;

      // Neither entry should have produced a symlink we wrote: the
      // realpath check refuses .git-chain and out-of-repo targets.
      for (const name of ['escape-to-git', 'escape-to-outside']) {
        const dest = path.join(wt, name);
        const exists = await fs
          .lstat(dest)
          .then(() => true)
          .catch(() => false);
        expect(
          exists,
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
    await fs.mkdir(path.join(repoRoot, 'bar'));
    await fs.writeFile(path.join(repoRoot, 'bar', 'marker'), 'bar');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('dotdot', 'main', {
      symlinkDirectories: ['foo/../bar'],
    });
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    // Nothing at <worktree>/bar (the resolved name)…
    const bar = await fs
      .lstat(path.join(wt, 'bar'))
      .then(() => true)
      .catch(() => false);
    expect(bar).toBe(false);
    // …nor at <worktree>/foo (the raw first segment).
    const foo = await fs
      .lstat(path.join(wt, 'foo'))
      .then(() => true)
      .catch(() => false);
    expect(foo).toBe(false);
  });

  it('handles multiple entries — some present, some missing', async () => {
    await fs.mkdir(path.join(repoRoot, 'present-a'));
    await fs.writeFile(path.join(repoRoot, 'present-a', 'x'), 'a');
    await fs.mkdir(path.join(repoRoot, 'present-b'));
    await fs.writeFile(path.join(repoRoot, 'present-b', 'y'), 'b');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('multi', 'main', {
      symlinkDirectories: ['present-a', 'absent', 'present-b'],
    });
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    expect(await fs.readlink(path.join(wt, 'present-a'))).toBe(
      path.join(repoRoot, 'present-a'),
    );
    expect(await fs.readlink(path.join(wt, 'present-b'))).toBe(
      path.join(repoRoot, 'present-b'),
    );
    // Absent: nothing created.
    const absent = await fs
      .lstat(path.join(wt, 'absent'))
      .then(() => true)
      .catch(() => false);
    expect(absent).toBe(false);
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
      const upstream = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-wt-pr-no-such-ref-'),
      );
      const upstreamResolved = await fs.realpath(upstream);
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
    const noOptsDest = path.join(noOpts.worktree!.path, 'node_modules');
    const noOptsExists = await fs
      .lstat(noOptsDest)
      .then(() => true)
      .catch(() => false);
    expect(noOptsExists).toBe(false);

    const emptyArr = await service.createUserWorktree('empty-arr', 'main', {
      symlinkDirectories: [],
    });
    expect(emptyArr.success).toBe(true);
    const emptyArrDest = path.join(emptyArr.worktree!.path, 'node_modules');
    const emptyArrExists = await fs
      .lstat(emptyArrDest)
      .then(() => true)
      .catch(() => false);
    expect(emptyArrExists).toBe(false);
  });
});
