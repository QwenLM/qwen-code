/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `.worktreeinclude` support in
 * `GitWorktreeService.setupWorktrees()` (Phase D-4).
 *
 * Real git + real `fs` against a temp repo: the unit-test file mocks
 * simple-git too heavily to exercise the `git ls-files` listing the
 * resolve step is built on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CARRIED_PATHS_MAX_BYTES,
  GitWorktreeService,
  WORKTREE_INCLUDE_FILE,
  listIgnoredFiles,
  parseWorktreeInclude,
} from './gitWorktreeService.js';

const exists = (p: string) =>
  fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);

const read = (p: string) =>
  // Windows checkouts materialise LF blobs with CRLF working-tree endings;
  // the assertions are about content, not line endings.
  fs.readFile(p, 'utf8').then((s) => s.replace(/\r\n/g, '\n'));

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

describe('parseWorktreeInclude', () => {
  it('skips comments and blank lines but keeps surrounding whitespace', () => {
    expect(
      parseWorktreeInclude(
        ['# a comment', '', '  ', '.env', '  config\\  ', ' spaced.txt'].join(
          '\n',
        ),
      ),
    ).toEqual(['.env', '  config\\  ', ' spaced.txt']);
  });

  it('strips a trailing CR so CRLF files round-trip', () => {
    expect(parseWorktreeInclude('.env\r\n.local/\r\n')).toEqual([
      '.env',
      '.local/',
    ]);
  });

  it('treats a line whose first character is not # as a pattern', () => {
    expect(parseWorktreeInclude('  #not-a-comment')).toEqual([
      '  #not-a-comment',
    ]);
  });
});

describe('listIgnoredFiles', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-ignore-')),
    );
    gitIn(repoRoot, 'init', '-q', '-b', 'main');
    gitIn(repoRoot, 'config', 'user.email', 't@e.com');
    gitIn(repoRoot, 'config', 'user.name', 't');
    gitIn(repoRoot, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.env\n.local/\n');
    await fs.writeFile(path.join(repoRoot, 'tracked.txt'), 'tracked\n');
    gitIn(repoRoot, 'add', '.');
    gitIn(repoRoot, 'commit', '-q', '-m', 'init', '--no-verify');
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('lists files inside a fully-ignored directory instead of the dir', async () => {
    await fs.mkdir(path.join(repoRoot, '.local', 'sub'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.local', 'top.txt'), 'top\n');
    await fs.writeFile(path.join(repoRoot, '.local', 'sub', 'deep.txt'), 'd\n');

    const listed = await listIgnoredFiles(repoRoot);

    expect(listed.sort()).toEqual(['.local/sub/deep.txt', '.local/top.txt']);
  });

  it('omits tracked files', async () => {
    await fs.writeFile(path.join(repoRoot, '.env'), 'A=1\n');

    expect(await listIgnoredFiles(repoRoot)).toEqual(['.env']);
  });

  it('lists an ignored tree larger than the shared capture buffer', async () => {
    // 10 MB+ of paths is a monorepo with a second `node_modules`; buffering
    // the listing through `runGitCapture` rejects past its cap and reads as
    // "nothing is ignored", so the stream has to survive this size. Long
    // names reach the size in ~30k files instead of ~400k.
    const long = 'd'.repeat(180);
    const names: string[] = [];
    for (let dir = 0; dir < 4; dir += 1) {
      const relDir = path.join('.local', `${long}${dir}`, long);
      await fs.mkdir(path.join(repoRoot, relDir), { recursive: true });
      for (let i = 0; i < 8_000; i += 1) {
        const rel = path.join(relDir, `${long}${i}.txt`);
        await fs.writeFile(path.join(repoRoot, rel), '');
        names.push(rel);
      }
    }

    const listed = await listIgnoredFiles(repoRoot);

    expect(Buffer.byteLength(listed.join('\0'))).toBeGreaterThan(
      10 * 1024 * 1024,
    );
    expect(listed.length).toBe(names.length);
  });
});

describe('GitWorktreeService.setupWorktrees() — .worktreeinclude', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoParent: string;
  let repoRoot: string;
  let baseDir: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-include-'));
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    baseDir = path.join(repoParent, 'worktrees');
    await fs.mkdir(repoRoot);

    gitIn(repoRoot, 'init', '-q', '-b', 'main');
    gitIn(repoRoot, 'config', 'user.email', 't@e.com');
    gitIn(repoRoot, 'config', 'user.name', 't');
    gitIn(repoRoot, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.env\n.local/\nsecrets/*.json\n',
    );
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'hi\n');
    gitIn(repoRoot, 'add', '.');
    gitIn(repoRoot, 'commit', '-q', '-m', 'init', '--no-verify');
  });

  afterEach(async () => {
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  /** Runs setupWorktrees for one worktree and returns its checkout path. */
  async function setup(root = repoRoot) {
    const service = new GitWorktreeService(root, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's1',
      sourceRepoPath: root,
      worktreeNames: ['one'],
    });
    expect(result.success).toBe(true);
    expect(result.worktrees).toHaveLength(1);
    return result.worktrees[0].path;
  }

  async function writeIgnoredFixtures() {
    await fs.writeFile(path.join(repoRoot, '.env'), 'TOKEN=abc\n');
    await fs.mkdir(path.join(repoRoot, '.local', 'sub'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.local', 'top.txt'), 'top\n');
    await fs.writeFile(path.join(repoRoot, '.local', 'sub', 'deep.txt'), 'd\n');
    await fs.mkdir(path.join(repoRoot, 'secrets'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'secrets', 'id.json'),
      '{"k":"v"}\n',
    );
  }

  it('copies the gitignored paths named by the file', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      ['.env', '.local/', 'secrets/id.json'].join('\n'),
    );
    // Committed, like a real repository's file.
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const wt = await setup();

    expect(await read(path.join(wt, '.env'))).toBe('TOKEN=abc\n');
    expect(await read(path.join(wt, '.local', 'top.txt'))).toBe('top\n');
    expect(await read(path.join(wt, '.local', 'sub', 'deep.txt'))).toBe('d\n');
    expect(await read(path.join(wt, 'secrets', 'id.json'))).toBe('{"k":"v"}\n');
  });

  it('leaves gitignored paths the file does not name out of the worktree', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');

    const wt = await setup();

    expect(await read(path.join(wt, '.env'))).toBe('TOKEN=abc\n');
    expect(await exists(path.join(wt, '.local'))).toBe(false);
    expect(await exists(path.join(wt, 'secrets'))).toBe(false);
  });

  it('copies nothing when the file is absent', async () => {
    await writeIgnoredFixtures();

    const wt = await setup();

    expect(await exists(path.join(wt, '.env'))).toBe(false);
  });

  it('honours a negation so a listed path is excluded again', async () => {
    await fs.mkdir(path.join(repoRoot, 'secrets'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'secrets', 'id.json'), '{}\n');
    await fs.writeFile(path.join(repoRoot, 'secrets', 'other.json'), '{}\n');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      ['secrets/*.json', '!secrets/other.json'].join('\n'),
    );

    const wt = await setup();

    expect(await exists(path.join(wt, 'secrets', 'id.json'))).toBe(true);
    expect(await exists(path.join(wt, 'secrets', 'other.json'))).toBe(false);
  });

  it('matches case the way git does on a case-sensitive checkout', async () => {
    // `ignore` defaults to case-insensitive matching, which would select
    // `secrets/id.json` for an upper-case line that git does not match. The
    // setting is pinned because `git init` turns `core.ignorecase` on for
    // repositories created on a case-insensitive filesystem.
    gitIn(repoRoot, 'config', 'core.ignorecase', 'false');
    await fs.mkdir(path.join(repoRoot, 'secrets'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'secrets', 'id.json'), '{}\n');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      'secrets/ID.json\n',
    );

    const wt = await setup();

    expect(await exists(path.join(wt, 'secrets', 'id.json'))).toBe(false);
  });

  it('copies a path whose case matches on a case-sensitive checkout', async () => {
    gitIn(repoRoot, 'config', 'core.ignorecase', 'false');
    await fs.mkdir(path.join(repoRoot, 'secrets'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'secrets', 'id.json'), '{}\n');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      'secrets/id.json\n',
    );

    const wt = await setup();

    expect(await exists(path.join(wt, 'secrets', 'id.json'))).toBe(true);
  });

  it('copies an ignored path whose name holds a backslash', async () => {
    // `git check-ignore` renders such a name C-quoted (`"a\\b.secret"`),
    // and unquoting it by hand turns the backslash into a separator: the
    // destination's ignore check then never matches and the file is
    // silently left behind. `-z --stdin` keeps it verbatim.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '*.secret\n');
    await fs.writeFile(path.join(repoRoot, 'a\\b.secret'), 'TOKEN=abc\n');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      '*.secret\n',
    );
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include secrets', '--no-verify');

    const wt = await setup();

    expect(await read(path.join(wt, 'a\\b.secret'))).toBe('TOKEN=abc\n');
  });

  it('keeps copying when a chunk of selected paths is not ignored', async () => {
    // `git check-ignore` exits 1 when NO path in the chunk matches, which is
    // an answer, not a failure. Read as a failure it makes the destination
    // state look unavailable, and the whole copy is dropped — including
    // chunks that do match. `listIgnoredPaths` checks 50 paths per call, so
    // this needs a non-matching chunk of 50 ahead of a matching one.
    //
    // The destination branch (`pre-early`) ignores `z.env` but predates the
    // `early-*` rule, so the 51 selected paths split into [50 no-match] then
    // [1 match].
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.env\nz.env\n');
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'commit', '-q', '-m', 'ignore z.env', '--no-verify');
    gitIn(repoRoot, 'branch', '-q', 'pre-early');

    for (let i = 0; i < 50; i++) {
      const name = `early-${String(i).padStart(2, '0')}.txt`;
      await fs.writeFile(path.join(repoRoot, name), `${name}\n`);
    }
    await fs.writeFile(path.join(repoRoot, 'z.env'), 'TOKEN=abc\n');
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.env\nearly-*\nz.env\n',
    );
    gitIn(repoRoot, 'add', '.gitignore');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      ['early-*', 'z.env'].join('\n'),
    );
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include early', '--no-verify');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's-chunk',
      sourceRepoPath: repoRoot,
      worktreeNames: ['chunk'],
      baseBranch: 'pre-early',
    });
    expect(result.success).toBe(true);

    // The early files are not ignored in the destination and must stay out;
    // `z.env` is, and must land even though its chunk comes after the one
    // whose check exits 1.
    const wt = result.worktrees[0].path;
    expect(await exists(path.join(wt, 'early-00.txt'))).toBe(false);
    expect(await read(path.join(wt, 'z.env'))).toBe('TOKEN=abc\n');
  });

  it('never copies a tracked file named by a pattern', async () => {
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      'README.md\n',
    );
    // Change the tracked file on disk without letting git report it as
    // dirty, so the overlay that carries the source's dirty state has
    // nothing to deliver and only the include step can bring 'dirty\n'
    // across. Without this the assertion holds whichever step copied it.
    gitIn(repoRoot, 'update-index', '--assume-unchanged', 'README.md');
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'dirty\n');

    const wt = await setup();

    // Present because it is tracked, not because the pattern selected it.
    expect(await read(path.join(wt, 'README.md'))).toBe('hi\n');
  });

  it('skips an ignored symlink instead of materialising its target', async () => {
    const outside = path.join(repoParent, 'outside-secret.txt');
    await fs.writeFile(outside, 'OUT_OF_REPO\n');
    await fs.symlink(outside, path.join(repoRoot, '.env'));
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const wt = await setup();

    // The docs promise a copy of files inside the repo; dereferencing a link
    // to the outside would make an out-of-repo secret agent-readable.
    expect(await exists(path.join(wt, '.env'))).toBe(false);
  });

  it('does not overwrite a path the destination revision tracks', async () => {
    // `tracks-it` commits `appsettings.json`; the branch the worktree is cut
    // from ignores it and holds a local secret under the same name.
    await fs.writeFile(
      path.join(repoRoot, 'appsettings.json'),
      '{"committed":true}\n',
    );
    gitIn(repoRoot, 'add', '-f', 'appsettings.json');
    gitIn(repoRoot, 'commit', '-q', '-m', 'track settings', '--no-verify');
    gitIn(repoRoot, 'checkout', '-q', '-b', 'tracks-it');
    gitIn(repoRoot, 'checkout', '-q', 'main');
    // Now untracked and ignored on the working branch, with a local edit.
    gitIn(repoRoot, 'rm', '-q', '--cached', 'appsettings.json');
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.env\n.local/\nsecrets/*.json\nappsettings.json\n',
    );
    await fs.writeFile(
      path.join(repoRoot, 'appsettings.json'),
      '{"secret":"LOCAL"}\n',
    );
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'commit', '-q', '-m', 'untrack settings', '--no-verify');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      'appsettings.json\n',
    );
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's2',
      sourceRepoPath: repoRoot,
      worktreeNames: ['two'],
      baseBranch: 'tracks-it',
    });
    expect(result.success).toBe(true);
    const wt = result.worktrees[0].path;

    // Overwriting would put the local secret onto a revision that tracks the
    // file, and a routine `git add -A` there would commit it.
    expect(await read(path.join(wt, 'appsettings.json'))).toBe(
      '{"committed":true}\n',
    );
  });

  it('does not copy a case-variant of a path the destination revision tracks', async () => {
    // `tracks-case` commits `AppSettings.json` while naming the lower-case
    // form in `.gitignore`; the working branch holds an ignored lower-case
    // file. `check-ignore` folds case under `core.ignorecase`, so the
    // tracked-set comparison must fold the same way — byte-exact spellings
    // let the copy land on the tracked file's identity and a routine
    // `git add -A` there would commit it.
    gitIn(repoRoot, 'config', 'core.ignorecase', 'true');
    await fs.writeFile(
      path.join(repoRoot, 'AppSettings.json'),
      '{"committed":true}\n',
    );
    gitIn(repoRoot, 'add', '-f', 'AppSettings.json');
    gitIn(repoRoot, 'commit', '-q', '-m', 'track settings', '--no-verify');
    gitIn(repoRoot, 'checkout', '-q', '-b', 'tracks-case');
    gitIn(repoRoot, 'checkout', '-q', 'main');
    // Now untracked and ignored on the working branch, under the lower-case
    // spelling the destination's ignore rule names.
    gitIn(repoRoot, 'rm', '-q', '--cached', 'AppSettings.json');
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.env\n.local/\nsecrets/*.json\nappsettings.json\n',
    );
    await fs.writeFile(
      path.join(repoRoot, 'appsettings.json'),
      '{"secret":"LOCAL"}\n',
    );
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'commit', '-q', '-m', 'untrack settings', '--no-verify');
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      'appsettings.json\n',
    );
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's-case',
      sourceRepoPath: repoRoot,
      worktreeNames: ['case-variant'],
      baseBranch: 'tracks-case',
    });
    expect(result.success).toBe(true);
    const wt = result.worktrees[0].path;

    // The tracked half of the guard folds case like the ignore check: the
    // copy is skipped outright. The tracked content is never replaced by the
    // local secret — on a case-folding filesystem the copy would open the
    // tracked file itself — and on a case-sensitive one no lower-case file
    // lands next to the tracked one.
    expect(await read(path.join(wt, 'AppSettings.json'))).toBe(
      '{"committed":true}\n',
    );
    const wtRootEntries = await fs.readdir(wt);
    expect(wtRootEntries.filter((name) => name === 'appsettings.json')).toEqual(
      [],
    );
  });

  it('does not write through a destination leaf symlink', async () => {
    // `worktree.symlinkDirectories` links single files too (`.env`,
    // `secrets.json`), and runs before the include copy. When the same path
    // is also listed in `.worktreeinclude`, `copyFile` used to follow the
    // link and rewrite the main checkout's own `.env` — untracked,
    // gitignored, and unrecoverable — while reporting a copy that never
    // landed in the worktree.
    await writeIgnoredFixtures();
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    // A second checkout of the same repo: the session's, as the
    // `dirtyStateSource` case has. Its `.env` differs from the main
    // checkout's, so a write-through is visible as a value change.
    const sessionRoot = path.join(repoParent, 'session');
    gitIn(
      repoRoot,
      'worktree',
      'add',
      '-q',
      sessionRoot,
      '-b',
      'session-branch',
    );
    await fs.writeFile(
      path.join(sessionRoot, '.env'),
      'TOKEN=SESSION_CHECKOUT\n',
    );

    const service = new GitWorktreeService(repoRoot, baseDir);
    const created = await service.createUserWorktree('leaf-link', 'main', {
      carryDirtyState: true,
      symlinkDirectories: ['.env'],
      dirtyStateSource: sessionRoot,
    });
    expect(created.success).toBe(true);
    const wt = created.worktree!.path;
    // The configured symlink survives — single-file entries must keep
    // working — but the copy step must not reach through it.
    expect((await fs.lstat(path.join(wt, '.env'))).isSymbolicLink()).toBe(true);
    expect(await read(path.join(repoRoot, '.env'))).toBe('TOKEN=abc\n');
    // Not reported as copied: nothing entered the worktree.
    expect(created.carriedPaths ?? []).not.toContain('.env');
  });

  it('does not copy a path the destination revision does not ignore', async () => {
    // `main` gains the ignore rule; `predates-rule` was cut before it, so a
    // copy there would land as an ordinary untracked file — the baseline
    // `git add --all` would commit the user's local secret.
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.env\n.local/\nsecrets/*.json\nappsettings.json\n',
    );
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'commit', '-q', '-m', 'ignore settings', '--no-verify');
    gitIn(repoRoot, 'checkout', '-q', '-b', 'predates-rule', 'main~1');
    gitIn(repoRoot, 'checkout', '-q', 'main');
    await fs.writeFile(
      path.join(repoRoot, 'appsettings.json'),
      '{"secret":"LOCAL"}\n',
    );
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      'appsettings.json\n',
    );
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's4',
      sourceRepoPath: repoRoot,
      worktreeNames: ['four'],
      baseBranch: 'predates-rule',
    });
    expect(result.success).toBe(true);
    const wt = result.worktrees[0].path;

    expect(await exists(path.join(wt, 'appsettings.json'))).toBe(false);
  });

  it('reads the include file from the repository root, not the launch subdirectory', async () => {
    await fs.mkdir(path.join(repoRoot, 'pkg'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'pkg', 'keep.txt'), 'x\n');
    gitIn(repoRoot, 'add', '.');
    gitIn(repoRoot, 'commit', '-q', '-m', 'pkg', '--no-verify');
    await fs.writeFile(path.join(repoRoot, '.env'), 'TOKEN=abc\n');
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    // Service constructed from the subdirectory, while the session's source
    // repository is the root — a monorepo launch from `pkg/`.
    const sub = path.join(repoRoot, 'pkg');
    const service = new GitWorktreeService(sub, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's3',
      sourceRepoPath: repoRoot,
      worktreeNames: ['three'],
    });
    expect(result.success).toBe(true);

    expect(await read(path.join(result.worktrees[0].path, '.env'))).toBe(
      'TOKEN=abc\n',
    );
  });

  it('ignores a file over the size cap', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(
      path.join(repoRoot, WORKTREE_INCLUDE_FILE),
      '.env\n' + '\n'.repeat(1024 * 1024),
    );

    const wt = await setup();

    expect(await exists(path.join(wt, '.env'))).toBe(false);
  });

  it('still creates the worktree when the file cannot be parsed', async () => {
    await writeIgnoredFixtures();
    // A directory named `.worktreeinclude` is not a file; the step skips it.
    await fs.mkdir(path.join(repoRoot, WORKTREE_INCLUDE_FILE));

    const wt = await setup();

    expect(await exists(wt)).toBe(true);
    expect(await exists(path.join(wt, '.env'))).toBe(false);
  });

  it('applies to `createUserWorktree`, the path --worktree uses', async () => {
    await writeIgnoredFixtures();
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.createUserWorktree('flag', 'main');

    expect(result.success).toBe(true);
    expect(await read(path.join(result.worktree!.path, '.env'))).toBe(
      'TOKEN=abc\n',
    );
  });

  it('reads the include file from the revision being checked out', async () => {
    // `--worktree=#<N>` creates the worktree at the PR head while the launch
    // checkout stays where it was. A `.worktreeinclude` that exists only on
    // the target revision used to be invisible here (the read went to the
    // working copy), so the worktree shipped the file and none of the paths
    // it names.
    // `.env` is gitignored, so it is never part of any commit — it exists
    // only in the launch checkout's working tree, which is exactly what the
    // include copy is for.
    await fs.writeFile(path.join(repoRoot, '.env'), 'TOKEN=abc\n');
    gitIn(repoRoot, 'branch', '-q', 'with-include');
    // The include list is committed on the branch the worktree starts at...
    gitIn(repoRoot, 'checkout', '-q', 'with-include');
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');
    // ...and removed from the launch checkout, which is where the copy used
    // to read from.
    gitIn(repoRoot, 'checkout', '-q', 'main');
    expect(await exists(path.join(repoRoot, WORKTREE_INCLUDE_FILE))).toBe(
      false,
    );

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.createUserWorktree('rev', 'with-include');

    expect(result.success).toBe(true);
    expect(await read(path.join(result.worktree!.path, '.env'))).toBe(
      'TOKEN=abc\n',
    );
  });

  it('matches a trailing-space sibling byte-exactly instead of trimming it', async () => {
    // An unescaped `.env ` in `.gitignore` is stripped to `.env` by git's own
    // parser. The sibling has to be escaped (`.env\\ `) so it matches only the
    // literal name. A trimmed listing would read that record as `.env`, copy a
    // file the destination never ignored, and let the baseline `git add --all`
    // commit the local secret.
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.local/\n');
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'commit', '-q', '-m', 'ignore local only', '--no-verify');
    gitIn(repoRoot, 'branch', '-q', 'predates-name');
    await fs.writeFile(
      path.join(repoRoot, '.gitignore'),
      '.env\n.env\\ \n.local/\n',
    );
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'commit', '-q', '-m', 'ignore both names', '--no-verify');
    await fs.writeFile(path.join(repoRoot, '.env'), 'TOKEN=abc\n');
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env*\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const result = await service.setupWorktrees({
      sessionId: 's5',
      sourceRepoPath: repoRoot,
      worktreeNames: ['five'],
      baseBranch: 'predates-name',
    });
    expect(result.success).toBe(true);

    expect(await exists(path.join(result.worktrees[0].path, '.env'))).toBe(
      false,
    );
  });

  it('exempts the copied paths from the prepared-worktree rollback', async () => {
    // The copied `.env` is not part of the dirty overlay, so without an
    // exemption the rollback's cleanliness check reports "Worktree contains
    // changes" and refuses forever, leaking the checkout and its branch.
    await writeIgnoredFixtures();
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const created = await service.createUserWorktree('rollback', 'main', {
      carryDirtyState: true,
    });
    expect(created.success).toBe(true);
    expect(created.carriedPaths).toContain('.env');

    const base = gitIn(repoRoot, 'rev-parse', 'main').trim();
    const removal = await service.removePreparedUserWorktree(
      'rollback',
      null,
      base,
      undefined,
      true,
      created.carriedPaths,
    );

    expect(removal).toMatchObject({ success: true });
  });

  it('copies from the session checkout, not the service checkout', async () => {
    // A session that edited `.env` in its own worktree must get that value.
    // The tracked/untracked overlay already comes from `dirtyStateSource`;
    // the include listing and copied bytes have to follow the same root or
    // the new worktree is a hybrid of two checkouts.
    await writeIgnoredFixtures();
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), '.env\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include list', '--no-verify');

    const sessionRoot = path.join(repoParent, 'session');
    gitIn(
      repoRoot,
      'worktree',
      'add',
      '-q',
      sessionRoot,
      '-b',
      'session-branch',
    );
    await fs.writeFile(path.join(sessionRoot, '.env'), 'FROM_SESSION=1\n');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const created = await service.createUserWorktree('source-root', 'main', {
      carryDirtyState: true,
      dirtyStateSource: sessionRoot,
    });

    expect(created.success).toBe(true);
    expect(await read(path.join(created.worktree!.path, '.env'))).toBe(
      'FROM_SESSION=1\n',
    );
  });

  it('applies the journal bound to the included copies as well', async () => {
    // The copies are exempted from the rollback only through carriedPaths,
    // so an included set appended without its own bound pushes the record
    // past the journal cap and strands the worktree on the next phase
    // transition. The included set has to be measured against that cap.
    const filler = 'x'.repeat(60);
    const fillerCount = 500;
    for (let i = 0; i < fillerCount; i++) {
      await fs.writeFile(
        path.join(repoRoot, `bulk-${String(i).padStart(4, '0')}-${filler}`),
        'bulk\n',
      );
    }
    await fs.writeFile(path.join(repoRoot, '.gitignore'), 'bulk-*\n');
    gitIn(repoRoot, 'add', '.gitignore');
    gitIn(repoRoot, 'commit', '-q', '-m', 'ignore bulk', '--no-verify');
    await fs.writeFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), 'bulk-*\n');
    gitIn(repoRoot, 'add', '-f', WORKTREE_INCLUDE_FILE);
    gitIn(repoRoot, 'commit', '-q', '-m', 'include bulk', '--no-verify');
    await fs.writeFile(path.join(repoRoot, 'one.txt'), 'dirty\n');

    const service = new GitWorktreeService(repoRoot, baseDir);
    const created = await service.createUserWorktree('bulk', 'main', {
      carryDirtyState: true,
      maxCarriedPathsBytes: CARRIED_PATHS_MAX_BYTES,
    });

    // Fail-open, as the contract documents: the worktree is created and gets
    // the entries that still fit in the journal, rather than failing the
    // whole creation over a set the caller could never record.
    expect(created.success).toBe(true);
    const carried = created.carriedPaths ?? [];
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.length).toBeLessThan(fillerCount);
    expect(
      Buffer.byteLength(JSON.stringify(carried), 'utf8'),
    ).toBeLessThanOrEqual(CARRIED_PATHS_MAX_BYTES);
    expect(await exists(path.join(created.worktree!.path, 'one.txt'))).toBe(
      true,
    );
  });
});
