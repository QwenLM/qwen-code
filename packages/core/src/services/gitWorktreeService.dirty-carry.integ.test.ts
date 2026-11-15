/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `createUserWorktree({ carryDirtyState })` — the
 * Codex-parity overlay that applies the source checkout's uncommitted
 * changes (tracked staged + unstaged, and untracked files) to a new
 * session worktree. Real git invocations against a temp repo, mirroring
 * gitWorktreeService.symlinks.integ.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CARRIED_PATHS_MAX_BYTES,
  GitWorktreeService,
} from './gitWorktreeService.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

async function initRepo(dir: string): Promise<void> {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), 'readme-base\n');
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'clean\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init', '--no-verify');
}

/** Makes the source checkout dirty in all three shapes. */
async function makeDirty(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), 'dirty-unstaged\n');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'dirty-staged\n');
  git(root, 'add', 'tracked.txt');
  await fs.writeFile(path.join(root, 'untracked.txt'), 'dirty-untracked\n');
}

const read = (p: string) => fs.readFile(p, 'utf8');

describe('GitWorktreeService.createUserWorktree() — carryDirtyState', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoParent: string;
  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-dirty-'));
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    await initRepo(repoRoot);
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  async function create(slug: string, carryDirtyState?: boolean) {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main', {
      carryDirtyState,
    });
    expect(result.success).toBe(true);
    return result.worktree!;
  }

  it('carries unstaged, staged, and untracked changes into the worktree', async () => {
    await makeDirty(repoRoot);
    const worktree = await create('carried', true);

    expect(await read(path.join(worktree.path, 'README.md'))).toBe(
      'dirty-unstaged\n',
    );
    expect(await read(path.join(worktree.path, 'tracked.txt'))).toBe(
      'dirty-staged\n',
    );
    expect(await read(path.join(worktree.path, 'untracked.txt'))).toBe(
      'dirty-untracked\n',
    );
  });

  it('leaves the source checkout and index untouched', async () => {
    await makeDirty(repoRoot);
    // Provisioning ignores the worktrees directory through info/exclude,
    // so it must add no status entry of its own — not even a daemon
    // bookkeeping file. Compare the raw status, unfiltered.
    const statusOf = () => git(repoRoot, 'status', '--porcelain');
    const statusBefore = statusOf();
    const stashBefore = git(repoRoot, 'stash', 'list');

    const worktree = await create('source-intact', true);

    expect(statusOf()).toBe(statusBefore);
    expect(git(repoRoot, 'stash', 'list')).toBe(stashBefore);
    expect(await read(path.join(repoRoot, 'README.md'))).toBe(
      'dirty-unstaged\n',
    );
    await expect(
      fs.lstat(path.join(repoRoot, '.qwen', '.gitignore')),
    ).rejects.toThrow();
    expect(git(repoRoot, 'check-ignore', '-q', worktree.path)).toBe('');
  });

  it('carries untracked files with non-ASCII names', async () => {
    const names = ['中文.txt'];
    for (const name of names) {
      await fs.writeFile(path.join(repoRoot, name), `content:${name}\n`);
    }
    const worktree = await create('special-names', true);
    for (const name of names) {
      expect(await read(path.join(worktree.path, name))).toBe(
        `content:${name}\n`,
      );
    }
  });

  // Quotes, newlines, and trailing spaces are not representable in a Win32
  // path component; fs.writeFile would throw before the carry is exercised.
  it.skipIf(process.platform === 'win32')(
    'carries untracked files with quoted, newline, and padded names',
    async () => {
      const names = ['quote"name.txt', 'nl\nname.txt', ' pad.txt '];
      for (const name of names) {
        await fs.writeFile(path.join(repoRoot, name), `content:${name}\n`);
      }
      const worktree = await create('special-names-win', true);
      for (const name of names) {
        expect(await read(path.join(worktree.path, name))).toBe(
          `content:${name}\n`,
        );
      }
    },
  );

  it('keeps the worktree HEAD at the base commit (no baseline commit)', async () => {
    await makeDirty(repoRoot);
    const sourceHead = git(repoRoot, 'rev-parse', 'HEAD');
    const worktree = await create('no-baseline', true);
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(sourceHead);
  });

  it('captures dirty state from dirtyStateSource, not the placement root', async () => {
    const service = new GitWorktreeService(repoRoot);
    // A source checkout (managed worktree) with its own commit and
    // untracked file; the main checkout has a different untracked file.
    const source = await service.createUserWorktree('source', 'main', {
      detached: true,
    });
    expect(source.success).toBe(true);
    const sourcePath = source.worktree!.path;
    await fs.writeFile(path.join(sourcePath, 'src.txt'), 'source-work\n');
    git(sourcePath, 'add', 'src.txt');
    git(sourcePath, 'commit', '-qm', 'source work', '--no-verify');
    const sourceHead = git(sourcePath, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(sourcePath, 'src-untracked.txt'), 'src\n');
    await fs.writeFile(path.join(repoRoot, 'main-untracked.txt'), 'main\n');

    const child = await service.createUserWorktree('child', sourceHead, {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: sourcePath,
    });
    expect(child.success).toBe(true);
    const childPath = child.worktree!.path;
    expect(git(childPath, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(await read(path.join(childPath, 'src-untracked.txt'))).toBe('src\n');
    await expect(
      read(path.join(childPath, 'main-untracked.txt')),
    ).rejects.toThrow();
  });

  it('escapes gitignore metacharacters in the exclude rule', async () => {
    // A route-style directory with a glob metacharacter: the raw path
    // would become a character class matching nothing.
    const sub = path.join(repoRoot, 'app', '[id]');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'README.md'), 'sub\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'route dir', '--no-verify');
    const service = new GitWorktreeService(sub);
    const created = await service.createUserWorktree('meta', 'main', {
      detached: true,
    });
    expect(created.success).toBe(true);
    // The worktrees directory must actually be ignored from the sub root.
    const probe = path.join(sub, '.qwen', 'worktrees', 'probe');
    const rc = gitOk(sub, 'check-ignore', '-q', '--', probe);
    expect(rc).toBe(true);
  });

  it('keeps a tracked legacy .qwen/.gitignore instead of migrating it', async () => {
    // A committed bookkeeping file is the user's content: unlinking it
    // would turn a clean checkout dirty.
    await fs.mkdir(path.join(repoRoot, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.qwen', '.gitignore'),
      '# Auto-generated by qwen-code.\nworktrees/\n',
    );
    git(repoRoot, 'add', '.qwen/.gitignore');
    git(repoRoot, 'commit', '-qm', 'tracked bookkeeping', '--no-verify');
    const worktree = await create('tracked-legacy', true);
    expect(worktree.path).toBeTruthy();
    expect(await read(path.join(repoRoot, '.qwen', '.gitignore'))).toBe(
      '# Auto-generated by qwen-code.\nworktrees/\n',
    );
    expect(git(repoRoot, 'status', '--porcelain')).toBe('');
  });

  it('removePreparedUserWorktree removes a carried-overlay worktree at base', async () => {
    await makeDirty(repoRoot);
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('prepared', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    // The carried overlay keeps the tree dirty; the rollback must still
    // succeed because HEAD is at base and the source holds the originals.
    const removed = await service.removePreparedUserWorktree(
      'prepared',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(true);
    await expect(fs.lstat(created.worktree!.path)).rejects.toThrow();
  });

  it('prepared rollback still refuses a non-carried file alongside the overlay', async () => {
    await makeDirty(repoRoot);
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('prepared-extra', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    // A file that is NOT part of the carried overlay must still refuse.
    await fs.writeFile(
      path.join(created.worktree!.path, 'intruder.txt'),
      'not carried\n',
    );
    const removed = await service.removePreparedUserWorktree(
      'prepared-extra',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(false);
    expect(removed.error).toBe('Worktree contains changes');
  });

  // core.quotepath C-quotes these names in line-based status output; the
  // exemption compares raw carried paths, so a quoted form would strand
  // the worktree and its journal forever.
  const rollbackWithNames = async (slug: string, names: string[]) => {
    await makeDirty(repoRoot);
    for (const name of names) {
      await fs.writeFile(path.join(repoRoot, name), `content:${name}\n`);
    }
    // A source-side staged rename lands as delete + untracked after the
    // stash apply (no --index); both names must be exempt.
    git(repoRoot, 'mv', 'tracked.txt', 'renamed.txt');
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree(slug, 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    const removed = await service.removePreparedUserWorktree(
      slug,
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(true);
    await expect(fs.lstat(created.worktree!.path)).rejects.toThrow();
  };

  it('prepared rollback removes a carried overlay with special-character names', async () => {
    await rollbackWithNames('prepared-special', ['中文.txt']);
  });

  // Quotes, newlines, and trailing spaces are not representable in a Win32
  // path component; fs.writeFile would throw before the carry is exercised.
  it.skipIf(process.platform === 'win32')(
    'prepared rollback removes a carried overlay with quoted/newline/padded names',
    async () => {
      await rollbackWithNames('prepared-special-win', [
        'quote"name.txt',
        'nl\nname.txt',
        ' pad.txt ',
      ]);
    },
  );

  it('prepared rollback removes a carried overlay with an untracked directory', async () => {
    // The carry records file-level paths; a directory-collapsing listing
    // ("Would remove dir/") would never match the exemption set.
    await makeDirty(repoRoot);
    await fs.mkdir(path.join(repoRoot, 'dir', 'sub'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'dir', 'a.txt'), 'a\n');
    await fs.writeFile(path.join(repoRoot, 'dir', 'sub', 'b.txt'), 'b\n');
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('prepared-dir', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    const removed = await service.removePreparedUserWorktree(
      'prepared-dir',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(true);
    await expect(fs.lstat(created.worktree!.path)).rejects.toThrow();
  });

  it('prepared rollback refuses index surgery inside the worktree', async () => {
    await makeDirty(repoRoot);
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('prepared-mv', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    // The carry never stages anything; a rename record means the index
    // was touched inside this never-attached worktree.
    git(created.worktree!.path, 'mv', 'README.md', 'moved.md');
    const removed = await service.removePreparedUserWorktree(
      'prepared-mv',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(false);
    expect(removed.error).toBe('Worktree contains changes');
  });

  it('without the option the worktree holds only committed state', async () => {
    await makeDirty(repoRoot);
    const worktree = await create('opt-out');

    expect(await read(path.join(worktree.path, 'README.md'))).toBe(
      'readme-base\n',
    );
    expect(await read(path.join(worktree.path, 'tracked.txt'))).toBe('clean\n');
    await expect(
      read(path.join(worktree.path, 'untracked.txt')),
    ).rejects.toThrow();
  });

  it('places untracked files at the repository offset when rooted at a subdirectory', async () => {
    const sub = path.join(repoRoot, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 't.txt'), 'clean\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'sub', '--no-verify');
    await fs.writeFile(path.join(sub, 't.txt'), 'dirty-staged\n');
    git(repoRoot, 'add', 'sub/t.txt');
    await fs.writeFile(path.join(sub, 'u.txt'), 'dirty-untracked\n');

    const service = new GitWorktreeService(sub);
    const result = await service.createUserWorktree('subdir', 'main', {
      carryDirtyState: true,
    });
    expect(result.success).toBe(true);
    const wtPath = result.worktree!.path;
    expect(await read(path.join(wtPath, 'sub', 't.txt'))).toBe(
      'dirty-staged\n',
    );
    expect(await read(path.join(wtPath, 'sub', 'u.txt'))).toBe(
      'dirty-untracked\n',
    );
  });

  it('fails open when an untracked file cannot be copied', async () => {
    await makeDirty(repoRoot);
    // A dangling symlink is listed by ls-files --others; creation must
    // still succeed with the remaining overlay applied.
    await fs.symlink(
      path.join(repoRoot, 'missing-target'),
      path.join(repoRoot, 'broken-link'),
    );

    const worktree = await create('fail-open', true);

    expect(await read(path.join(worktree.path, 'README.md'))).toBe(
      'dirty-unstaged\n',
    );
    expect(await read(path.join(worktree.path, 'untracked.txt'))).toBe(
      'dirty-untracked\n',
    );
  });

  it('prepared rollback removes a carried overlay with a content-preserving rename', async () => {
    // No prior edit: git detects the rename, and the capture must still
    // name BOTH sides (--no-renames) — the applied overlay presents
    // `A moved.md` plus ` D README.md`, and a destination-only list would
    // leave the deletion side unexempt and refuse the rollback forever.
    git(repoRoot, 'mv', 'README.md', 'moved.md');
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree(
      'prepared-rename',
      'main',
      {
        detached: true,
        carryDirtyState: true,
      },
    );
    expect(created.success).toBe(true);
    expect(created.carriedPaths).toContain('README.md');
    expect(created.carriedPaths).toContain('moved.md');
    const removed = await service.removePreparedUserWorktree(
      'prepared-rename',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(true);
    await expect(fs.lstat(created.worktree!.path)).rejects.toThrow();
  });

  it('carries untracked symlinks as links, not materialized files', async () => {
    await fs.writeFile(path.join(repoRoot, 'real.txt'), 'target-content\n');
    await fs.symlink('real.txt', path.join(repoRoot, 'link.txt'));
    await fs.mkdir(path.join(repoRoot, 'some-dir'));
    await fs.writeFile(path.join(repoRoot, 'some-dir', 'inner.txt'), 'inner\n');
    await fs.symlink('some-dir', path.join(repoRoot, 'dir-link'));
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('symlinks', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    // copyFile would dereference link.txt into a regular file holding the
    // target's bytes (committable out-of-repo content) and drop dir-link
    // with EISDIR.
    expect((await fs.lstat(path.join(wt, 'link.txt'))).isSymbolicLink()).toBe(
      true,
    );
    expect(await fs.readlink(path.join(wt, 'link.txt'))).toBe('real.txt');
    expect((await fs.lstat(path.join(wt, 'dir-link'))).isSymbolicLink()).toBe(
      true,
    );
    const removed = await service.removePreparedUserWorktree(
      'symlinks',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(true);
  });

  it('skips an overlay too large to record in the preparation journal', async () => {
    // The journal reader refuses records above 64 KiB; an unbounded
    // carriedPaths list would make every later phase transition throw and
    // strand the worktree. Above the bound the carry is skipped entirely
    // (fail-open to committed state), keeping the worktree rollbackable.
    const prefix = 'long-';
    const filler = 'x'.repeat(60);
    for (let i = 0; i < 500; i++) {
      const name = `${prefix}${String(i).padStart(4, '0')}-${filler}.txt`;
      await fs.writeFile(path.join(repoRoot, name), 'bulk\n');
    }
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('bulk', 'main', {
      detached: true,
      carryDirtyState: true,
      maxCarriedPathsBytes: CARRIED_PATHS_MAX_BYTES,
    });
    expect(created.success).toBe(true);
    expect(created.carriedPaths).toBeUndefined();
    await expect(
      fs.lstat(
        path.join(created.worktree!.path, `${prefix}0000-${filler}.txt`),
      ),
    ).rejects.toThrow();
    const removed = await service.removePreparedUserWorktree(
      'bulk',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(true);
  });

  it('measures the carry bound in UTF-8 bytes, not characters', async () => {
    // 3000 names of 2 CJK chars + 4 digits: ~27K characters (under the
    // 32KiB bound) but ~39K UTF-8 bytes (over it). A character-count
    // bound would carry an overlay the journal reader must refuse.
    for (let i = 0; i < 3000; i++) {
      await fs.writeFile(
        path.join(repoRoot, `中中${String(i).padStart(4, '0')}`),
        'x\n',
      );
    }
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('bulk-cjk', 'main', {
      detached: true,
      carryDirtyState: true,
      maxCarriedPathsBytes: CARRIED_PATHS_MAX_BYTES,
    });
    expect(created.success).toBe(true);
    expect(created.carriedPaths).toBeUndefined();
  });

  it('migration establishes the exclude rule before removing the legacy file', async () => {
    const worktree = await create('legacy-upgrade', true);
    // Simulate a pre-PR checkout: the exclude rule is gone and the legacy
    // daemon file is the only mechanism hiding the managed directory.
    const excludeRel = git(repoRoot, 'rev-parse', '--git-path', 'info/exclude');
    await fs.writeFile(path.resolve(repoRoot, excludeRel), '', 'utf8');
    await fs.mkdir(path.join(repoRoot, '.qwen'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.qwen', '.gitignore'),
      '# Auto-generated by qwen-code.\nworktrees/\n',
    );
    expect(git(repoRoot, 'status', '--porcelain')).toContain('.qwen/');

    const service = new GitWorktreeService(repoRoot);
    await service.migrateLegacyWorktreeGitignore();

    await expect(
      fs.lstat(path.join(repoRoot, '.qwen', '.gitignore')),
    ).rejects.toThrow();
    // The replacement exists before the old mechanism was removed: the
    // checkout reads clean and the managed directory stays ignored.
    expect(git(repoRoot, 'status', '--porcelain')).toBe('');
    expect(gitOk(repoRoot, 'check-ignore', '-q', worktree.path)).toBe(true);
  });

  it('fails closed when the carried snapshot conflicts with the base', async () => {
    // A sibling checkout dirty on the same lines the workspace HEAD
    // touched: the 3-way stash apply conflicts. The worktree must not
    // survive with conflict markers / unmerged index entries.
    await fs.writeFile(path.join(repoRoot, 'f.txt'), 'line1\nBASE\nline3\n');
    git(repoRoot, 'add', 'f.txt');
    git(repoRoot, 'commit', '-qm', 'f base', '--no-verify');
    const service = new GitWorktreeService(repoRoot);
    const sibling = await service.createUserWorktree('sibling', 'main', {
      detached: true,
    });
    expect(sibling.success).toBe(true);
    const siblingPath = sibling.worktree!.path;
    await fs.writeFile(
      path.join(siblingPath, 'f.txt'),
      'line1\nDIRTY\nline3\n',
    );
    // Advance the workspace HEAD on the same lines.
    await fs.writeFile(path.join(repoRoot, 'f.txt'), 'line1\nOTHER\nline3\n');
    git(repoRoot, 'add', 'f.txt');
    git(repoRoot, 'commit', '-qm', 'f other', '--no-verify');

    const created = await service.createUserWorktree('conflict', 'main', {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: siblingPath,
    });
    expect(created.success).toBe(false);
    expect(created.error).toContain('conflicted');
    // No poisoned checkout left behind.
    await expect(
      fs.lstat(service.getUserWorktreePath('conflict')),
    ).rejects.toThrow();
  });

  it('carries repo-root untracked files when rooted at a subdirectory', async () => {
    const sub = path.join(repoRoot, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 't.txt'), 'clean\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'sub', '--no-verify');
    // Untracked at the repo root AND in the subtree: both halves of the
    // overlay must cover the same repository-wide set.
    await fs.writeFile(path.join(repoRoot, 'root-untracked.txt'), 'root\n');
    await fs.writeFile(path.join(sub, 'sub-untracked.txt'), 'sub\n');

    const service = new GitWorktreeService(sub);
    const created = await service.createUserWorktree('subroot', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    expect(await read(path.join(wt, 'root-untracked.txt'))).toBe('root\n');
    expect(await read(path.join(wt, 'sub', 'sub-untracked.txt'))).toBe('sub\n');
    expect(created.carriedPaths).toContain('root-untracked.txt');
  });

  it('skips an uncopyable entry without aborting the carry', async () => {
    // The source holds an untracked DIRECTORY x/y.txt while the worktree
    // base has a tracked FILE x: mkdir(x) in the worktree fails, the loop
    // must skip that entry and still carry the rest.
    await fs.writeFile(path.join(repoRoot, 'x'), 'tracked-file\n');
    git(repoRoot, 'add', 'x');
    git(repoRoot, 'commit', '-qm', 'x file', '--no-verify');
    const service = new GitWorktreeService(repoRoot);
    const sibling = await service.createUserWorktree('sibling2', 'main', {
      detached: true,
    });
    expect(sibling.success).toBe(true);
    const siblingPath = sibling.worktree!.path;
    await fs.rm(path.join(siblingPath, 'x'));
    await fs.mkdir(path.join(siblingPath, 'x'));
    await fs.writeFile(path.join(siblingPath, 'x', 'y.txt'), 'nested\n');
    await fs.writeFile(path.join(siblingPath, 'ok.txt'), 'ok\n');

    const created = await service.createUserWorktree('skipfail', 'main', {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: siblingPath,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    expect(await read(path.join(wt, 'ok.txt'))).toBe('ok\n');
    // x stays the tracked file; the uncopyable directory entry was skipped.
    expect(await read(path.join(wt, 'x'))).toBe('tracked-file\n');
  });

  it('writes the exclude rule for an in-root directory named ..cache', async () => {
    // A '..' PREFIX is not a parent segment: a service rooted under an
    // in-root '..cache' directory yields rel '..cache/sub/.qwen/worktrees',
    // which must still get a working rule (the old prefix test skipped it).
    const cacheSub = path.join(repoRoot, '..cache', 'sub');
    await fs.mkdir(cacheSub, { recursive: true });
    const service = new GitWorktreeService(cacheSub);
    const created = await service.createUserWorktree('dotdot', 'main', {
      detached: true,
    });
    expect(created.success).toBe(true);
    expect(gitOk(repoRoot, 'check-ignore', '-q', created.worktree!.path)).toBe(
      true,
    );
  });

  it('keeps the legacy file when the exclude rule cannot be established', async () => {
    // A newline-bearing component cannot be represented in info/exclude;
    // the migration must keep the legacy file (the only hiding mechanism)
    // rather than unlink it and leave .qwen/ permanently untracked.
    const nlSub = path.join(repoRoot, 'nl\nsub');
    await fs.mkdir(nlSub);
    const service = new GitWorktreeService(nlSub);
    const legacy = path.join(nlSub, '.qwen', '.gitignore');
    await fs.mkdir(path.join(nlSub, '.qwen'), { recursive: true });
    await fs.writeFile(legacy, '# Auto-generated by qwen-code.\nworktrees/\n');
    await service.migrateLegacyWorktreeGitignore();
    // The rule was not representable: the legacy file survives.
    expect(await read(legacy)).toBe(
      '# Auto-generated by qwen-code.\nworktrees/\n',
    );
  });

  it('carries a large overlay when no journal bound is set', async () => {
    // The handoff and POST /session write no journal: a >32KiB overlay
    // must still be carried, not silently dropped.
    const prefix = 'long-';
    const filler = 'x'.repeat(60);
    for (let i = 0; i < 500; i++) {
      await fs.writeFile(
        path.join(
          repoRoot,
          `${prefix}${String(i).padStart(4, '0')}-${filler}.txt`,
        ),
        'bulk\n',
      );
    }
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('bigcarry', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    expect(created.carriedPaths).toBeDefined();
    expect(created.carriedPaths!.length).toBeGreaterThanOrEqual(500);
    expect(
      await read(
        path.join(created.worktree!.path, `${prefix}0000-${filler}.txt`),
      ),
    ).toBe('bulk\n');
  });
});
