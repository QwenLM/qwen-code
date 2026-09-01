/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for `GitWorktreeService.resolveIncludedFiles()` /
 * `copyIncludedPaths()` (Phase D-4) and the `.worktreeinclude` file that
 * drives them. Uses real git invocations + real file copies against a
 * temp repo because the unit-test file mocks simple-git too heavily to
 * exercise the actual selection and copy passes.
 *
 * Two properties get most of the coverage here:
 *
 * - **The candidate set is `git ls-files --others --ignored`.** Tracked
 *   files and non-ignored files are unreachable no matter what a pattern
 *   says, which is what bounds a committed (hence lower-trust)
 *   `.worktreeinclude`.
 * - **Patterns are gitignore-style**, matching the convention the file
 *   already has in other agent CLIs, including the collapsed-directory
 *   re-expansion that `--directory` makes necessary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
// Hoisted so vi.mock can consume it. Two cases below assert on what was
// NOT logged: a rejection warning is the observable proof that an
// enumeration ran at all.
const { mockDebugLogger } = vi.hoisted(() => ({
  mockDebugLogger: {
    isEnabled: vi.fn().mockReturnValue(true),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
  isDebugLogFileEnabled: () => false,
}));

import { GitWorktreeService } from './gitWorktreeService.js';

describe('GitWorktreeService.createUserWorktree() — .worktreeinclude', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  // The repo lives one level DOWN inside a per-test parent dir so that
  // tests needing a sibling of the repo have a private place to put it.
  // Rooting the repo directly at `os.tmpdir()` would make
  // `path.dirname(repoRoot)` the machine-wide temp dir, where a fixed
  // sibling name collides with any concurrent run on the same host.
  let repoParent: string;
  let repoRoot: string;

  /** Writes `.worktreeinclude` at the repo root. */
  const writeInclude = (...lines: string[]) =>
    fs.writeFile(path.join(repoRoot, '.worktreeinclude'), lines.join('\n'));

  /**
   * Writes `.gitignore`. Required for almost every test: only files git
   * actually ignores are candidates for copying.
   */
  const writeGitignore = (...lines: string[]) =>
    fs.writeFile(path.join(repoRoot, '.gitignore'), lines.join('\n') + '\n');

  const write = async (rel: string, content: string) => {
    const abs = path.join(repoRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return abs;
  };

  const exists = (p: string) =>
    fs
      .lstat(p)
      .then(() => true)
      .catch(() => false);

  /** All warn output as one string, for "this never ran" assertions. */
  const warnText = () =>
    mockDebugLogger.warn.mock.calls.map((c) => c.join(' ')).join('\n');

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

  beforeEach(async () => {
    mockDebugLogger.warn.mockClear();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-include-'));
    // Resolve symlinks (macOS /var → /private/var) so path comparisons
    // line up with what GitWorktreeService produces internally.
    repoParent = await fs.realpath(dir);
    repoRoot = path.join(repoParent, 'repo');
    await fs.mkdir(repoRoot);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@e.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'hi\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-verify');
  });

  afterEach(async () => {
    // Removes the repo AND anything a test parked beside it.
    await fs.rm(repoParent, { recursive: true, force: true });
  });

  it('copies a single gitignored file into the new worktree', async () => {
    await writeGitignore('.env');
    await write('.env', 'SECRET=1\n');
    await writeInclude('.env');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-file', 'main');
    expect(result.success).toBe(true);

    const dest = path.join(result.worktree!.path, '.env');
    expect(await fs.readFile(dest, 'utf8')).toBe('SECRET=1\n');
    // A real file, not a link — that is the whole point of this path.
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(false);
  });

  it('expands a gitignore-style glob pattern', async () => {
    await writeGitignore('*.env');
    await write('dev.env', 'DEV');
    await write('prod.env', 'PROD');
    await write('notes.txt', 'plain');
    await writeInclude('*.env');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-glob', 'main');
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    expect(await fs.readFile(path.join(wt, 'dev.env'), 'utf8')).toBe('DEV');
    expect(await fs.readFile(path.join(wt, 'prod.env'), 'utf8')).toBe('PROD');
    // Not ignored, so never a candidate.
    expect(await exists(path.join(wt, 'notes.txt'))).toBe(false);
  });

  it('re-expands a collapsed ignored directory, preserving structure', async () => {
    // `git ls-files --directory` reports a fully-ignored dir as a single
    // `.local/` entry, so this only works if the second scoped pass runs.
    await writeGitignore('.local/');
    await write('.local/config.json', '{}');
    await write('.local/certs/dev.pem', 'PEM');
    await writeInclude('.local/');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-dir', 'main');
    expect(result.success).toBe(true);

    const dest = path.join(result.worktree!.path, '.local');
    expect(await fs.readFile(path.join(dest, 'config.json'), 'utf8')).toBe(
      '{}',
    );
    expect(await fs.readFile(path.join(dest, 'certs', 'dev.pem'), 'utf8')).toBe(
      'PEM',
    );
  });

  it('reaches inside a collapsed directory with a nested pattern', async () => {
    await writeGitignore('.local/');
    await write('.local/config.json', '{}');
    await write('.local/certs/dev.pem', 'PEM');
    await writeInclude('.local/certs/*.pem');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-nested', 'main');
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    expect(
      await fs.readFile(path.join(wt, '.local', 'certs', 'dev.pem'), 'utf8'),
    ).toBe('PEM');
    // The sibling did not match the pattern.
    expect(await exists(path.join(wt, '.local', 'config.json'))).toBe(false);
  });

  it('produces an independent copy — editing it does not touch the main tree', async () => {
    await writeGitignore('.env');
    await write('.env', 'ORIGINAL\n');
    await writeInclude('.env');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-isolated', 'main');
    expect(result.success).toBe(true);

    // This assertion is the reason `.worktreeinclude` copies rather than
    // symlinks: an agent editing `.env` inside the worktree must not
    // write through to the developer's main tree.
    const dest = path.join(result.worktree!.path, '.env');
    await fs.writeFile(dest, 'MUTATED\n');
    expect(await fs.readFile(path.join(repoRoot, '.env'), 'utf8')).toBe(
      'ORIGINAL\n',
    );
  });

  it('never copies a tracked file, even when a pattern matches it', async () => {
    // `secret.key` is committed, so it is not in the `--others --ignored`
    // candidate set and no pattern can select it.
    await write('secret.key', 'TRACKED');
    git('add', 'secret.key');
    git('commit', '-q', '-m', 'add tracked', '--no-verify');
    // Diverge the main-tree copy so a wrongly-permitted overwrite would
    // be visible. With both sides identical the assertion below cannot
    // tell a correct skip from a copy that clobbered the file. The file
    // stays tracked (no re-add, no ignore rule), so it remains outside
    // the `--others --ignored` candidate set either way.
    await write('secret.key', 'LOCAL-EDIT\n');
    await writeInclude('*.key', 'secret.key');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-tracked', 'main');
    expect(result.success).toBe(true);

    // git worktree add supplied the committed content; the copy pass
    // contributed nothing and must not have altered it.
    const dest = path.join(result.worktree!.path, 'secret.key');
    expect(await fs.readFile(dest, 'utf8')).toBe('TRACKED');
  });

  it('never copies an untracked file that git does not ignore', async () => {
    await write('scratch.txt', 'UNTRACKED');
    await writeInclude('scratch.txt');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-untracked', 'main');
    expect(result.success).toBe(true);

    expect(await exists(path.join(result.worktree!.path, 'scratch.txt'))).toBe(
      false,
    );
  });

  it('cannot reach .git internals through a pattern', async () => {
    // git never lists its own internals, so the candidate set makes this
    // unreachable before the per-path gates even run.
    await writeInclude('.git/**', '.git/config');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-git', 'main');
    expect(result.success).toBe(true);

    // `.git` in a worktree is a gitlink FILE; assert we did not turn it
    // into a directory by copying anything underneath it.
    const gitPath = path.join(result.worktree!.path, '.git');
    expect((await fs.lstat(gitPath)).isFile()).toBe(true);
  });

  it('cannot reach the .qwen tree through a pattern', async () => {
    await writeGitignore('.qwen/');
    await write('.qwen/projects/meta.json', '{}');
    await writeInclude('.qwen/**', '.qwen/');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-qwen', 'main');
    expect(result.success).toBe(true);

    expect(
      await exists(path.join(result.worktree!.path, '.qwen', 'projects')),
    ).toBe(false);
  });

  it('skips symlinks rather than copying or dereferencing them', async () => {
    const outside = path.join(repoParent, 'outside.txt');
    await fs.writeFile(outside, 'SECRET');
    await writeGitignore('links/');
    await fs.mkdir(path.join(repoRoot, 'links'));
    await fs.symlink(outside, path.join(repoRoot, 'links', 'leak.txt'), 'file');
    await write('links/ok.txt', 'fine');
    await writeInclude('links/');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-symlink', 'main');
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    // The link is skipped entirely — neither reproduced nor dereferenced.
    expect(await exists(path.join(wt, 'links', 'leak.txt'))).toBe(false);
    // Its ordinary sibling still copied.
    expect(await fs.readFile(path.join(wt, 'links', 'ok.txt'), 'utf8')).toBe(
      'fine',
    );
  });

  it('ignores comment lines, blank lines and surrounding whitespace', async () => {
    await writeGitignore('.env', 'other.txt');
    await write('.env', 'E');
    await write('other.txt', 'O');
    await writeInclude(
      '# local development files',
      '',
      '  .env  ',
      '   ',
      '#other.txt',
      '',
    );

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-comments', 'main');
    expect(result.success).toBe(true);

    expect(await exists(path.join(result.worktree!.path, '.env'))).toBe(true);
    expect(await exists(path.join(result.worktree!.path, 'other.txt'))).toBe(
      false,
    );
  });

  it('is a no-op when .worktreeinclude is absent', async () => {
    await writeGitignore('.env');
    await write('.env', 'E');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-none', 'main');
    expect(result.success).toBe(true);
    expect(await exists(path.join(result.worktree!.path, '.env'))).toBe(false);
  });

  it('is a no-op when .worktreeinclude holds only comments and blanks', async () => {
    await writeGitignore('.env');
    await write('.env', 'E');
    await writeInclude('# nothing here', '', '   ');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-empty', 'main');
    expect(result.success).toBe(true);
    expect(await exists(path.join(result.worktree!.path, '.env'))).toBe(false);
  });

  it('is a no-op when no pattern matches anything', async () => {
    await writeGitignore('.env');
    await write('.env', 'E');
    await writeInclude('*.nomatch', 'nowhere/**');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-nomatch', 'main');
    expect(result.success).toBe(true);
    expect(await exists(path.join(result.worktree!.path, '.env'))).toBe(false);
  });

  it('copies into a directory git already materialised in the worktree', async () => {
    // `config/` is tracked (so `git worktree add` creates it), while
    // `config/local.json` is ignored. The copy must land inside the
    // existing directory rather than tripping the containment gates.
    await write('config/app.json', '{"tracked":true}');
    git('add', 'config/app.json');
    git('commit', '-q', '-m', 'add config', '--no-verify');
    await writeGitignore('config/local.json');
    await write('config/local.json', 'LOCAL');
    await writeInclude('config/local.json');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-into-dir', 'main');
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    expect(
      await fs.readFile(path.join(wt, 'config', 'local.json'), 'utf8'),
    ).toBe('LOCAL');
    // The tracked sibling git placed there is untouched.
    expect(await fs.readFile(path.join(wt, 'config', 'app.json'), 'utf8')).toBe(
      '{"tracked":true}',
    );
  });

  it('lets the symlink win when a path is in both symlinkDirectories and .worktreeinclude', async () => {
    // Ordering contract: the user's own setting outranks a file committed
    // by whoever wrote the repository.
    await writeGitignore('shared/');
    await write('shared/marker', 'real');
    await writeInclude('shared/');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-both', 'main', {
      symlinkDirectories: ['shared'],
    });
    expect(result.success).toBe(true);

    const dest = path.join(result.worktree!.path, 'shared');
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(dest)).toBe(path.join(repoRoot, 'shared'));
  });

  it('works when the repo path itself contains a symlink boundary', async () => {
    // Mirrors the round-7 regression guard in the symlink suite: a
    // canonical-vs-lexical repo root mismatch would reject every entry.
    const linkedRepo = path.join(repoParent, 'repo-link');
    await fs.symlink(repoRoot, linkedRepo, 'dir');
    await writeGitignore('.env');
    await write('.env', 'E');
    await writeInclude('.env');

    const service = new GitWorktreeService(linkedRepo);
    const result = await service.createUserWorktree('copy-symlinked', 'main');
    expect(result.success).toBe(true);

    expect(await exists(path.join(result.worktree!.path, '.env'))).toBe(true);
  });

  // ── Regression coverage for review round 1 ──────────────────────────

  it('expands a collapsed directory for a separator-less pattern (R1-1)', async () => {
    // Gitignore semantics let a slash-less pattern match at any depth, so
    // `.env` must reach `secrets/.env` even though pass 1 collapses the
    // whole directory to a single `secrets/` entry that the matcher does
    // not itself match.
    await writeGitignore('secrets/');
    await write('secrets/.env', 'NESTED');
    await writeInclude('.env');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-sepless', 'main');
    expect(result.success).toBe(true);

    expect(
      await fs.readFile(
        path.join(result.worktree!.path, 'secrets', '.env'),
        'utf8',
      ),
    ).toBe('NESTED');
  });

  it('expands a collapsed directory for a leading-wildcard pattern (R1-1)', async () => {
    // `*.pem` has no literal head at all, so a prefix test would never
    // select the collapsed `.secrets/` for expansion.
    await writeGitignore('.secrets/');
    await write('.secrets/dev.pem', 'PEM');
    // `**/*.pem` contains a separator, so the separator-less rule does not
    // fire; its literal head is empty, which is the case under test.
    await writeInclude('**/*.pem');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-wildcard', 'main');
    expect(result.success).toBe(true);

    expect(
      await fs.readFile(
        path.join(result.worktree!.path, '.secrets', 'dev.pem'),
        'utf8',
      ),
    ).toBe('PEM');
  });

  it('expands a collapsed directory nested deeper than the pattern head (R1-1)', async () => {
    // The collapsed entry is `vendor/cache/`, the pattern head is
    // `vendor/` — the containment runs the other way, so testing only
    // `head.startsWith(entry)` would miss it.
    await writeGitignore('cache/');
    // `vendor/` must hold a tracked file, otherwise git lists it as an
    // untracked directory too and the parent alone would cover the
    // expansion — leaving the case under test unexercised.
    await write('vendor/keep.txt', 'KEEP');
    git('add', 'vendor/keep.txt');
    git('commit', '-q', '-m', 'track vendor', '--no-verify');
    await write('vendor/cache/lib.bin', 'BIN');
    await writeInclude('vendor/**/*.bin');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-deeper', 'main');
    expect(result.success).toBe(true);

    expect(
      await fs.readFile(
        path.join(result.worktree!.path, 'vendor', 'cache', 'lib.bin'),
        'utf8',
      ),
    ).toBe('BIN');
  });

  it('copies a non-ASCII filename under git default quotePath (R1-2)', async () => {
    // With `core.quotePath` at its default, git octal-escapes non-ASCII
    // names, which match no pattern and name no file on disk.
    git('config', 'core.quotepath', 'true');
    await writeGitignore('*.env');
    await write('配置.env', 'CJK');
    await writeInclude('*.env');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-nonascii', 'main');
    expect(result.success).toBe(true);

    expect(
      await fs.readFile(path.join(result.worktree!.path, '配置.env'), 'utf8'),
    ).toBe('CJK');
  });

  it('survives a .worktreeinclude that is a directory (R1-3)', async () => {
    // The fail-open read guard is the only thing keeping an unreadable
    // opt-in file from failing a creation whose worktree is already on
    // disk. `mkdir` is the CI-robust way to force a non-ENOENT error.
    await fs.mkdir(path.join(repoRoot, '.worktreeinclude'));

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-eisdir', 'main');
    expect(result.success).toBe(true);
    expect(result.worktree).toBeDefined();
  });

  it('skips an embedded git repository rather than copying it (R1-9)', async () => {
    // Git stops at a nested repository and emits it as a `dir/` entry
    // even from the scoped pass, so the copy loop's file-only invariant
    // needs the trailing-slash guard on both passes.
    await writeGitignore('.local/');
    await write('.local/plain.txt', 'PLAIN');
    const embedded = path.join(repoRoot, '.local', 'vendor', 'lib');
    await fs.mkdir(embedded, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: embedded });
    await writeInclude('.local/');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-embedded', 'main');
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    // The ordinary sibling still copied...
    expect(
      await fs.readFile(path.join(wt, '.local', 'plain.txt'), 'utf8'),
    ).toBe('PLAIN');
    // ...and the embedded repo left no half-made directory behind.
    expect(await exists(path.join(wt, '.local', 'vendor'))).toBe(false);
  });

  it('does not enumerate the .qwen tree for a broad pattern (R1-10)', async () => {
    // `.qwen` holds the worktrees directory, so expanding it would list
    // every worktree the user has accumulated only to reject each one.
    await write('.qwen/worktrees/w1/.env', 'OTHER');
    await writeGitignore('.qwen/');
    await writeInclude('.qwen/**', '**');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-qwen', 'main');
    expect(result.success).toBe(true);
    expect(await exists(path.join(result.worktree!.path, '.qwen'))).toBe(false);

    // The per-entry gate would reject these anyway; what this pins is
    // that they never got enumerated in the first place. A rejection
    // warning naming the .qwen tree is proof the expansion ran.
    expect(warnText()).not.toContain('.qwen tree is CLI-managed');
  });

  it('ignores an over-cap .worktreeinclude without failing creation (R1-12)', async () => {
    // Committed, hence lower-trust: an unbounded pattern list is a denial
    // of service against creation, and the cap must fail open.
    await writeGitignore('.env');
    await write('.env', 'E');
    await fs.writeFile(
      path.join(repoRoot, '.worktreeinclude'),
      Array.from({ length: 10_001 }, (_, i) => `pattern-${i}`).join('\n'),
    );

    const started = Date.now();
    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-cap', 'main');
    expect(result.success).toBe(true);
    // The whole file is dropped, so nothing is copied and the run is not
    // stalled by compiling ten thousand rules per candidate.
    expect(await exists(path.join(result.worktree!.path, '.env'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);
    // The dropped-whole behavior has to be observable, otherwise an
    // uncapped run that simply matches nothing looks identical.
    expect(warnText()).toContain('over the 10000 cap');
  });

  it('expands a directory whose name looks like pathspec magic (R1-14)', async () => {
    // Git parses a leading `:(...)` in a pathspec as a magic signature,
    // so feeding its own listing back unescaped fatals the scoped pass
    // and drops every collapsed directory, benign ones included.
    await writeGitignore(':(trap)/', '.local/');
    await write(':(trap)/trap.env', 'TRAP');
    await write('.local/benign.txt', 'BENIGN');
    await writeInclude(':(trap)/', '.local/');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-pathspec', 'main');
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    // The benign directory must survive the trap's presence.
    expect(
      await fs.readFile(path.join(wt, '.local', 'benign.txt'), 'utf8'),
    ).toBe('BENIGN');
    expect(
      await fs.readFile(path.join(wt, ':(trap)', 'trap.env'), 'utf8'),
    ).toBe('TRAP');
  });

  it('does not enumerate a directory the symlink pass just linked (R1-17)', async () => {
    // The linked tree now resolves into the main repo, so every file
    // under it would clear the source gates and then die at the
    // dest-parent containment check — one warning each, copying nothing.
    await writeGitignore('vendor/');
    await write('vendor/pkg/index.js', 'JS');
    await writeInclude('vendor/**');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-linked', 'main', {
      symlinkDirectories: ['vendor'],
    });
    expect(result.success).toBe(true);

    const dest = path.join(result.worktree!.path, 'vendor');
    // Still a symlink — the copy pass contributed nothing here.
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);
    // And it got there without resolving every file underneath only to
    // reject each at the dest-parent containment check.
    expect(warnText()).not.toContain('escapes worktree root');
  });

  it('skips entries under a nested linked directory found by pass 2 (R1-17)', async () => {
    // The linked dir sits below a collapsed one, so pass 1 keeps `a/`
    // (it neither equals nor starts with `a/b/`), pass 2 expands it, and
    // only the prefix test can drop the entries under the link.
    await writeGitignore('a/');
    await write('a/b/pkg.js', 'JS');
    await write('a/loose.txt', 'LOOSE');
    await writeInclude('a/**');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-nested-link', 'main', {
      symlinkDirectories: ['a/b'],
    });
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    expect((await fs.lstat(path.join(wt, 'a', 'b'))).isSymbolicLink()).toBe(
      true,
    );
    // The sibling outside the link still copied...
    expect(await fs.readFile(path.join(wt, 'a', 'loose.txt'), 'utf8')).toBe(
      'LOOSE',
    );
    // ...and nothing under the link was resolved just to be rejected.
    expect(warnText()).not.toContain('escapes worktree root');
  });

  it('still copies a configured directory the symlink pass failed to link (R1-17)', async () => {
    // The skip must consult links actually created, not the configured
    // list: an entry that failed to link is a legitimate copy target.
    await writeGitignore('vendor/');
    await write('vendor/pkg/index.js', 'JS');
    // `..` is rejected by the shared gates, so nothing gets linked.
    await writeInclude('vendor/**');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('r1-unlinked', 'main', {
      symlinkDirectories: ['../escape'],
    });
    expect(result.success).toBe(true);

    const dest = path.join(result.worktree!.path, 'vendor', 'pkg', 'index.js');
    expect(await fs.readFile(dest, 'utf8')).toBe('JS');
  });

  it('handles multiple patterns — some matching, some not', async () => {
    await writeGitignore('.env', 'build/', '*.log');
    await write('.env', 'E');
    await write('build/out.js', 'OUT');
    await write('debug.log', 'LOG');
    await writeInclude('.env', 'build/', 'missing-pattern-*', '*.log');

    const service = new GitWorktreeService(repoRoot);
    const result = await service.createUserWorktree('copy-mixed', 'main');
    expect(result.success).toBe(true);

    const wt = result.worktree!.path;
    expect(await exists(path.join(wt, '.env'))).toBe(true);
    expect(await fs.readFile(path.join(wt, 'build', 'out.js'), 'utf8')).toBe(
      'OUT',
    );
    expect(await exists(path.join(wt, 'debug.log'))).toBe(true);
  });
});
