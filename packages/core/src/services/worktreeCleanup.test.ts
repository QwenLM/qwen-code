/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitWorktreeService,
  worktreeHasWork,
  writeWorktreeSessionMarker,
} from './gitWorktreeService.js';
import {
  cleanupStaleAgentWorktrees,
  STALE_WORKTREE_CUTOFF_MS,
  __test__,
} from './worktreeCleanup.js';

const { isEphemeralSlug } = __test__;

const cleanupLogger = vi.hoisted(() => ({
  isEnabled: () => true,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// The shared predicate logs under its own tag, so capturing the waiver
// breadcrumbs it writes needs a second spy.
const worktreeServiceLogger = vi.hoisted(() => ({
  isEnabled: () => true,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Intercept the sweep's tag and the predicate's; every other module in this
// file's import graph (storage, telemetry) keeps the real logger.
vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: (tag?: string) => {
      if (tag === 'WORKTREE_CLEANUP') return cleanupLogger;
      if (tag === 'GIT_WORKTREE_SERVICE') return worktreeServiceLogger;
      return actual.createDebugLogger(tag);
    },
  };
});

describe('isEphemeralSlug', () => {
  it('matches the agent-<7hex> pattern', () => {
    expect(isEphemeralSlug('agent-aabbccd')).toBe(true);
    expect(isEphemeralSlug('agent-0000000')).toBe(true);
    expect(isEphemeralSlug('agent-abcdef0')).toBe(true);
  });

  it('rejects non-matching shapes', () => {
    expect(isEphemeralSlug('agent-')).toBe(false);
    expect(isEphemeralSlug('agent-toolong0')).toBe(false);
    expect(isEphemeralSlug('agent-abcdefg')).toBe(false); // g is not hex
    expect(isEphemeralSlug('AGENT-aabbccd')).toBe(false); // uppercase
    expect(isEphemeralSlug('my-feature')).toBe(false);
    expect(isEphemeralSlug('')).toBe(false);
  });

  it('does not sweep user-named worktrees that share the prefix', () => {
    expect(isEphemeralSlug('agent-feature')).toBe(false);
    expect(isEphemeralSlug('agentic')).toBe(false);
    expect(isEphemeralSlug('my-agent-aabbccd')).toBe(false);
  });
});

/**
 * Acceptance coverage for #12758 against the real sweep: a stale agent
 * worktree whose only content is git-ignored must survive, while one
 * holding only disposable build output (or only the daemon's session
 * marker) must stay reaping. Real git fixture — the defect lives in the
 * exact `git status` argv the sweep runs, which a mocked status cannot
 * see.
 */
describe('cleanupStaleAgentWorktrees', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  // Repo sits one level down so the worktrees dir and any siblings stay
  // inside a per-test parent that afterEach can remove wholesale.
  let repoParent: string;
  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-cleanup-'));
    // realpath so path comparisons line up with GitWorktreeService on
    // platforms where the temp dir is a symlink (macOS /var).
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    // Name the initial branch without `git init -b` (git < 2.28 lacks it).
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: repoRoot,
    });
    execFileSync('git', ['config', 'user.email', 't@e.com'], {
      cwd: repoRoot,
    });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repoRoot,
    });
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      'secret.env\nnode_modules/\n',
    );
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: repoRoot,
    });
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  async function createAgentWorktree(slug: string): Promise<string> {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main');
    expect(result.success).toBe(true);
    return result.worktree!.path;
  }

  // The sweep reads the worktree dir's mtime; writing files inside it
  // refreshes that mtime, so age the directory only after all writes.
  async function agePastCutoff(worktreePath: string): Promise<void> {
    const aged = new Date(
      Date.now() - STALE_WORKTREE_CUTOFF_MS - 24 * 60 * 60 * 1000,
    );
    await fs.utimes(worktreePath, aged, aged);
  }

  // Add a bare (slashless) ignore rule to the fixture repo and commit it, so
  // a worktree created afterwards branches off a `main` that carries the same
  // rules the probe will see. The shared `.gitignore` stays untouched for the
  // cases that depend on `node_modules/` being directory-only.
  async function addIgnoreRule(rule: string): Promise<void> {
    await fs.appendFile(path.join(repoRoot, '.gitignore'), `${rule}\n`);
    execFileSync('git', ['add', '.gitignore'], { cwd: repoRoot });
    execFileSync(
      'git',
      ['commit', '-q', '-m', `ignore ${rule}`, '--no-verify'],
      {
        cwd: repoRoot,
      },
    );
  }

  it('preserves a stale worktree whose only content is git-ignored (#12758)', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.writeFile(path.join(wtPath, 'secret.env'), 'AWS_KEY=x\n');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(wtPath, 'secret.env')),
    ).resolves.toBeUndefined();
  });

  it('preserves a user-named `agent-<7hex>` worktree holding only untracked files (#12735)', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    // Pin the untracked mode against ambient config. `normal` is git's
    // default, so without this a later refactor that drops the explicit
    // `--untracked-files=normal` from the probe would keep every test green
    // while a user's `status.showUntrackedFiles=no` (in `~/.gitconfig`, or in
    // the repo's `.git/config`, which every linked worktree shares) hides the
    // sentinel and #12735 returns silently.
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
      cwd: repoRoot,
    });
    await fs.writeFile(path.join(wtPath, 'sentinel.txt'), 'user work\n');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(wtPath, 'sentinel.txt')),
    ).resolves.toBeUndefined();
  });

  it('logs a debug breadcrumb naming the entry it deliberately kept', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.writeFile(path.join(wtPath, 'sentinel.txt'), 'user work\n');
    await agePastCutoff(wtPath);
    cleanupLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    // The caller logs "nothing to remove" when the sweep returns 0, so a
    // preserved entry that leaves no line of its own cannot be told apart
    // from one the sweep never saw.
    expect(cleanupLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('keeping agent-aabbccd'),
    );
  });

  it('still sweeps a clean, commit-free ephemeral worktree past the cutoff', async () => {
    const wtPath = await createAgentWorktree('agent-1234567');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(fs.access(wtPath)).rejects.toThrow();
  });

  it('still reaps a stale worktree holding only disposable build output', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'node_modules', 'x'), {
      recursive: true,
    });
    await fs.writeFile(path.join(wtPath, 'node_modules', 'x', 'i.js'), '//\n');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(fs.access(wtPath)).rejects.toThrow();
  });

  it('still reaps a stale worktree holding only a session marker', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await writeWorktreeSessionMarker(wtPath, 'session-1');
    await agePastCutoff(wtPath);
    worktreeServiceLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    // `writeWorktreeSessionMarker` writes the `info/exclude` rule, so this
    // fixture pins the *ignored* disjunct of the marker arm.
    expect(worktreeServiceLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('waiving !! .qwen-session (session-marker)'),
    );
  });

  it('still reaps a stale worktree whose session marker was never git-excluded', async () => {
    // `addWorktreeSessionMarkerExclude` is best-effort and swallows every
    // error, so a checkout can carry the daemon's own marker with no exclude
    // rule and git then lists it as `?? .qwen-session`. Write the file
    // directly: `writeWorktreeSessionMarker` always writes the rule and so
    // can only ever render `!!`. Without this case, dropping the
    // `status === '??'` disjunct keeps the whole suite green while every
    // such aged checkout is preserved forever — the pile-up the sweep exists
    // to prevent. The shared `.gitignore` deliberately has no marker rule.
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.writeFile(path.join(wtPath, '.qwen-session'), 'session-1', 'utf8');
    await agePastCutoff(wtPath);
    worktreeServiceLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(fs.access(wtPath)).rejects.toThrow();
    expect(worktreeServiceLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('waiving ?? .qwen-session (session-marker)'),
    );
  });

  it('preserves a stale worktree whose only content is an edit to a tracked .qwen-session', async () => {
    // The marker exemption is for the daemon's own file, which git lists as
    // ignored (its `info/exclude` rule) or untracked (a fixture without one).
    // A repository that *tracks* `.qwen-session` renders an edit to it as
    // ` M .qwen-session`: a real uncommitted edit, and the name match alone
    // would waive it and authorize a force-remove plus branch delete over it.
    // (A marker merely *staged* after that best-effort exclude write failed
    // has no HEAD version, so git renders `A ` — which this gate likewise
    // leaves counting as work.)
    await fs.writeFile(path.join(repoRoot, '.qwen-session'), 'committed\n');
    // -f so a global excludesFile matching the marker cannot fail the add;
    // ignore rules never apply to a tracked path, so the ` M` shape holds.
    execFileSync('git', ['add', '-f', '.qwen-session'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'marker', '--no-verify'], {
      cwd: repoRoot,
    });
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.writeFile(path.join(wtPath, '.qwen-session'), 'edited\n');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.readFile(path.join(wtPath, '.qwen-session'), 'utf8'),
    ).resolves.toBe('edited\n');
  });

  it('still reaps a stale worktree whose node_modules is a symlink (worktree.symlinkDirectories)', async () => {
    const target = path.join(repoRoot, 'node_modules', 'x');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'i.js'), '//\n');
    const wtPath = await createAgentWorktree('agent-aabbccd');
    // The fixture's `node_modules/` ignore rule is directory-only, so git
    // lists the link as `?? node_modules` — the shape the fix exempts.
    await fs.symlink(
      path.join(repoRoot, 'node_modules'),
      path.join(wtPath, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await agePastCutoff(wtPath);
    worktreeServiceLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    // Reaping unlinks the symlink; the shared target must survive.
    await expect(fs.access(path.join(target, 'i.js'))).resolves.toBeUndefined();
    // The waiver authorized an irreversible removal plus a branch delete and
    // destroyed the checkout that was its only evidence, so it has to name
    // the entry and the reason while they can still be read.
    expect(worktreeServiceLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('waiving ?? node_modules (symlink)'),
    );
  });

  it('still reaps a stale worktree holding only a workspace package install', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    // The fixture's `node_modules/` rule matches at any depth, so git
    // reports `!! packages/app/node_modules/` — a monorepo install.
    await fs.mkdir(path.join(wtPath, 'packages', 'app', 'node_modules', 'x'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(wtPath, 'packages', 'app', 'node_modules', 'x', 'i.js'),
      '//\n',
    );
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(fs.access(wtPath)).rejects.toThrow();
  });

  it('still reaps a stale worktree whose only content is one ignored file under a disposable root', async () => {
    // A file-level rule makes git list the entry with no trailing slash
    // (`!! dist/archive.zip`), so only the first-segment branch of
    // isDisposableIgnoredEntry can waive it — the nested branch requires
    // `endsWith('/')`. Every other disposable fixture yields a collapsed
    // `!! <name>/`, which the nested branch matches on its own, so without
    // this case deleting the first-segment branch leaves the suite green
    // while aged root `dist`/`coverage` checkouts stop being reapable. The
    // rule must be committed *before* the worktree exists: the worktree
    // branch has to carry it, or git reports `?? dist/` instead.
    await addIgnoreRule('*.zip');
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'dist'), { recursive: true });
    await fs.writeFile(path.join(wtPath, 'dist', 'archive.zip'), 'zip\n');
    await agePastCutoff(wtPath);
    worktreeServiceLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(fs.access(wtPath)).rejects.toThrow();
    expect(worktreeServiceLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        'waiving !! dist/archive.zip (disposable-output)',
      ),
    );
  });

  it('preserves a stale worktree holding a nested ignored directory outside the disposable set', async () => {
    const wtPath = await createAgentWorktree('agent-aabbccd');
    // `secret.env` matches at any depth; whether git collapses this to
    // `!! packages/app/` or lists the file, it is not disposable output.
    await fs.mkdir(path.join(wtPath, 'packages', 'app'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(wtPath, 'packages', 'app', 'secret.env'),
      'AWS_KEY=x\n',
    );
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(wtPath, 'packages', 'app', 'secret.env')),
    ).resolves.toBeUndefined();
  });

  it('preserves a stale worktree holding ignored work beside disposable output', async () => {
    // git emits ignored and untracked entries in traversal order, so the
    // realistic mixed checkout waives *first*: `!! node_modules/` and only
    // then `!! packages/app/secret.env`. A predicate that returned "no work"
    // on the first waiver instead of continuing the scan reads this checkout
    // as empty and destroys the secret, and every single-entry fixture above
    // stays green under that refactor.
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(wtPath, 'node_modules', 'x', 'i.js'), '//\n');
    await fs.mkdir(path.join(wtPath, 'packages', 'app'), { recursive: true });
    await fs.writeFile(
      path.join(wtPath, 'packages', 'app', 'secret.env'),
      'AWS_KEY=x\n',
    );
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.readFile(path.join(wtPath, 'packages', 'app', 'secret.env'), 'utf8'),
    ).resolves.toBe('AWS_KEY=x\n');
  });

  it('still reaps a stale worktree whose only content is an ignored .turbo symlink', async () => {
    // A bare (slashless) rule matches a symlink, so git reports `!! .turbo`:
    // the ignored arm of the exemption, with a name DISPOSABLE_IGNORED_ROOTS
    // does not cover. The shared fixture's `node_modules/` rule is
    // directory-only and yields `?? node_modules` instead, so without this
    // case narrowing the guard to `status === '??'` — or restricting the
    // exemption to disposable names — leaves the whole suite green.
    await addIgnoreRule('.turbo');
    const cacheTarget = path.join(repoParent, 'turbo-cache');
    await fs.mkdir(cacheTarget);
    await fs.writeFile(path.join(cacheTarget, 't.json'), '{}\n');
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.symlink(
      cacheTarget,
      path.join(wtPath, '.turbo'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await agePastCutoff(wtPath);
    worktreeServiceLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(
      fs.access(path.join(cacheTarget, 't.json')),
    ).resolves.toBeUndefined();
    expect(worktreeServiceLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('waiving !! .turbo (symlink)'),
    );
  });

  it('preserves a stale worktree whose only content is a nested ignored file named coverage', async () => {
    // A slashless rule matches at any depth and git lists an ignored FILE
    // individually with no trailing slash (`!! packages/app/coverage`), so a
    // basename match alone must not class it as regenerable output —
    // `go test -coverprofile=coverage` writes exactly this. It has to be
    // nested: the root-level branch of isDisposableIgnoredEntry already
    // exempts `coverage` with or without a slash.
    await addIgnoreRule('coverage');
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'packages', 'app'), { recursive: true });
    await fs.writeFile(
      path.join(wtPath, 'packages', 'app', 'coverage'),
      'mode: set\n',
    );
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(wtPath, 'packages', 'app', 'coverage')),
    ).resolves.toBeUndefined();
  });

  it('still reaps a stale worktree whose nested symlinkDirectories parent holds only links', async () => {
    // `symlinkConfiguredDirectories` accepts nested values and has to mkdir
    // the untracked parent (`git worktree add` does not create it), and
    // nothing writes an exclude rule for linked paths — so git collapses the
    // whole subtree to a single `?? tools/` that never names the link.
    const cacheTarget = path.join(repoParent, 'tools-cache');
    await fs.mkdir(cacheTarget);
    await fs.writeFile(path.join(cacheTarget, 'f.txt'), 'x\n');
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'tools'));
    await fs.symlink(
      cacheTarget,
      path.join(wtPath, 'tools', 'cache'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    await expect(
      fs.access(path.join(cacheTarget, 'f.txt')),
    ).resolves.toBeUndefined();
  });

  it('still reaps a stale worktree whose *ignored* symlinkDirectories parent holds only links', async () => {
    // The same nested value under a repo that ignores the parent (`.cache/`
    // in `.gitignore`, `worktree.symlinkDirectories: [".cache/build"]`): git
    // collapses the wholly-ignored subtree to `!! .cache/` and never names
    // the link, so the collapsed arm has to answer for `!!` too. The `??`
    // case above pins only the untracked side, so narrowing that arm to
    // `status === '??'` would keep every existing case green while
    // `.cache/`-style checkouts silently became unreapable forever.
    await addIgnoreRule('.cache/');
    const cacheTarget = path.join(repoParent, 'cache-build');
    await fs.mkdir(cacheTarget);
    await fs.writeFile(path.join(cacheTarget, 'o.txt'), 'x\n');
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, '.cache'));
    await fs.symlink(
      cacheTarget,
      path.join(wtPath, '.cache', 'build'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await agePastCutoff(wtPath);
    worktreeServiceLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(1);
    // Reaping unlinks the link; the shared target must survive.
    await expect(
      fs.access(path.join(cacheTarget, 'o.txt')),
    ).resolves.toBeUndefined();
    expect(worktreeServiceLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('waiving !! .cache/ (symlink)'),
    );
  });

  it('preserves a stale worktree holding a real file beside a nested symlink', async () => {
    // The collapsed-directory waiver has to stay symlink-only: one real file
    // beside the link is untracked work and must pin the checkout.
    const cacheTarget = path.join(repoParent, 'tools-cache');
    await fs.mkdir(cacheTarget);
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'tools'));
    await fs.symlink(
      cacheTarget,
      path.join(wtPath, 'tools', 'cache'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.writeFile(path.join(wtPath, 'tools', 'notes.md'), 'keep\n');
    await agePastCutoff(wtPath);

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(wtPath, 'tools', 'notes.md')),
    ).resolves.toBeUndefined();
  });

  // chmod-based denial needs POSIX semantics; Windows ACLs do not map, and
  // root (CI containers) opens mode-000 directories without a warning.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'preserves a stale worktree when the probe cannot enumerate a directory',
    async () => {
      // `git status` answers a directory it cannot open with a stderr
      // warning and exit 0, so the content is absent from stdout with no
      // line to keep it. Beside a waivable entry (the node_modules
      // symlink) that silent gap would let the sweep reach
      // removeUserWorktree over content the probe never saw.
      const target = path.join(repoRoot, 'node_modules', 'x');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'i.js'), '//\n');
      const wtPath = await createAgentWorktree('agent-aabbccd');
      await fs.symlink(
        path.join(repoRoot, 'node_modules'),
        path.join(wtPath, 'node_modules'),
        'dir',
      );
      await fs.mkdir(path.join(wtPath, 'locked'));
      await fs.writeFile(
        path.join(wtPath, 'locked', 'precious.txt'),
        'irreplaceable\n',
      );
      await fs.chmod(path.join(wtPath, 'locked'), 0o000);
      await agePastCutoff(wtPath);
      worktreeServiceLogger.debug.mockClear();

      try {
        const removed = await cleanupStaleAgentWorktrees(repoRoot);

        expect(removed).toBe(0);
        await expect(
          fs.access(path.join(wtPath, '.git')),
        ).resolves.toBeUndefined();
        await expect(
          fs.access(path.join(wtPath, '.gitignore')),
        ).resolves.toBeUndefined();
        const registered = execFileSync(
          'git',
          ['worktree', 'list', '--porcelain'],
          { cwd: repoRoot, encoding: 'utf8' },
        );
        expect(registered).toContain(`worktree ${wtPath}`);
        expect(worktreeServiceLogger.debug).toHaveBeenCalledWith(
          expect.stringContaining('reported on stderr'),
        );
      } finally {
        // Restore readability so afterEach can remove the fixture.
        await fs.chmod(path.join(wtPath, 'locked'), 0o755);
      }
    },
  );

  it('preserves a stale worktree whose only content is an empty ignored directory', async () => {
    // git lists empty *ignored* directories (never empty untracked ones), so
    // the collapsed arm can be reached with zero children — where "every
    // child is a symlink" is vacuously true. `build` is not in
    // DISPOSABLE_IGNORED_ROOTS, so without the at-least-one-link requirement
    // this checkout is waived, reaped, and the breadcrumb names an exemption
    // (`symlink`) that does not exist in it.
    await addIgnoreRule('build/');
    const wtPath = await createAgentWorktree('agent-aabbccd');
    await fs.mkdir(path.join(wtPath, 'build'));
    await agePastCutoff(wtPath);
    worktreeServiceLogger.debug.mockClear();

    const removed = await cleanupStaleAgentWorktrees(repoRoot);

    expect(removed).toBe(0);
    await expect(
      fs.access(path.join(wtPath, 'build')),
    ).resolves.toBeUndefined();
    expect(worktreeServiceLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('waiving !! build/ (symlink)'),
    );
  });

  it('reads a directory with no .git of its own as dirty, not as the enclosing repo', async () => {
    // A path inside a valid repo whose own .git is gone (a sweep's rm that
    // threw partway): without the guard, git's upward discovery answers
    // about the enclosing repo — which is clean here — and would read as
    // "no work", authorizing the destructive sinks this predicate gates.
    const orphan = path.join(repoRoot, 'orphaned-worktree');
    await fs.mkdir(orphan);
    await expect(worktreeHasWork(orphan)).resolves.toBe(true);
  });
});

describe('worktreeHasWork', () => {
  it('fails closed on a path git cannot read as a worktree', async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-haswork-')),
    );
    try {
      await expect(worktreeHasWork(dir)).resolves.toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
