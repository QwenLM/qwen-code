/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dryRunGitWorktreePrune,
  realpathOnDiskOrSelf,
  realpathOrSelf,
  listGitWorktrees,
  parseGitWorktreeList,
  pruneGitWorktrees,
  removeGitWorktree,
  worktreeAdminHoldsModules,
  worktreeHoldsSubmodules,
} from './git-worktrees.js';

const tmpRoots: string[] = [];

/**
 * git with the host's own configuration out of the way, so that nothing here
 * passes because of something the author's machine happens to have set.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitworktrees-'));
  tmpRoots.push(root);
  const dir = path.join(root, 'repo');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Neutralize an inherited global core.hooksPath (hook managers installed
  // machine-wide), which would otherwise run somebody else's hooks here.
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('parseGitWorktreeList', () => {
  it('reads main, branch, detached, locked, prunable, and bare entries', () => {
    const raw = [
      'worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0',
      'worktree /wt/feat\0HEAD bbb\0branch refs/heads/feat\0locked busy now\0\0',
      'worktree /wt/detached\0HEAD ccc\0detached\0prunable gitdir file points to non-existent location\0\0',
      'worktree /wt/bare\0bare\0locked\0\0',
    ].join('');
    expect(parseGitWorktreeList(raw)).toEqual([
      {
        path: '/repo',
        head: 'aaa',
        branch: 'main',
        detached: false,
        bare: false,
        isMain: true,
      },
      {
        path: '/wt/feat',
        head: 'bbb',
        branch: 'feat',
        detached: false,
        bare: false,
        locked: 'busy now',
        isMain: false,
      },
      {
        path: '/wt/detached',
        head: 'ccc',
        branch: null,
        detached: true,
        bare: false,
        prunable: 'gitdir file points to non-existent location',
        isMain: false,
      },
      {
        path: '/wt/bare',
        head: '',
        branch: null,
        detached: false,
        bare: true,
        locked: '',
        isMain: false,
      },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseGitWorktreeList('')).toEqual([]);
  });
});

describe('listGitWorktrees', () => {
  it('lists the main worktree first, then linked ones with their state', async () => {
    const repo = makeRepo();
    // Linked worktrees list in directory order, so name them to sort.
    const linked = path.join(path.dirname(repo), 'a-linked');
    const detached = path.join(path.dirname(repo), 'b-detached');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    git(repo, 'worktree', 'add', '-q', '--detach', detached);
    git(repo, 'worktree', 'lock', linked, '--reason', 'in use');

    const entries = await listGitWorktrees(linked);
    expect(entries.map((e) => [e.isMain, e.branch, e.detached])).toEqual([
      [true, 'main', false],
      [false, 'feat', false],
      [false, null, true],
    ]);
    expect(fs.realpathSync(entries[0].path)).toBe(fs.realpathSync(repo));
    expect(entries[1].locked).toBe('in use');
    expect(entries[1].head).toMatch(/^[0-9a-f]{40}$/);
    expect(entries[2].prunable).toBeUndefined();
  });

  it('rejects outside a repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-norepo-'));
    tmpRoots.push(dir);
    await expect(listGitWorktrees(dir)).rejects.toThrow();
  });
});

describe('removeGitWorktree', () => {
  it('removes a clean worktree and refuses a dirty one without force', async () => {
    const repo = makeRepo();
    const linked = path.join(path.dirname(repo), 'linked');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    fs.writeFileSync(path.join(linked, 'dirty.txt'), 'x\n');

    await expect(removeGitWorktree(repo, linked)).rejects.toThrow();
    expect(fs.existsSync(linked)).toBe(true);

    await removeGitWorktree(repo, linked, { force: true });
    expect(fs.existsSync(linked)).toBe(false);
    expect((await listGitWorktrees(repo)).map((e) => e.branch)).toEqual([
      'main',
    ]);
    // The branch survives; only the checkout is gone.
    expect(git(repo, 'branch', '--list', 'feat').trim()).toBe('feat');
  });

  it('force-removes a locked worktree', async () => {
    const repo = makeRepo();
    const linked = path.join(path.dirname(repo), 'locked');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    git(repo, 'worktree', 'lock', linked);

    await expect(removeGitWorktree(repo, linked)).rejects.toThrow();
    await removeGitWorktree(repo, linked, { force: true });
    expect(fs.existsSync(linked)).toBe(false);
  });

  it('drops one stale registration without touching the others', async () => {
    const repo = makeRepo();
    const first = path.join(path.dirname(repo), 'gone-a');
    const second = path.join(path.dirname(repo), 'gone-b');
    git(repo, 'worktree', 'add', '-q', first, '-b', 'feat-a');
    git(repo, 'worktree', 'add', '-q', second, '-b', 'feat-b');
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });

    const before = await listGitWorktrees(repo);
    expect(before).toHaveLength(3);
    expect(before.slice(1).every((entry) => entry.prunable)).toBe(true);

    // No force: a directory that is already gone holds nothing to lose, so
    // git drops the registration on its own. Repository-wide prune would
    // have taken `gone-b` with it.
    await removeGitWorktree(repo, first);
    const after = await listGitWorktrees(repo);
    expect(after.map((entry) => entry.path.endsWith('gone-b'))).toEqual([
      false,
      true,
    ]);
    expect(git(repo, 'branch', '--list', 'feat-a').trim()).toBe('feat-a');
  });

  it('rejects a registration whose directory outlived its gitfile', async () => {
    const repo = makeRepo();
    const linked = path.join(path.dirname(repo), 'orphan');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    fs.writeFileSync(path.join(linked, 'kept.txt'), 'x\n');
    fs.rmSync(path.join(linked, '.git'));

    // git marks it prunable, but validates `<path>/.git` because the
    // directory is still there — at every force level.
    expect((await listGitWorktrees(repo))[1].prunable).toBeTruthy();
    await expect(removeGitWorktree(repo, linked)).rejects.toThrow();
    await expect(
      removeGitWorktree(repo, linked, { force: true }),
    ).rejects.toThrow();
  });
});

describe('pruneGitWorktrees', () => {
  it('clears what remove cannot, and keeps the files on disk', async () => {
    const repo = makeRepo();
    const linked = path.join(path.dirname(repo), 'orphan');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
    fs.writeFileSync(path.join(linked, 'kept.txt'), 'x\n');
    fs.rmSync(path.join(linked, '.git'));

    await pruneGitWorktrees(repo);

    expect(await listGitWorktrees(repo)).toHaveLength(1);
    expect(fs.existsSync(path.join(linked, 'kept.txt'))).toBe(true);
  });

  it('leaves a locked worktree alone, and never marks one prunable', async () => {
    const repo = makeRepo();
    const locked = path.join(path.dirname(repo), 'locked');
    git(repo, 'worktree', 'add', '-q', locked, '-b', 'feat');
    git(repo, 'worktree', 'lock', locked, '--reason', 'busy');
    fs.rmSync(locked, { recursive: true, force: true });

    // A locked worktree is never marked prunable, even with its directory
    // gone, so `prunable` implies prune will clear it.
    const before = (await listGitWorktrees(repo))[1];
    expect(before.locked).toBe('busy');
    expect(before.prunable).toBeUndefined();

    await pruneGitWorktrees(repo);
    expect(await listGitWorktrees(repo)).toHaveLength(2);
  });
});

describe('worktreeHoldsSubmodules', () => {
  it('ignores a submodule nobody checked out', async () => {
    const outer = makeRepo();
    const inner = makeRepo();
    git(
      outer,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner,
      'sub',
    );
    git(outer, 'commit', '-q', '-m', 'add submodule');
    const wt = path.join(path.dirname(outer), 'wt');
    git(outer, 'worktree', 'add', '-q', wt, '-b', 'side');

    // `git worktree add` does not initialise submodules, so nothing under
    // the new checkout has a repository of its own yet, and warning that one
    // would be deleted would be a warning about a loss that cannot happen.
    expect(await worktreeHoldsSubmodules(wt)).toBe(false);

    git(
      wt,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '-q',
    );
    expect(await worktreeHoldsSubmodules(wt)).toBe(true);
  }, 30_000);
});

describe('worktreeHoldsSubmodules, on what a gitlink path holds', () => {
  it('does not call an empty or junk .git a repository', async () => {
    const outer = makeRepo();
    const inner = makeRepo();
    git(
      outer,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner,
      'sub',
    );
    git(outer, 'commit', '-q', '-m', 'add submodule');
    const wt = path.join(path.dirname(outer), 'wt');
    git(outer, 'worktree', 'add', '-q', wt, '-b', 'side');
    const dot = path.join(wt, 'sub', '.git');

    // git refuses these shapes too, but with a far more exact sentence than
    // "a nested repository would be deleted" — so do not say that first.
    fs.mkdirSync(dot, { recursive: true });
    expect(await worktreeHoldsSubmodules(wt)).toBe(false);
    fs.writeFileSync(path.join(dot, 'not-a-head'), 'x\n');
    expect(await worktreeHoldsSubmodules(wt)).toBe(false);
    fs.rmSync(dot, { recursive: true });
    fs.writeFileSync(dot, 'nonsense\n');
    expect(await worktreeHoldsSubmodules(wt)).toBe(false);

    fs.rmSync(dot);
    fs.mkdirSync(dot);
    fs.writeFileSync(path.join(dot, 'HEAD'), 'ref: refs/heads/main\n');
    expect(await worktreeHoldsSubmodules(wt)).toBe(true);
  }, 30_000);
});

describe('worktreeHoldsSubmodules, on an index it cannot hold', () => {
  /** Add a gitlink to the index without checking anything out. */
  function gitlink(repo: string, at: string, sha: string): void {
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${sha},${at}`);
  }

  it('reads a monorepo-sized index without giving up on it', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const blob = git(repo, 'rev-parse', 'HEAD:a.txt').trim();

    // Sorted last, so the whole index has to stream past before the answer.
    gitlink(wt, 'zz-sub', head);
    fs.mkdirSync(path.join(wt, 'zz-sub', '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(wt, 'zz-sub', '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );

    // Entries only, no files: enough of them that a buffered read of
    // `ls-files --stage` would fail, which on this gate would read as
    // "nothing here to lose" and let the next click delete the repository.
    const rows: string[] = [];
    for (let i = 0; i < 160_000; i += 1) {
      rows.push(`100644 ${blob} 0\tfiller/${String(i).padStart(9, '0')}.txt`);
    }
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: wt,
      input: `${rows.join('\n')}\n`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
    const listed = execFileSync('git', ['ls-files', '--stage', '-z'], {
      cwd: wt,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    expect(listed.length).toBeGreaterThan(10 * 1024 * 1024);

    expect(await worktreeHoldsSubmodules(wt)).toBe(true);
  }, 60_000);

  it('will not wait on a gitlink whose .git never answers', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    gitlink(wt, 'sub', git(repo, 'rev-parse', 'HEAD').trim());
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    // A FIFO blocks a reader until somebody writes, and nobody will. This
    // runs on the daemon's own thread, so waiting is every workspace and
    // every session waiting with it.
    execFileSync('mkfifo', [path.join(wt, 'sub', '.git')]);

    expect(await worktreeHoldsSubmodules(wt)).toBe(false);
  }, 20_000);
});

describe('worktreeAdminHoldsModules', () => {
  it('sees the repository the admin side keeps, initialised or not', async () => {
    const outer = makeRepo();
    const inner = makeRepo();
    git(
      outer,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      inner,
      'sub',
    );
    git(outer, 'commit', '-q', '-m', 'add submodule');
    const wt = path.join(path.dirname(outer), 'wt');
    const plain = path.join(path.dirname(outer), 'plain');
    git(outer, 'worktree', 'add', '-q', wt, '-b', 'side');
    git(outer, 'worktree', 'add', '-q', plain, '-b', 'other');

    // Registered, but nothing has built a repository under it yet.
    expect(await worktreeAdminHoldsModules(outer, wt)).toBe(false);

    git(
      wt,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '-q',
    );
    expect(await worktreeAdminHoldsModules(outer, wt)).toBe(true);
    // Answered about the worktree it was asked about: every admin entry of
    // this repository is in the same directory, and the one next door now
    // has a `modules` of its own to be confused with.
    expect(await worktreeAdminHoldsModules(outer, plain)).toBe(false);

    // `git submodule status` marks a deinitialised submodule with `-` and
    // says nothing more about it, but the repository it built is still under
    // the admin directory — and still goes with the worktree. This is the
    // whole reason the admin side is asked as well as the checkout.
    git(wt, 'submodule', 'deinit', '-f', 'sub');
    expect(await worktreeHoldsSubmodules(wt)).toBe(false);
    expect(await worktreeAdminHoldsModules(outer, wt)).toBe(true);
  }, 30_000);

  it('does not call a plain file a repository, and answers when it cannot look', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    const admin = path.join(repo, '.git', 'worktrees', 'wt');

    fs.writeFileSync(path.join(admin, 'modules'), 'not a repository\n');
    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(false);
    fs.rmSync(path.join(admin, 'modules'));

    // git refuses a removal on this directory merely existing, but an empty
    // one holds nothing to lose, and a confident sentence about a repository
    // that is not there is worse than git's own.
    fs.mkdirSync(path.join(admin, 'modules'));
    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(false);

    fs.mkdirSync(path.join(admin, 'modules', 'sub'), { recursive: true });
    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(true);
  }, 20_000);

  it('answers about this worktree, not the entry its gitfile happens to name', async () => {
    const repo = makeRepo();
    const alpha = path.join(path.dirname(repo), 'alpha');
    const beta = path.join(path.dirname(repo), 'beta');
    git(repo, 'worktree', 'add', '-q', alpha, '-b', 'a');
    git(repo, 'worktree', 'add', '-q', beta, '-b', 'b');
    const adminOf = (id: string) => path.join(repo, '.git', 'worktrees', id);

    // Renamed by hand rather than with `git worktree move`, which is an
    // ordinary mistake: beta's gitfile now names alpha's admin entry, while
    // the back-pointers still say which directory each entry was built for.
    fs.rmSync(beta, { recursive: true, force: true });
    fs.renameSync(alpha, beta);

    // Neither direction may be answered from the entry the gitfile names.
    fs.mkdirSync(path.join(adminOf('alpha'), 'modules', 'sub'), {
      recursive: true,
    });
    expect(await worktreeAdminHoldsModules(repo, beta)).toBe(false);

    fs.rmSync(path.join(adminOf('alpha'), 'modules'), { recursive: true });
    fs.mkdirSync(path.join(adminOf('beta'), 'modules', 'sub'), {
      recursive: true,
    });
    // beta's own entry still points at beta, so this one is attributed.
    fs.writeFileSync(
      path.join(adminOf('beta'), 'gitdir'),
      `${path.join(beta, '.git')}\n`,
    );
    expect(await worktreeAdminHoldsModules(repo, beta)).toBe(true);
  }, 20_000);

  it('never lets "cannot look" pass for "nothing is there"', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    const modules = path.join(repo, '.git', 'worktrees', 'wt', 'modules');
    fs.mkdirSync(path.join(modules, 'sub'), { recursive: true });

    fs.chmodSync(modules, 0o000);
    try {
      // git refuses the removal over this directory whether or not anyone
      // can list it, and the one thing that must not happen is a second
      // click that deletes it with nothing said.
      expect(await worktreeAdminHoldsModules(repo, wt)).toBe(true);
    } finally {
      fs.chmodSync(modules, 0o755);
    }

    // Nor can it even be looked at: a loop is not "nothing is there".
    fs.rmSync(modules, { recursive: true });
    fs.symlinkSync('modules', modules);
    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(true);
  }, 20_000);

  it('answers for any admin entry that points here, not just the first', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    const admin = path.join(repo, '.git', 'worktrees');
    // A stale duplicate sorting first, claiming the same worktree and
    // holding nothing: answering from it would miss the one behind it.
    fs.mkdirSync(path.join(admin, 'a-ghost'), { recursive: true });
    fs.writeFileSync(
      path.join(admin, 'a-ghost', 'gitdir'),
      `${path.join(wt, '.git')}\n`,
    );
    fs.mkdirSync(path.join(admin, 'wt', 'modules', 'sub'), { recursive: true });
    fs.rmSync(path.join(wt, '.git'));

    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(true);
  }, 20_000);

  it('falls back to the back-pointer, and will not follow a link to one', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    const admin = path.join(repo, '.git', 'worktrees', 'wt');
    fs.mkdirSync(path.join(admin, 'modules', 'sub'), { recursive: true });

    // With no gitfile there is nothing in the worktree to name its own admin
    // entry, so the back-pointers are read instead — which is the shape this
    // exists for, since git deletes that admin directory without a word once
    // the checkout is gone.
    fs.rmSync(path.join(wt, '.git'));
    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(true);

    // And read without following a symlink: what a link points at is chosen
    // by whatever wrote it, and the same reader authorises a prune. An entry
    // whose pointer is a link stays unattributed — even when the link would
    // have led to a pointer naming this very worktree.
    const elsewhere = path.join(path.dirname(repo), 'pointer');
    fs.writeFileSync(elsewhere, `${path.join(wt, '.git')}\n`);
    fs.rmSync(path.join(admin, 'gitdir'));
    fs.symlinkSync(elsewhere, path.join(admin, 'gitdir'));
    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(false);

    // Nor wait on one that never ends: a FIFO blocks a reader until somebody
    // writes, and this is a removal request's own thread.
    fs.rmSync(path.join(admin, 'gitdir'));
    execFileSync('mkfifo', [path.join(admin, 'gitdir')]);
    expect(await worktreeAdminHoldsModules(repo, wt)).toBe(false);
  }, 20_000);
});

describe('realpathOrSelf / realpathOnDiskOrSelf', () => {
  it('keeps the caller\u2019s spelling, and can ask the disk for its own', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-rp-')),
    );
    tmpRoots.push(root);
    fs.mkdirSync(path.join(root, 'MiXeD'));
    const asked = path.join(root, 'mixed');
    // One directory under two spellings only where the volume folds case;
    // where it does not, `mixed` is simply not there and both answer alike.
    const folds = fs.existsSync(asked);

    // git records the spelling it was given, so a comparison against git's
    // own listing has to keep the caller's.
    expect(realpathOrSelf(asked)).toBe(asked);
    // Deciding whether two paths are the same place is the other question.
    expect(realpathOnDiskOrSelf(asked)).toBe(
      folds ? path.join(root, 'MiXeD') : asked,
    );
  });

  it('answers for a path that is not there at all', () => {
    const gone = path.join(os.tmpdir(), 'qwen-rp-missing', 'x');
    expect(realpathOrSelf(gone)).toBe(path.resolve(gone));
    expect(realpathOnDiskOrSelf(gone)).toBe(path.resolve(gone));
  });
});

describe('dryRunGitWorktreePrune', () => {
  const adminDir = (repo: string) => path.join(repo, '.git', 'worktrees');

  it('names what prune would take, and the worktree each entry belongs to', async () => {
    const repo = makeRepo();
    const kept = path.join(path.dirname(repo), 'kept');
    const stale = path.join(path.dirname(repo), 'stale');
    git(repo, 'worktree', 'add', '-q', kept, '-b', 'keep');
    git(repo, 'worktree', 'add', '-q', stale, '-b', 'go');
    expect(await dryRunGitWorktreePrune(repo)).toEqual([]);

    fs.rmSync(path.join(stale, '.git'));
    // Litter prune names as well: neither holds a registration, a HEAD or a
    // reflog, so counting them would fail a removal over something that is
    // not a worktree at all.
    fs.writeFileSync(path.join(adminDir(repo), '.DS_Store'), '');
    fs.mkdirSync(path.join(adminDir(repo), 'leftover'));

    expect(await dryRunGitWorktreePrune(repo)).toEqual([
      { id: 'stale', worktreePath: fs.realpathSync(stale) },
    ]);
  }, 20_000);

  it('sees a registration the listing cannot show', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    fs.rmSync(path.join(adminDir(repo), 'wt', 'gitdir'));

    // Absent from `git worktree list` — it cannot be locked either — and
    // dropped by prune all the same, which is why this asks git rather than
    // reading the listing.
    expect((await listGitWorktrees(repo)).map((e) => e.isMain)).toEqual([true]);
    expect(await dryRunGitWorktreePrune(repo)).toEqual([
      { id: 'wt', worktreePath: null },
    ]);
  }, 20_000);

  it('does not let an unreadable name hide a registration', async () => {
    const repo = makeRepo();
    const target = path.join(path.dirname(repo), 'target');
    git(repo, 'worktree', 'add', '-q', target, '-b', 'go');
    fs.rmSync(path.join(target, '.git'));

    // The admin directory belongs to the repository, and git writes whatever
    // name is there into a `-v` line verbatim. A name holding a newline
    // splits that line in two, and neither half parses — so a line-by-line
    // reader loses the registration entirely and answers that the only thing
    // prune would take is the one that was asked for. It is not: prune takes
    // this one too, with the HEAD and reflog that may be the last anchor for
    // its commits.
    const ghost = path.join(adminDir(repo), 'ghost\nsecond-line');
    fs.mkdirSync(ghost);
    fs.writeFileSync(path.join(ghost, 'HEAD'), 'ref: refs/heads/ghost\n');

    const report = await dryRunGitWorktreePrune(repo);
    expect(report).toHaveLength(2);
    // Named or not, it is counted — which is what makes a caller refuse.
    expect(report.filter((one) => one.id === null)).toEqual([
      { id: null, worktreePath: null },
    ]);
  }, 20_000);

  it('reads a name git would not have chosen itself', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    // git sanitises the id it derives from a basename, but the admin
    // directory belongs to the repository. The reason follows a `: `, so the
    // id is everything before that — cut at the first colon instead, this
    // would name a directory that is not there.
    const odd = path.join(adminDir(repo), 'co: lon');
    fs.renameSync(path.join(adminDir(repo), 'wt'), odd);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${odd}\n`);
    const gone = path.join(path.dirname(repo), 'gone');
    fs.renameSync(wt, gone);
    fs.rmSync(gone, { recursive: true, force: true });

    expect(await dryRunGitWorktreePrune(repo)).toEqual([
      {
        id: 'co: lon',
        worktreePath: fs.realpathSync(path.dirname(wt)) + path.sep + 'wt',
      },
    ]);
  }, 20_000);

  it('reads a relative back-pointer against the entry that holds it', async () => {
    const repo = makeRepo();
    const wt = path.join(repo, 'nested', 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    // git writes a relative pointer under `worktree.useRelativePaths`, and
    // resolving it against the process's own directory would name whatever
    // happens to sit there.
    fs.writeFileSync(
      path.join(adminDir(repo), 'wt', 'gitdir'),
      `${path.relative(path.join(adminDir(repo), 'wt'), path.join(wt, '.git'))}\n`,
    );
    fs.rmSync(wt, { recursive: true, force: true });

    expect(await dryRunGitWorktreePrune(repo)).toEqual([
      {
        id: 'wt',
        worktreePath:
          fs.realpathSync(path.join(repo, 'nested')) + path.sep + 'wt',
      },
    ]);
  }, 20_000);

  it('will not read a pointer that says nothing', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    fs.rmSync(wt, { recursive: true, force: true });
    // Trailing whitespace is git's line ending, not part of the path; a
    // pointer that is nothing but whitespace would otherwise resolve to the
    // admin directory holding it.
    fs.writeFileSync(path.join(adminDir(repo), 'wt', 'gitdir'), '  \n');

    expect(await dryRunGitWorktreePrune(repo)).toEqual([
      { id: 'wt', worktreePath: null },
    ]);
  }, 20_000);

  it('will not read a pointer too long to be one', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    fs.rmSync(wt, { recursive: true, force: true });
    // Reading a prefix would hand back the parent of a cut-off path — a real
    // directory that was never meant, which a caller would then authorise a
    // prune against.
    fs.writeFileSync(
      path.join(adminDir(repo), 'wt', 'gitdir'),
      `${path.join(wt, '.git')}${' '.repeat(9000)}\n`,
    );

    expect(await dryRunGitWorktreePrune(repo)).toEqual([
      { id: 'wt', worktreePath: null },
    ]);
  }, 20_000);
});
