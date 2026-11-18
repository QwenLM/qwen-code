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
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CARRIED_PATHS_MAX_BYTES,
  GitWorktreeService,
  WorktreeDirtyCarryConflictError,
  worktreeHasWork,
} from './gitWorktreeService.js';
import { arePermissionBitsEnforced } from '../test-utils/permission-bits.js';

// Whether the host filesystem folds final sigma (ς, U+03C2) to sigma (σ,
// U+03C3) as one path — true on macOS's default case-insensitive volumes, false
// on Linux. Gates the Sigma-alias regression so it runs only where the alias is
// real; the hard-link identity test below witnesses the same guard on every host.
const fsFoldsFinalSigma = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qwen-sigma-probe-'));
    writeFileSync(path.join(dir, '\u03c2.env'), '');
    const a = statSync(path.join(dir, '\u03c2.env'));
    const b = statSync(path.join(dir, '\u03c3.env'));
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover probe must not fail the test file.
      }
    }
  }
})();

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

  it('prepared rollback removes a sparse-repo worktree (R4-3)', async () => {
    // A sparse repo stamps skip-worktree on out-of-cone paths; the prepared
    // gate's sparse carve-out must allow them so the rollback is not stranded.
    await fs.mkdir(path.join(repoRoot, 'cone'));
    await fs.mkdir(path.join(repoRoot, 'other'));
    await fs.writeFile(path.join(repoRoot, 'cone', 'a.txt'), 'a\n');
    await fs.writeFile(path.join(repoRoot, 'other', 'b.txt'), 'b\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'sparse', '--no-verify');
    git(repoRoot, 'sparse-checkout', 'init', '--cone');
    git(repoRoot, 'sparse-checkout', 'set', 'cone');
    await makeDirty(repoRoot);
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree(
      'prepared-sparse',
      'main',
      {
        detached: true,
        carryDirtyState: true,
      },
    );
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    expect(git(wt, 'ls-files', '-v')).toContain('S other/b.txt');
    const removed = await service.removePreparedUserWorktree(
      'prepared-sparse',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );
    expect(removed.success).toBe(true);
    await expect(fs.lstat(wt)).rejects.toThrow();
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

  it('carries a tracked file deleted into a directory of the same name (R8-5)', async () => {
    // Source: tracked FILE x deleted and replaced by directory x/y.txt (the
    // user moved a file into a folder). `git stash create` cannot represent
    // this file→directory shape — the stash omits the deletion and
    // `stash show --name-only` names nothing — so the carry must remove the
    // target's tracked file explicitly and land the untracked directory
    // content rather than resurrect the file and report a complete carry.
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

    const created = await service.createUserWorktree('filetodir', 'main', {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: siblingPath,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    expect(await read(path.join(wt, 'ok.txt'))).toBe('ok\n');
    // The deletion is carried: x is the directory, not the resurrected file.
    expect((await fs.lstat(path.join(wt, 'x'))).isDirectory()).toBe(true);
    expect(await read(path.join(wt, 'x', 'y.txt'))).toBe('nested\n');
    expect(created.carriedPaths).toContain('x');
    expect(created.carriedPaths).toContain('x/y.txt');
  });

  it('does not delete an unrelated file when a rename origin record looks like a deletion (R8-5)', async () => {
    // A tracked file literally named `aD sub` is renamed; `git status -z`
    // emits the paired origin record `aD sub`, whose characters a
    // shape-guessing parser misreads as a deleted path `sub`. With `sub/` a
    // directory in the source and the target base tracking `sub` as a file,
    // the misparse would delete the target's unrelated `sub`. The paired
    // origin record must be skipped structurally.
    await fs.writeFile(path.join(repoRoot, 'aD sub'), 'rename-me\n');
    git(repoRoot, 'add', 'aD sub');
    git(repoRoot, 'commit', '-qm', 'c0', '--no-verify');
    const service = new GitWorktreeService(repoRoot);
    const sibling = await service.createUserWorktree('rename-src', 'main', {
      detached: true,
    });
    expect(sibling.success).toBe(true);
    const siblingPath = sibling.worktree!.path;
    // `sub` is an untracked DIRECTORY in the source (not a tracked deletion).
    await fs.mkdir(path.join(siblingPath, 'sub'));
    await fs.writeFile(path.join(siblingPath, 'sub', 'inner.txt'), 'u\n');
    git(siblingPath, 'mv', 'aD sub', 'renamed.txt');
    // The target base tracks `sub` as a FILE.
    await fs.writeFile(path.join(repoRoot, 'sub'), 'keep-me\n');
    git(repoRoot, 'add', 'sub');
    git(repoRoot, 'commit', '-qm', 'c1', '--no-verify');

    const created = await service.createUserWorktree('rename-target', 'main', {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: siblingPath,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    // The unrelated tracked `sub` file must survive the carry.
    expect(await read(path.join(wt, 'sub'))).toBe('keep-me\n');
    expect(created.carriedPaths ?? []).not.toContain('sub');
  });

  it('skips an uncopyable untracked entry without aborting the rest of the carry', async () => {
    // The target base tracks out -> outside; the capture predates the link
    // and holds untracked out/escape.txt (uncopyable: the ancestor symlink
    // would escape the checkout) plus a carryable ok.txt. The skip must not
    // abort the remainder, and the skipped entry is not recorded.
    const service = new GitWorktreeService(repoRoot);
    const capture = await service.createUserWorktree('capture-skip', 'main', {
      detached: true,
    });
    expect(capture.success).toBe(true);
    const capturePath = capture.worktree!.path;
    const outside = path.join(repoParent, 'outside-skip');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(repoRoot, 'out'));
    git(repoRoot, 'add', 'out');
    git(repoRoot, 'commit', '-qm', 'out link', '--no-verify');
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    await fs.mkdir(path.join(capturePath, 'out'), { recursive: true });
    await fs.writeFile(path.join(capturePath, 'out', 'escape.txt'), 'escape\n');
    await fs.writeFile(path.join(capturePath, 'ok.txt'), 'ok\n');

    const created = await service.createUserWorktree('target-skip', base, {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: capturePath,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    expect(await read(path.join(wt, 'ok.txt'))).toBe('ok\n');
    await expect(fs.lstat(path.join(outside, 'escape.txt'))).rejects.toThrow();
    expect(created.carriedPaths ?? []).not.toContain('out/escape.txt');
  });

  it.skipIf(!arePermissionBitsEnforced())(
    'createUserWorktree carry refuses when stash create fails on an unwritable object store (R8-6)',
    async () => {
      // A tracked edit exists, but `git stash create` cannot write the stash
      // commit. A held index.lock is NOT a portable injection: stash create
      // does not lock the index (only apply/reset do), so it sailed through on
      // the CI fleet's git. An unwritable object store blocks the create on
      // every git build/user, while worktree add (which only reads objects)
      // still succeeds first. An empty carry here is NOT a clean source: the
      // carry-requested creation must refuse rather than relocate the session
      // without the user's edits and report success with an empty overlay.
      await fs.writeFile(path.join(repoRoot, 'README.md'), 'edited\n');
      const gitDir = git(repoRoot, 'rev-parse', '--absolute-git-dir');
      const objectsDir = path.join(gitDir, 'objects');
      // Block every object-write path: the objects dir itself (new fanout
      // mkdir) and any existing fanout/pack subdirs (new loose object / pack).
      const setObjectsMode = async (mode: number) => {
        await fs.chmod(objectsDir, mode).catch(() => undefined);
        for (const entry of await fs.readdir(objectsDir).catch(() => [])) {
          const p = path.join(objectsDir, entry);
          if ((await fs.lstat(p).catch(() => null))?.isDirectory()) {
            await fs.chmod(p, mode).catch(() => undefined);
          }
        }
      };
      await setObjectsMode(0o555);
      const service = new GitWorktreeService(repoRoot);
      let created: Awaited<ReturnType<typeof service.createUserWorktree>>;
      try {
        created = await service.createUserWorktree('objfail', 'main', {
          detached: true,
          carryDirtyState: true,
        });
      } finally {
        await setObjectsMode(0o755);
      }
      expect(created.success).toBe(false);
      expect(created.error).toContain('dirty state');
      // A genuine environment fault keeps the hard refusal: it is NOT the
      // user-clearable merge state, so it carries no typed 409 code (R12-1).
      expect(created.code).toBeUndefined();
      // No checkout left behind for a refused carry.
      await expect(
        fs.lstat(service.getUserWorktreePath('objfail')),
      ).rejects.toThrow();
      // The source edit is untouched.
      expect(await read(path.join(repoRoot, 'README.md'))).toBe('edited\n');
    },
  );

  it('createUserWorktree carry refuses a silent stash create failure (R8-6)', async () => {
    // The silent failure class: some git builds exit `stash create` non-zero
    // writing NOTHING to either stream (git 2.39.5 with a held index.lock).
    // A git shim forces that mode portably — `stash create` exits 1 with empty
    // stdout/stderr, every other command delegates to real git. simple-git's
    // default detection resolves that as an empty "nothing to carry"; the
    // exit-code detection must surface it so the carry is refused rather than
    // silently dropping the tracked overlay.
    await fs.writeFile(path.join(repoRoot, 'tracked.txt'), 'dirty\n');
    const realGit = execFileSync('bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-git-shim-'));
    const shim = path.join(shimDir, 'git');
    // Scan for consecutive `stash create` args rather than $1/$2: the loader
    // prepends `-c` config flags before the subcommand, so the subcommand is
    // not at a fixed position.
    await fs.writeFile(
      shim,
      `#!/bin/bash\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "stash" ] && [ "$a" = "create" ]; then exit 1; fi\n  prev="$a"\ndone\nexec ${realGit} "$@"\n`,
    );
    await fs.chmod(shim, 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${shimDir}:${originalPath}`;
    const service = new GitWorktreeService(repoRoot);
    let created: Awaited<ReturnType<typeof service.createUserWorktree>>;
    try {
      created = await service.createUserWorktree('silentfail', 'main', {
        detached: true,
        carryDirtyState: true,
      });
    } finally {
      process.env['PATH'] = originalPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
    expect(created.success).toBe(false);
    expect(created.error).toContain('dirty state');
    // The silent failure is an environment fault, not the user-clearable merge
    // state, so it carries no typed 409 code.
    expect(created.code).toBeUndefined();
    await expect(
      fs.lstat(service.getUserWorktreePath('silentfail')),
    ).rejects.toThrow();
    expect(await read(path.join(repoRoot, 'tracked.txt'))).toBe('dirty\n');
  });

  it('createStashSnapshot rejects a silent stash create failure (R13-1)', async () => {
    // The handoff-direction snapshot capture must judge by exit status too:
    // a silent non-zero `stash create` resolves as '' under default detection,
    // which the handoff would read as a clean tree and relocate the session
    // without the worktree's tracked edits. Same portable shim as R8-6.
    await fs.writeFile(path.join(repoRoot, 'tracked.txt'), 'dirty\n');
    const realGit = execFileSync('bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-git-shim-'));
    const shim = path.join(shimDir, 'git');
    await fs.writeFile(
      shim,
      `#!/bin/bash\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "stash" ] && [ "$a" = "create" ]; then exit 1; fi\n  prev="$a"\ndone\nexec ${realGit} "$@"\n`,
    );
    await fs.chmod(shim, 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${shimDir}:${originalPath}`;
    const service = new GitWorktreeService(repoRoot);
    try {
      await expect(service.createStashSnapshot(repoRoot)).rejects.toThrow(
        'exited with code 1',
      );
    } finally {
      process.env['PATH'] = originalPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
    // A genuinely clean tree still yields '' (exit 0, no output): the detector
    // adds exit-status detection only, it does not treat empty output as failure.
    await execFileSync('git', ['checkout', '--', 'tracked.txt'], {
      cwd: repoRoot,
    });
    expect(await service.createStashSnapshot(repoRoot)).toBe('');
  });

  it('forceCheckoutBranch rejects a silent checkout failure (round-10 S19)', async () => {
    // The handoff rollback judges its restore by forceCheckoutBranch's result.
    // A silent non-zero `checkout -f` (exit 1, empty stderr) resolves under
    // default detection, so the rollback would report a successful restore that
    // never happened and the refusal would overclaim. Same portable shim class
    // as R13-1: scan consecutive `checkout -f` args (the loader prepends -c).
    const realGit = execFileSync('bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-git-shim-'));
    const shim = path.join(shimDir, 'git');
    await fs.writeFile(
      shim,
      `#!/bin/bash\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "checkout" ] && [ "$a" = "-f" ]; then exit 1; fi\n  prev="$a"\ndone\nexec ${realGit} "$@"\n`,
    );
    await fs.chmod(shim, 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${shimDir}:${originalPath}`;
    const service = new GitWorktreeService(repoRoot);
    try {
      await expect(
        service.forceCheckoutBranch(repoRoot, 'main'),
      ).rejects.toThrow('exited with code 1');
    } finally {
      process.env['PATH'] = originalPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
    // A healthy force-checkout still succeeds (exit 0): the detector adds
    // exit-status detection only, it does not treat a clean checkout as failure.
    await service.forceCheckoutBranch(repoRoot, 'main');
  });

  it('refuses a carry on an unmerged index with a typed merge-in-progress code (R12-1)', async () => {
    // A real conflicted merge: `git stash create` cannot run on an unmerged
    // index. That is a state the user can clear (resolve/abort), not a daemon
    // fault, so the carry-requested creation must surface a typed code the
    // route maps to a readable 409 rather than a 500.
    git(repoRoot, 'checkout', '-q', '-b', 'side');
    await fs.writeFile(path.join(repoRoot, 'tracked.txt'), 'side\n');
    git(repoRoot, 'add', 'tracked.txt');
    git(repoRoot, 'commit', '-qm', 'side', '--no-verify');
    git(repoRoot, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(repoRoot, 'tracked.txt'), 'main\n');
    git(repoRoot, 'add', 'tracked.txt');
    git(repoRoot, 'commit', '-qm', 'main edit', '--no-verify');
    expect(gitOk(repoRoot, 'merge', 'side')).toBe(false);
    expect(git(repoRoot, 'ls-files', '-u')).not.toBe('');

    const service = new GitWorktreeService(repoRoot);
    const created = await service.createUserWorktree('merge-state', 'main', {
      detached: true,
      carryDirtyState: true,
    });
    expect(created.success).toBe(false);
    expect(created.code).toBe('worktree_merge_in_progress');
    // The fresh worktree was removed; no checkout is left behind.
    await expect(
      fs.lstat(service.getUserWorktreePath('merge-state')),
    ).rejects.toThrow();
  });

  it.skipIf(!arePermissionBitsEnforced())(
    'removeDeletedToDirectoryFiles fails closed when the target file cannot be hashed (R11-4)',
    async () => {
      // The source deletes tracked README.md into a directory; the target's
      // README.md is the committed base version but mode 000, so hash-object
      // cannot answer. The guard must refuse rather than delete a file it
      // could not verify (the old `dstBlob !== null && …` skip deleted it).
      const service = new GitWorktreeService(repoRoot);
      const wt = await service.createUserWorktree('r114-hash', 'main', {
        detached: true,
      });
      expect(wt.success).toBe(true);
      const wtPath = wt.worktree!.path;
      await fs.rm(path.join(wtPath, 'README.md'));
      await fs.mkdir(path.join(wtPath, 'README.md'));
      await fs.writeFile(
        path.join(wtPath, 'README.md', 'agent.txt'),
        'agent\n',
      );
      const targetReadme = path.join(repoRoot, 'README.md');
      await fs.chmod(targetReadme, 0o000);
      const wtService = new GitWorktreeService(wtPath);
      try {
        await expect(
          wtService.removeDeletedToDirectoryFiles(repoRoot),
        ).rejects.toMatchObject({ conflict: true });
        expect(existsSync(targetReadme)).toBe(true);
      } finally {
        await fs.chmod(targetReadme, 0o644);
      }
    },
  );

  it('removeDeletedToDirectoryFiles fails closed when HEAD cannot resolve the path (R11-4)', async () => {
    // An AD record (staged add, then deleted into a directory) names a path
    // absent from HEAD, so srcBlob is null. The target holds a regular file
    // at that path; the guard must refuse rather than delete it unchecked
    // (the old `if (srcBlob === null) continue` skip deleted it).
    const service = new GitWorktreeService(repoRoot);
    const wt = await service.createUserWorktree('r114-ad', 'main', {
      detached: true,
    });
    expect(wt.success).toBe(true);
    const wtPath = wt.worktree!.path;
    await fs.writeFile(path.join(wtPath, 'extra.txt'), 'staged\n');
    git(wtPath, 'add', 'extra.txt');
    await fs.rm(path.join(wtPath, 'extra.txt'));
    await fs.mkdir(path.join(wtPath, 'extra.txt'));
    await fs.writeFile(path.join(wtPath, 'extra.txt', 'inner.txt'), 'inner\n');
    // The target has its own regular file at that path (not in the base HEAD).
    const targetExtra = path.join(repoRoot, 'extra.txt');
    await fs.writeFile(targetExtra, 'local\n');
    const wtService = new GitWorktreeService(wtPath);
    await expect(
      wtService.removeDeletedToDirectoryFiles(repoRoot),
    ).rejects.toMatchObject({ conflict: true });
    expect(existsSync(targetExtra)).toBe(true);
    expect(await read(targetExtra)).toBe('local\n');
  });

  it('applyStashSnapshot refuses to overwrite an ignored local file (R12-2)', async () => {
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'secret.env\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await fs.writeFile(path.join(repoRoot, 'secret.env'), 'LOCAL_UNIQUE\n');
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r122-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.writeFile(path.join(srcPath, 'secret.env'), 'AGENT_TEMPLATE\n');
    git(srcPath, 'add', '-f', 'secret.env');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toMatchObject({ conflict: true, restoreFailed: false });
    expect(await read(path.join(repoRoot, 'secret.env'))).toBe(
      'LOCAL_UNIQUE\n',
    );
  });

  it('applyStashSnapshot guards ignored files from a subdirectory checkout (R15-1)', async () => {
    // The target checkout is repoRoot/app, but the snapshot's paths and the
    // apply are repository-wide. The colliding ignored file sits at the repo
    // ROOT, OUTSIDE the app/ subtree: an ls-files run from the subdir lists
    // only that subtree (even with --full-name) and would miss it entirely.
    // The guard must enumerate from the repo root to cover the whole repo.
    await fs.mkdir(path.join(repoRoot, 'app'));
    await fs.writeFile(path.join(repoRoot, 'app', 'keep.txt'), 'keep\n');
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'secret.env\n');
    git(repoRoot, 'add', 'app/keep.txt', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'app', '--no-verify');
    await fs.writeFile(path.join(repoRoot, 'secret.env'), 'LOCAL_UNIQUE\n');
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r151-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.writeFile(path.join(srcPath, 'secret.env'), 'AGENT_TEMPLATE\n');
    git(srcPath, 'add', '-f', 'secret.env');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(path.join(repoRoot, 'app'), snapshot),
    ).rejects.toMatchObject({ conflict: true });
    expect(await read(path.join(repoRoot, 'secret.env'))).toBe(
      'LOCAL_UNIQUE\n',
    );
  });

  it('applyStashSnapshot refuses a file that would replace an ignored directory (R15-2)', async () => {
    // The snapshot carries a regular file `secret`; the target holds ignored
    // content at secret/unique.txt. Exact-path equality misses the ancestor
    // collision; applying would replace the directory and destroy unique.txt.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'secret\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore secret', '--no-verify');
    await fs.mkdir(path.join(repoRoot, 'secret'));
    await fs.writeFile(
      path.join(repoRoot, 'secret', 'unique.txt'),
      'LOCAL_UNIQUE\n',
    );
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r152-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.writeFile(path.join(srcPath, 'secret'), 'AGENT_FILE\n');
    git(srcPath, 'add', '-f', 'secret');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toMatchObject({ conflict: true });
    expect(await read(path.join(repoRoot, 'secret', 'unique.txt'))).toBe(
      'LOCAL_UNIQUE\n',
    );
  });

  it('applyStashSnapshot folds case on a case-insensitive target (R15-3)', async () => {
    // Force core.ignorecase to exercise the case-folding path on a
    // case-sensitive host: the snapshot carries SECRET.env while the target
    // holds ignored secret.env — the same file on a case-insensitive FS.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'secret.env\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    git(repoRoot, 'config', 'core.ignorecase', 'true');
    await fs.writeFile(path.join(repoRoot, 'secret.env'), 'LOCAL_UNIQUE\n');
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r153-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.writeFile(path.join(srcPath, 'SECRET.env'), 'AGENT_TEMPLATE\n');
    git(srcPath, 'add', '-f', 'SECRET.env');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toMatchObject({ conflict: true });
    expect(await read(path.join(repoRoot, 'secret.env'))).toBe(
      'LOCAL_UNIQUE\n',
    );
  });

  it('applyStashSnapshot refuses a snapshot directory replacing an ignored file (R16-1)', async () => {
    // Reverse ancestor: the local ignored content is a regular FILE `secret`,
    // and the snapshot carries `secret/agent.txt`. Applying would replace the
    // file with a directory; exact and forward-ancestor checks both miss it.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'secret\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore secret', '--no-verify');
    await fs.writeFile(path.join(repoRoot, 'secret'), 'LOCAL_UNIQUE\n');
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r161-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.mkdir(path.join(srcPath, 'secret'));
    await fs.writeFile(path.join(srcPath, 'secret', 'agent.txt'), 'agent\n');
    git(srcPath, 'add', '-f', 'secret/agent.txt');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toMatchObject({ conflict: true });
    // secret must still be a regular file with its original content.
    expect(await read(path.join(repoRoot, 'secret'))).toBe('LOCAL_UNIQUE\n');
    expect((await fs.stat(path.join(repoRoot, 'secret'))).isFile()).toBe(true);
  });

  it('applyStashSnapshot refuses a Unicode-equivalent snapshot path (R16-2)', async () => {
    // NFC `café.env` (U+00E9) locally ignored vs NFD `cafe`+U+0301 in the
    // snapshot: a normalization-insensitive filesystem names one file. NFC
    // folding must make the comparison hit even though the bytes differ.
    const nfc = 'caf\u00e9.env';
    const nfd = 'cafe\u0301.env';
    await fs.writeFile(path.join(repoRoot, '.gitignore'), nfc + '\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await fs.writeFile(path.join(repoRoot, nfc), 'LOCAL_UNIQUE\n');
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r162-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.writeFile(path.join(srcPath, nfd), 'AGENT_TEMPLATE\n');
    git(srcPath, 'add', '-f', nfd);
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toMatchObject({ conflict: true });
    expect(await read(path.join(repoRoot, nfc))).toBe('LOCAL_UNIQUE\n');
  });

  it('applyStashSnapshot refuses a snapshot path sharing an ignored file inode (R17-1)', async () => {
    // Filesystem-identity witness runnable on any host: b.env is a hard link to
    // the ignored a.env (same device+inode) but is NOT itself ignored, so the
    // string and ancestor checks miss it; only the inode comparison catches it.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'a.env\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await fs.writeFile(path.join(repoRoot, 'a.env'), 'LOCAL_UNIQUE\n');
    await fs.link(path.join(repoRoot, 'a.env'), path.join(repoRoot, 'b.env'));
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r171-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.writeFile(path.join(srcPath, 'b.env'), 'AGENT_TEMPLATE\n');
    git(srcPath, 'add', '-f', 'b.env');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toMatchObject({ conflict: true });
    expect(await read(path.join(repoRoot, 'a.env'))).toBe('LOCAL_UNIQUE\n');
  });

  it.skipIf(!fsFoldsFinalSigma)(
    'applyStashSnapshot refuses a final-sigma case alias (R17-1 macOS)',
    async () => {
      // On a case-insensitive filesystem ς.env (U+03C2) and σ.env (U+03C3) name
      // one file; toLowerCase leaves them distinct, so the inode check must
      // catch the alias the string comparison misses.
      const finalSigma = '\u03c2.env';
      const sigma = '\u03c3.env';
      await fs.writeFile(path.join(repoRoot, '.gitignore'), '*.env\n');
      git(repoRoot, 'add', '.gitignore');
      git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
      await fs.writeFile(path.join(repoRoot, finalSigma), 'LOCAL_UNIQUE\n');
      const service = new GitWorktreeService(repoRoot);
      const src = await service.createUserWorktree('r171s-src', 'main', {
        detached: true,
      });
      expect(src.success).toBe(true);
      const srcPath = src.worktree!.path;
      await fs.writeFile(path.join(srcPath, sigma), 'AGENT_TEMPLATE\n');
      git(srcPath, 'add', '-f', sigma);
      const snapshot = await service.createStashSnapshot(srcPath);
      expect(snapshot).not.toBe('');
      await expect(
        service.applyStashSnapshot(repoRoot, snapshot),
      ).rejects.toMatchObject({ conflict: true });
      expect(await read(path.join(repoRoot, finalSigma))).toBe(
        'LOCAL_UNIQUE\n',
      );
    },
  );

  it('applyStashSnapshot refuses a snapshot directory whose ancestor aliases an ignored file (R18-1)', async () => {
    // Reverse ancestor + identity, runnable on any host: b.secret is a hard
    // link to the ignored file a.secret (same inode) but is not itself ignored.
    // The snapshot adds b.secret/agent.txt; the full path cannot stat through
    // the file, so the ancestor's inode must be compared against ignored files.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'a.secret\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await fs.writeFile(path.join(repoRoot, 'a.secret'), 'LOCAL_UNIQUE\n');
    await fs.link(
      path.join(repoRoot, 'a.secret'),
      path.join(repoRoot, 'b.secret'),
    );
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r181-src', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.mkdir(path.join(srcPath, 'b.secret'));
    await fs.writeFile(path.join(srcPath, 'b.secret', 'agent.txt'), 'agent\n');
    git(srcPath, 'add', '-f', 'b.secret/agent.txt');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toMatchObject({ conflict: true });
    expect(await read(path.join(repoRoot, 'a.secret'))).toBe('LOCAL_UNIQUE\n');
    expect((await fs.stat(path.join(repoRoot, 'a.secret'))).isFile()).toBe(
      true,
    );
  });

  it.skipIf(!fsFoldsFinalSigma)(
    'applyStashSnapshot refuses a snapshot file aliasing an ignored directory (R18-1 macOS)',
    async () => {
      // Forward ancestor + identity: the ignored content lives in the directory
      // ς.secret; the snapshot adds a regular file σ.secret, which on a
      // case-insensitive filesystem resolves to that same directory inode.
      const finalSigmaDir = '\u03c2.secret';
      const sigmaFile = '\u03c3.secret';
      await fs.writeFile(path.join(repoRoot, '.gitignore'), '*.secret\n');
      git(repoRoot, 'add', '.gitignore');
      git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
      await fs.mkdir(path.join(repoRoot, finalSigmaDir));
      await fs.writeFile(
        path.join(repoRoot, finalSigmaDir, 'unique.txt'),
        'LOCAL_UNIQUE\n',
      );
      const service = new GitWorktreeService(repoRoot);
      const src = await service.createUserWorktree('r181f-src', 'main', {
        detached: true,
      });
      expect(src.success).toBe(true);
      const srcPath = src.worktree!.path;
      await fs.writeFile(path.join(srcPath, sigmaFile), 'AGENT_FILE\n');
      git(srcPath, 'add', '-f', sigmaFile);
      const snapshot = await service.createStashSnapshot(srcPath);
      expect(snapshot).not.toBe('');
      await expect(
        service.applyStashSnapshot(repoRoot, snapshot),
      ).rejects.toMatchObject({ conflict: true });
      expect(await read(path.join(repoRoot, finalSigmaDir, 'unique.txt'))).toBe(
        'LOCAL_UNIQUE\n',
      );
    },
  );

  it('applyStashSnapshot applies when no ignored path collides (R12-2 control)', async () => {
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'unrelated.env\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await fs.writeFile(path.join(repoRoot, 'unrelated.env'), 'LOCAL\n');
    const service = new GitWorktreeService(repoRoot);
    const src = await service.createUserWorktree('r122-ok', 'main', {
      detached: true,
    });
    expect(src.success).toBe(true);
    const srcPath = src.worktree!.path;
    await fs.writeFile(path.join(srcPath, 'tracked.txt'), 'dirty\n');
    const snapshot = await service.createStashSnapshot(srcPath);
    expect(snapshot).not.toBe('');
    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).resolves.toBeUndefined();
    expect(await read(path.join(repoRoot, 'tracked.txt'))).toBe('dirty\n');
    expect(await read(path.join(repoRoot, 'unrelated.env'))).toBe('LOCAL\n');
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

  // A newline in a DIRECTORY component is rejected by the Win32 path layer
  // (ERROR_INVALID_NAME) before any git call, same as the newline-file
  // fixtures above; gate it so the Windows lane does not red at setup.
  it.skipIf(process.platform === 'win32')(
    'keeps the legacy file when the exclude rule cannot be established',
    async () => {
      // A newline-bearing component cannot be represented in info/exclude;
      // the migration must keep the legacy file (the only hiding mechanism)
      // rather than unlink it and leave .qwen/ permanently untracked.
      const nlSub = path.join(repoRoot, 'nl\nsub');
      await fs.mkdir(nlSub);
      const service = new GitWorktreeService(nlSub);
      const legacy = path.join(nlSub, '.qwen', '.gitignore');
      await fs.mkdir(path.join(nlSub, '.qwen'), { recursive: true });
      await fs.writeFile(
        legacy,
        '# Auto-generated by qwen-code.\nworktrees/\n',
      );
      await service.migrateLegacyWorktreeGitignore();
      // The rule was not representable: the legacy file survives.
      expect(await read(legacy)).toBe(
        '# Auto-generated by qwen-code.\nworktrees/\n',
      );
    },
  );

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

  it.skipIf(!arePermissionBitsEnforced())(
    'applyStashSnapshot fails closed when the target index is unwritable (R6-2)',
    async () => {
      // A non-conflict apply failure (unwritable index) must not resolve:
      // the handoff would otherwise report a dirty carry that never landed.
      await fs.writeFile(path.join(repoRoot, 'f.txt'), 'one\n');
      git(repoRoot, 'add', 'f.txt');
      git(repoRoot, 'commit', '-qm', 'f', '--no-verify');
      const service = new GitWorktreeService(repoRoot);
      const target = await service.createUserWorktree('snap-lock', 'main', {
        detached: true,
      });
      expect(target.success).toBe(true);
      const targetPath = target.worktree!.path;
      await fs.writeFile(path.join(targetPath, 'f.txt'), 'two\n');
      const snapshot = await service.createStashSnapshot(targetPath);
      expect(snapshot).not.toBe('');
      git(targetPath, 'checkout', '--', 'f.txt');
      // Deny index writes by permission rather than a held index.lock: the
      // lock proved non-portable across the CI fleet's git builds, while a
      // read-only git directory blocks every index-write path and bites for
      // both non-root developers and the root-run CI lane (which drops
      // DAC_OVERRIDE precisely so permission fixtures work).
      const gitDir = git(targetPath, 'rev-parse', '--absolute-git-dir');
      await fs.chmod(gitDir, 0o555);
      try {
        await expect(
          service.applyStashSnapshot(targetPath, snapshot),
        ).rejects.toThrow('failed to apply');
        // The dirty change never landed.
        expect(await read(path.join(targetPath, 'f.txt'))).toBe('one\n');
      } finally {
        await fs.chmod(gitDir, 0o755);
      }
    },
  );

  it('applyStashSnapshot refuses a conflicting apply and restores committed state (R6-2)', async () => {
    await fs.writeFile(path.join(repoRoot, 'f.txt'), 'line1\nBASE\nline3\n');
    git(repoRoot, 'add', 'f.txt');
    git(repoRoot, 'commit', '-qm', 'f base', '--no-verify');
    const service = new GitWorktreeService(repoRoot);
    const sibling = await service.createUserWorktree('snap-src', 'main', {
      detached: true,
    });
    expect(sibling.success).toBe(true);
    const siblingPath = sibling.worktree!.path;
    await fs.writeFile(
      path.join(siblingPath, 'f.txt'),
      'line1\nDIRTY\nline3\n',
    );
    const snapshot = await service.createStashSnapshot(siblingPath);
    expect(snapshot).not.toBe('');
    // Advance the target on the same lines: the 3-way apply conflicts.
    await fs.writeFile(path.join(repoRoot, 'f.txt'), 'line1\nOTHER\nline3\n');
    git(repoRoot, 'add', 'f.txt');
    git(repoRoot, 'commit', '-qm', 'f other', '--no-verify');

    await expect(
      service.applyStashSnapshot(repoRoot, snapshot),
    ).rejects.toBeInstanceOf(WorktreeDirtyCarryConflictError);
    // No conflict markers survive; the checkout is at committed state.
    expect(await read(path.join(repoRoot, 'f.txt'))).toBe(
      'line1\nOTHER\nline3\n',
    );
    expect(git(repoRoot, 'status', '--porcelain')).toBe('');
  });

  it('carryUntrackedFilesTo refuses an ancestor symlink escaping the target (R7)', async () => {
    const service = new GitWorktreeService(repoRoot);
    const target = await service.createUserWorktree('carry-escape', 'main', {
      detached: true,
    });
    expect(target.success).toBe(true);
    const targetPath = target.worktree!.path;
    const outside = path.join(repoParent, 'outside');
    await fs.mkdir(outside);
    // The target commits out -> outside (a clean descendant-HEAD shape).
    // The worktree's base tree has no such link, so the source's untracked
    // out/carried.txt is listed and would be copied THROUGH the link to the
    // outside directory without the ancestor guard.
    await fs.symlink(outside, path.join(targetPath, 'out'));
    git(targetPath, 'add', 'out');
    git(targetPath, 'commit', '-qm', 'out link', '--no-verify');
    // The source holds untracked out/carried.txt and a safe nested file.
    await fs.mkdir(path.join(repoRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'out', 'carried.txt'), 'escape\n');
    await fs.mkdir(path.join(repoRoot, 'safe'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'safe', 'nested.txt'), 'ok\n');

    const created = await service.carryUntrackedFilesTo(targetPath);

    expect(created).toContain('safe/nested.txt');
    expect(created).not.toContain('out/carried.txt');
    // Nothing was written outside the target checkout.
    await expect(fs.lstat(path.join(outside, 'carried.txt'))).rejects.toThrow();
    expect(await read(path.join(targetPath, 'safe', 'nested.txt'))).toBe(
      'ok\n',
    );
  });

  it('carryUntrackedFilesTo skips pre-existing destinations and records only created paths (R6-1)', async () => {
    const service = new GitWorktreeService(repoRoot);
    const target = await service.createUserWorktree('carry-skip', 'main', {
      detached: true,
    });
    expect(target.success).toBe(true);
    const targetPath = target.worktree!.path;
    // secret.env exists in BOTH checkouts; fresh.txt only in the source.
    // The caller's rollback removes the returned paths, so a pre-existing
    // destination must neither be overwritten nor recorded.
    await fs.writeFile(path.join(repoRoot, 'secret.env'), 'REAL-LOCAL\n');
    await fs.writeFile(path.join(targetPath, 'secret.env'), 'FROM-WORKTREE\n');
    await fs.writeFile(path.join(targetPath, 'fresh.txt'), 'new\n');

    const created = await new GitWorktreeService(
      targetPath,
    ).carryUntrackedFilesTo(repoRoot);

    expect(created).toContain('fresh.txt');
    expect(created).not.toContain('secret.env');
    expect(await read(path.join(repoRoot, 'secret.env'))).toBe('REAL-LOCAL\n');
    expect(await read(path.join(repoRoot, 'fresh.txt'))).toBe('new\n');
  });

  // The post-checkout hook is a POSIX shell script; Windows has no sh.
  it.skipIf(process.platform === 'win32')(
    'createUserWorktree surfaces a non-conflict carry failure (R5-5)',
    async () => {
      // Make the NEW worktree's git directory read-only from a
      // post-checkout hook (it runs during `git worktree add`, after the
      // index exists): the tracked stash apply then fails for an
      // environment reason, with no unmerged entries. Creation must
      // refuse rather than record a carry that never landed. Permission
      // denial is used instead of a held index.lock because the lock
      // proved non-portable across the CI fleet's git builds; a read-only
      // git directory blocks every index-write path and bites for both
      // non-root developers and the root-run CI lane (DAC_OVERRIDE dropped).
      const hooksDir = path.join(repoParent, 'hooks');
      await fs.mkdir(hooksDir);
      await fs.writeFile(
        path.join(hooksDir, 'post-checkout'),
        '#!/bin/sh\ngd=$(git rev-parse --absolute-git-dir)\nchmod 555 "$gd"\n',
        { mode: 0o755 },
      );
      git(repoRoot, 'config', 'core.hooksPath', hooksDir);
      await makeDirty(repoRoot);

      const service = new GitWorktreeService(repoRoot);
      const created = await service.createUserWorktree('locked', 'main', {
        detached: true,
        carryDirtyState: true,
      });

      expect(created.success).toBe(false);
      expect(created.error).toContain('failed to apply');
      // Restore the directory mode so the fixture cleanup can reap it.
      // The failed removal deletes the working tree but cannot delete the
      // read-only git directory's contents, so address the git directory
      // directly rather than through the (possibly gone) worktree path.
      const gitDir = path.join(repoRoot, '.git', 'worktrees', 'locked');
      if (existsSync(gitDir)) {
        await fs.chmod(gitDir, 0o755);
      }
    },
  );

  it('createUserWorktree carry refuses an ancestor symlink escaping the worktree (R7-2)', async () => {
    // The target's base commit tracks out -> outside; the capture checkout
    // predates that link (its tree has no `out`) and holds a real untracked
    // out/carried.txt. The untracked copy must not write through the link to
    // the outside directory (the sibling carryUntrackedFilesTo guard applies
    // to this path too), and carriedPaths must not name the skipped entry.
    const service = new GitWorktreeService(repoRoot);
    // Capture checkout at the current HEAD (no `out` yet).
    const capture = await service.createUserWorktree('capture-r72', 'main', {
      detached: true,
    });
    expect(capture.success).toBe(true);
    const capturePath = capture.worktree!.path;
    // Now commit out -> outside in the source, advancing the target base.
    const outside = path.join(repoParent, 'outside-r72');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(repoRoot, 'out'));
    git(repoRoot, 'add', 'out');
    git(repoRoot, 'commit', '-qm', 'out link', '--no-verify');
    const base = git(repoRoot, 'rev-parse', 'HEAD');
    // The capture holds a real untracked out/carried.txt (its tree has no out).
    await fs.mkdir(path.join(capturePath, 'out'), { recursive: true });
    await fs.writeFile(
      path.join(capturePath, 'out', 'carried.txt'),
      'escape\n',
    );

    const created = await service.createUserWorktree('target-r72', base, {
      detached: true,
      carryDirtyState: true,
      dirtyStateSource: capturePath,
    });

    expect(created.success).toBe(true);
    await expect(fs.lstat(path.join(outside, 'carried.txt'))).rejects.toThrow();
    expect(created.carriedPaths ?? []).not.toContain('out/carried.txt');
  });

  it('migrateLegacyWorktreeGitignore keeps the legacy file when a higher-priority rule answers (R7-4)', async () => {
    // A root .gitignore re-includes the worktrees path, so the info/exclude
    // rule is powerless while the legacy .qwen/.gitignore still hides it.
    // The verification must attribute the match to the written rule, not to
    // whatever source ignores the path, or it unlinks the only mechanism.
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.qwen/*\n!.qwen/worktrees/\n',
    );
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'reinclude', '--no-verify');
    await fs.mkdir(path.join(repoRoot, '.qwen'), { recursive: true });
    const legacy = path.join(repoRoot, '.qwen', '.gitignore');
    await fs.writeFile(legacy, '# Auto-generated by qwen-code.\nworktrees/\n');

    const service = new GitWorktreeService(repoRoot);
    await service.migrateLegacyWorktreeGitignore();

    // The legacy file survives (the info/exclude rule is not the one in
    // force) and the checkout still reads clean.
    expect(await read(legacy)).toBe(
      '# Auto-generated by qwen-code.\nworktrees/\n',
    );
    expect(git(repoRoot, 'status', '--porcelain')).toBe('');
  });

  it('migrateLegacyWorktreeGitignore completes when a broader exclude rule already matches (R9)', async () => {
    // info/exclude already holds a broader rule (.qwen/) that matches the
    // probe first. git reports that earlier pattern, so a pattern-equality
    // check would strand the legacy file even though the exclude file
    // ignores the path. Attribution by source lets the migration complete.
    const excludeRel = git(repoRoot, 'rev-parse', '--git-path', 'info/exclude');
    await fs.writeFile(path.resolve(repoRoot, excludeRel), '.qwen/\n', 'utf8');
    await fs.mkdir(path.join(repoRoot, '.qwen'), { recursive: true });
    const legacy = path.join(repoRoot, '.qwen', '.gitignore');
    await fs.writeFile(legacy, '# Auto-generated by qwen-code.\nworktrees/\n');

    const service = new GitWorktreeService(repoRoot);
    await service.migrateLegacyWorktreeGitignore();

    await expect(fs.lstat(legacy)).rejects.toThrow();
    expect(git(repoRoot, 'status', '--porcelain')).toBe('');
  });

  // The post-checkout hook is a POSIX shell script; Windows has no sh.
  it.skipIf(process.platform === 'win32')(
    'setupWorktrees baselines committed state and carries untracked after a partial tracked apply failure (R7-41)',
    async () => {
      // Source: tracked a.txt + sub/b.txt modified, untracked u.txt. A
      // post-checkout hook makes sub/ unwritable in the new worktree so the
      // stash apply fails (partially) with no unmerged entries. The fail-open
      // caller must baseline COMMITTED tracked state (not the partial apply)
      // and still carry the untracked work.
      await fs.mkdir(path.join(repoRoot, 'sub'));
      await fs.writeFile(path.join(repoRoot, 'a.txt'), 'a-base\n');
      await fs.writeFile(path.join(repoRoot, 'sub', 'b.txt'), 'b-base\n');
      git(repoRoot, 'add', 'a.txt', 'sub/b.txt');
      git(repoRoot, 'commit', '-qm', 'tracked', '--no-verify');
      await fs.writeFile(path.join(repoRoot, 'a.txt'), 'a-dirty\n');
      await fs.writeFile(path.join(repoRoot, 'sub', 'b.txt'), 'b-dirty\n');
      await fs.writeFile(path.join(repoRoot, 'u.txt'), 'untracked-work\n');
      const hooksDir = path.join(repoParent, 'hooks-r741');
      await fs.mkdir(hooksDir);
      await fs.writeFile(
        path.join(hooksDir, 'post-checkout'),
        '#!/bin/sh\nchmod 555 sub 2>/dev/null || true\n',
        { mode: 0o755 },
      );
      git(repoRoot, 'config', 'core.hooksPath', hooksDir);

      const service = new GitWorktreeService(
        repoRoot,
        path.join(repoParent, 'sessions-r741'),
      );
      const result = await service.setupWorktrees({
        sessionId: 'r741-session',
        sourceRepoPath: repoRoot,
        worktreeNames: ['arena'],
        baseBranch: 'main',
      });

      expect(result.success).toBe(true);
      const wt = result.worktrees[0].path;
      try {
        // Tracked restored to committed (no partial a-dirty / b-dirty).
        expect(await read(path.join(wt, 'a.txt'))).toBe('a-base\n');
        expect(await read(path.join(wt, 'sub', 'b.txt'))).toBe('b-base\n');
        // Untracked work still carried.
        expect(await read(path.join(wt, 'u.txt'))).toBe('untracked-work\n');
      } finally {
        await fs.chmod(path.join(wt, 'sub'), 0o755).catch(() => undefined);
        await service.cleanupSession('r741-session').catch(() => undefined);
        git(repoRoot, 'config', '--unset', 'core.hooksPath');
      }
    },
  );

  // The post-checkout hook is a POSIX shell script; Windows has no sh.
  it.skipIf(process.platform === 'win32')(
    'setupWorktrees refuses to baseline when the carry restore itself fails (R8-3)',
    async () => {
      // Source tracked edit; a post-checkout hook holds the new worktree's
      // index.lock so BOTH the stash apply and the reset --hard restore fail.
      // The thrown error must report the restore failure (not claim the tree
      // was restored to committed state), and setupWorktrees must refuse to
      // baseline the half-applied overlay as pre-existing user state.
      await fs.writeFile(path.join(repoRoot, 'README.md'), 'dirty\n');
      const hooksDir = path.join(repoParent, 'hooks-r83');
      await fs.mkdir(hooksDir);
      await fs.writeFile(
        path.join(hooksDir, 'post-checkout'),
        '#!/bin/sh\ntouch "$(git rev-parse --absolute-git-dir)/index.lock"\n',
        { mode: 0o755 },
      );
      git(repoRoot, 'config', 'core.hooksPath', hooksDir);
      const service = new GitWorktreeService(
        repoRoot,
        path.join(repoParent, 'sessions-r83'),
      );
      try {
        await expect(
          service.setupWorktrees({
            sessionId: 'r83-session',
            sourceRepoPath: repoRoot,
            worktreeNames: ['arena'],
            baseBranch: 'main',
          }),
        ).rejects.toThrow(/restore to committed state also failed/);
      } finally {
        git(repoRoot, 'config', '--unset', 'core.hooksPath');
      }
    },
  );
});

describe('worktreeHasWork — carried overlay exemption (R9-6)', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoParent: string;
  let repoRoot: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-r96-'));
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    await initRepo(repoRoot);
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  async function createCarried(slug: string) {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree(slug, 'main', {
      carryDirtyState: true,
    });
    expect(result.success).toBe(true);
    return {
      worktree: result.worktree!,
      carriedEntries: result.carriedEntries!,
    };
  }

  it('a pristine carried-only checkout reads clean with the exemption, dirty without', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-clean');
    expect(carriedEntries.length).toBeGreaterThan(0);
    // Without the recorded overlay the carried copy counts as work (the
    // pre-fix reaper behavior that stranded the checkout).
    await expect(worktreeHasWork(worktree.path)).resolves.toBe(true);
    // With it, every entry still matches its carry-time identity.
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      false,
    );
  });

  it('a late untracked file outside the overlay still preserves', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-late');
    await fs.writeFile(path.join(worktree.path, 'late-work.txt'), 'mine\n');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('a late-arriving ignored file still preserves', async () => {
    // Commit the ignore rule in the source so .gitignore is not itself work;
    // the only new content is the ignored file, isolating the ignored-entry
    // detection (the collapsed --ignored=matching probe must list it).
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '*.secret\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-ignored');
    await fs.writeFile(path.join(worktree.path, 'late.secret'), 'hidden\n');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('absent carriedEntries keeps the legacy behavior (overlay counts as work)', async () => {
    await makeDirty(repoRoot);
    const { worktree } = await createCarried('r96-legacy');
    // A legacy sidecar records no overlay: passing nothing (or an empty list)
    // must behave exactly like the pre-fix predicate.
    await expect(worktreeHasWork(worktree.path)).resolves.toBe(true);
    await expect(worktreeHasWork(worktree.path, [])).resolves.toBe(true);
  });

  it('exempts exact carried paths, not a directory prefix', async () => {
    // Carry a file inside a subdirectory, then add a sibling the session
    // created: the sibling is not in the overlay and must preserve.
    await fs.mkdir(path.join(repoRoot, 'sub'));
    await fs.writeFile(path.join(repoRoot, 'sub', 'a.txt'), 'carried\n');
    const { worktree, carriedEntries } = await createCarried('r96-prefix');
    expect(carriedEntries.map((e) => e.path)).toContain('sub/a.txt');
    await fs.writeFile(path.join(worktree.path, 'sub', 'b.txt'), 'sibling\n');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  // F1: a session change to a carried path is new work the source checkout
  // does not hold, so the gate must read it as work (the reaper snapshots it)
  // rather than waive it by path equality alone.
  it('staging a carried tracked edit reads as work', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-stage');
    git(worktree.path, 'add', 'README.md');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('deleting a carried tracked file reads as work', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-delete');
    await fs.rm(path.join(worktree.path, 'README.md'));
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('a further unstaged edit of a carried tracked file reads as work', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-reedit');
    await fs.writeFile(path.join(worktree.path, 'README.md'), 'later-edit\n');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('a further edit of a carried untracked file reads as work', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-untracked');
    await fs.writeFile(
      path.join(worktree.path, 'untracked.txt'),
      'later-untracked\n',
    );
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it.skipIf(!arePermissionBitsEnforced())(
    'a mode-only change of a carried file reads as work',
    async () => {
      await makeDirty(repoRoot);
      const { worktree, carriedEntries } = await createCarried('r96-mode');
      await fs.chmod(path.join(worktree.path, 'README.md'), 0o755);
      await expect(
        worktreeHasWork(worktree.path, carriedEntries),
      ).resolves.toBe(true);
    },
  );

  it('a session edit hidden under assume-unchanged reads as work (F6)', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-assume');
    git(worktree.path, 'update-index', '--assume-unchanged', 'README.md');
    await fs.writeFile(path.join(worktree.path, 'README.md'), 'hidden-edit\n');
    // git status omits the edit under the hidden bit; the gate must still
    // refuse rather than read clean and delete the work bare.
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('a session edit hidden under skip-worktree reads as work (F6)', async () => {
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-skip');
    git(worktree.path, 'update-index', '--skip-worktree', 'README.md');
    await fs.writeFile(path.join(worktree.path, 'README.md'), 'hidden-edit\n');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('a pristine carried deletion reads clean; restoring or staging it is work', async () => {
    // Source deletes a tracked file (unstaged); the carry reproduces the
    // deletion and records a null-hash identity.
    await fs.rm(path.join(repoRoot, 'tracked.txt'));
    const { worktree, carriedEntries } = await createCarried('r96-carrydel');
    expect(carriedEntries).toContainEqual({
      path: 'tracked.txt',
      hash: null,
      executable: false,
    });
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      false,
    );
    // Restoring the deleted file is new work.
    await fs.writeFile(path.join(worktree.path, 'tracked.txt'), 'back\n');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('staging a carried deletion reads as work', async () => {
    await fs.rm(path.join(repoRoot, 'tracked.txt'));
    const { worktree, carriedEntries } = await createCarried('r96-stagedel');
    git(worktree.path, 'add', 'tracked.txt');
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('nested ignored disposable output is waived, not read as work (R2-1)', async () => {
    // Monorepo-style nested build output: a file-level ignored listing would
    // read packages/app/node_modules/x/y.js as work (and could overflow the
    // capture buffer); the collapsed ignored geometry waives the directory.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'node_modules/\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-qm', 'ignore', '--no-verify');
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-nested');
    await fs.mkdir(
      path.join(worktree.path, 'packages', 'app', 'node_modules', 'x'),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(worktree.path, 'packages', 'app', 'node_modules', 'x', 'y.js'),
      '//\n',
    );
    // Pristine carried overlay + nested ignored disposable output → clean.
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      false,
    );
  });

  it('a clean sparse-checkout worktree is not stranded by skip-worktree (R1-5)', async () => {
    await fs.mkdir(path.join(repoRoot, 'cone'));
    await fs.mkdir(path.join(repoRoot, 'other'));
    await fs.writeFile(path.join(repoRoot, 'cone', 'a.txt'), 'a\n');
    // A non-cone SUBdirectory file gets the skip-worktree bit; cone mode always
    // includes root-level files, so the out-of-cone file must be nested.
    await fs.writeFile(path.join(repoRoot, 'other', 'b.txt'), 'b\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'sparse', '--no-verify');
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r96-sparse', 'main');
    expect(result.success).toBe(true);
    const wt = result.worktree!.path;
    git(wt, 'sparse-checkout', 'init', '--cone');
    git(wt, 'sparse-checkout', 'set', 'cone');
    expect(git(wt, 'ls-files', '-v')).toContain('S other/b.txt');
    // skip-worktree stamps every out-of-cone path; sparse-checkout makes them
    // legitimate, so a clean sparse worktree must read clean, not "has work".
    await expect(worktreeHasWork(wt)).resolves.toBe(false);
    // assume-unchanged is never set by sparse-checkout: hiding an edit under
    // it still reads as work even in a sparse worktree.
    git(wt, 'update-index', '--assume-unchanged', 'cone/a.txt');
    await fs.writeFile(path.join(wt, 'cone', 'a.txt'), 'hidden\n');
    await expect(worktreeHasWork(wt)).resolves.toBe(true);
  });

  it('a carried edit the clean filter would normalize away still reads as work (R4-1)', async () => {
    // With a text/eol filter, hash-object (filtered) would hide a CRLF-only
    // rewrite of an already-dirty carried file; the raw-byte identity must
    // still detect it so the reaper snapshots instead of deleting bare.
    await fs.writeFile(
      path.join(repoRoot, '.gitattributes'),
      '*.txt text eol=lf\n',
    );
    git(repoRoot, 'add', '.gitattributes');
    git(repoRoot, 'commit', '-qm', 'attrs', '--no-verify');
    await makeDirty(repoRoot);
    const { worktree, carriedEntries } = await createCarried('r96-filter');
    // tracked.txt matches the *.txt eol=lf filter and is carried as
    // 'dirty-staged\n' (status ' M'). Rewrite with CRLF-only endings: raw bytes
    // change, but the clean-filtered hash would not — the raw-byte identity
    // must still detect it.
    await fs.writeFile(
      path.join(worktree.path, 'tracked.txt'),
      'dirty-staged\r\n',
    );
    await expect(worktreeHasWork(worktree.path, carriedEntries)).resolves.toBe(
      true,
    );
  });

  it('a populated gitlink (initialized submodule) reads as work (P1)', async () => {
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r96-gitlink', 'main');
    expect(result.success).toBe(true);
    const wt = result.worktree!.path;
    // A gitlink (mode 160000) with a populated directory models an initialized
    // submodule whose object database can hold unpushed commits.
    const subSha = git(repoRoot, 'rev-parse', 'HEAD');
    git(wt, 'update-index', '--add', '--cacheinfo', `160000,${subSha},lib`);
    await fs.mkdir(path.join(wt, 'lib'));
    await fs.writeFile(path.join(wt, 'lib', 'file.txt'), 'submodule work\n');
    await expect(worktreeHasWork(wt)).resolves.toBe(true);
  });
});
