/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOOP_TASK_FILE_MAX_BYTES,
  readLoopTaskFile,
} from './loop-task-file.js';

// Make only open controllable; every other fs call stays real so the temp-dir
// fixtures keep working. The reader is bounded via fs.open + filehandle.read,
// so open is the injection point. The default impl calls through to actual.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

// Capture the module's debug calls so a test can assert WHY a candidate was
// skipped (the whitespace-only branch is the load-bearing case). Other tests
// don't read it; production debug() no-ops without an active session anyway.
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    isEnabled: () => true,
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('readLoopTaskFile', () => {
  let tempDir: string;
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-task-file-'));
    projectRoot = path.join(tempDir, 'project');
    homeDir = path.join(tempDir, 'home');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const writeProject = (content: string) =>
    fs
      .mkdir(path.join(projectRoot, '.qwen'), { recursive: true })
      .then(() =>
        fs.writeFile(path.join(projectRoot, '.qwen', 'loop.md'), content),
      );
  const writeHome = (content: string) =>
    fs
      .mkdir(path.join(homeDir, '.qwen'), { recursive: true })
      .then(() =>
        fs.writeFile(path.join(homeDir, '.qwen', 'loop.md'), content),
      );

  // Wrap the next fs.open so each handle.read() length is recorded against a real
  // handle. Lets a test prove the reader stays bounded: a "read the whole file,
  // then slice" regression pulls the full file through these reads and trips the
  // per-read / cumulative cap assertions. Returns the array, filled by reference.
  const recordHandleReadLengths = async (): Promise<number[]> => {
    const lengths: number[] = [];
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.open).mockImplementationOnce(async (p) => {
      const handle = await actual.open(
        p as Parameters<typeof actual.open>[0],
        'r',
      );
      const realRead = handle.read.bind(handle);
      handle.read = ((...readArgs: Parameters<typeof handle.read>) => {
        // Impl calls read(buffer, offset, length, position); record length.
        lengths.push((readArgs as unknown[])[2] as number);
        return realRead(...(readArgs as Parameters<typeof handle.read>));
      }) as typeof handle.read;
      return handle;
    });
    return lengths;
  };

  it('reads the project loop task file first', async () => {
    await writeProject('project tasks');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(projectRoot, '.qwen', 'loop.md'),
      source: 'project',
      content: 'project tasks',
      truncated: false,
    });
  });

  it('falls back to the user loop task file', async () => {
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('does not follow symlinked project loop task files', async () => {
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    const outside = path.join(tempDir, 'secret.txt');
    await fs.writeFile(outside, 'secret tasks');
    await fs.symlink(outside, path.join(projectRoot, '.qwen', 'loop.md'));
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('refuses a project loop.md whose .qwen ancestor symlinks outside the workspace', async () => {
    // `.qwen -> <outside>` makes a final-component lstat pass while the file
    // resolves outside the project; realpath must catch the ancestor symlink.
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'loop.md'), 'escaped tasks');
    await fs.symlink(outside, path.join(projectRoot, '.qwen'));
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('refuses a project loop.md resolving to a SIBLING dir that shares a name prefix', async () => {
    // isWithin appends path.sep before startsWith, so root `<ws>/foo` must NOT
    // accept a candidate under the sibling `<ws>/foobar`. Make projectRoot
    // `<ws>/foo` and symlink its `.qwen` to `<ws>/foobar/.qwen`; realpath then
    // resolves loop.md into `foobar`, whose canonical path bare-startsWith
    // `<ws>/foo` yet is NOT a descendant. A regression to a bare
    // `real.startsWith(root)` (no separator) would wave this cross-workspace
    // read through — this test fails the moment that separator is dropped.
    const fooRoot = path.join(tempDir, 'foo');
    const siblingQwen = path.join(tempDir, 'foobar', '.qwen');
    await fs.mkdir(fooRoot, { recursive: true });
    await fs.mkdir(siblingQwen, { recursive: true });
    await fs.writeFile(path.join(siblingQwen, 'loop.md'), 'sibling tasks');
    await fs.symlink(siblingQwen, path.join(fooRoot, '.qwen'));
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot: fooRoot,
      homeDir,
      allowProjectFile: true,
    });

    // Refused → falls through to home; the sibling content is never returned.
    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('does not read a project loop.md symlinked to an in-workspace file (exfiltration guard)', async () => {
    // The dangerous case confinement alone misses: a repo-committed
    // `.qwen/loop.md -> ../.env` resolves INSIDE the workspace, so the realpath
    // confinement passes — yet it must NOT be read. A symlinked project loop.md
    // is refused outright; only a real regular file at the literal path is read.
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    const secret = path.join(projectRoot, '.env');
    await fs.writeFile(secret, 'SECRET=should-not-be-read');
    await fs.symlink(
      path.join('..', '.env'),
      path.join(projectRoot, '.qwen', 'loop.md'),
    );
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('does not read a HARD-LINKED project loop.md (exfiltration guard)', async () => {
    // The case the symlink guard misses: `ln <secret> .qwen/loop.md` makes
    // loop.md an ordinary regular file (lstat sees no symlink, isFile() true)
    // that SHARES the secret's inode (nlink === 2). It resolves to itself inside
    // the workspace, so confinement passes too — only the `nlink > 1` guard
    // refuses it. Mutation check: drop that guard and the secret is returned as
    // the project source instead of falling through to home.
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    const secret = path.join(tempDir, 'secret-env');
    await fs.writeFile(secret, 'SECRET=should-not-be-read');
    const projectLoop = path.join(projectRoot, '.qwen', 'loop.md');
    await fs.link(secret, projectLoop); // hard link → nlink 2, same inode
    // Precondition: the link really is a hard link to the secret, not a symlink.
    const linkStat = await fs.lstat(projectLoop);
    expect(linkStat.isSymbolicLink()).toBe(false);
    expect(linkStat.nlink).toBeGreaterThan(1);
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    // The hard-linked project file is skipped → home is read; the secret content
    // is never returned from any candidate.
    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(result.content).not.toContain('SECRET');
  });

  it('does not read a HARD-LINKED home loop.md (exfiltration guard)', async () => {
    // Same hard-link vector on the home candidate: `ln <secret> ~/.qwen/loop.md`.
    // fs.stat follows to a regular file with nlink 2, so isFile()/confinement
    // pass — only the `nlink > 1` guard refuses it. No project file here, so the
    // result is `missing`; the secret content is never returned.
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    const secret = path.join(tempDir, 'home-secret');
    await fs.writeFile(secret, 'SECRET=should-not-be-read');
    const homeLoop = path.join(homeDir, '.qwen', 'loop.md');
    await fs.link(secret, homeLoop);
    const linkStat = await fs.lstat(homeLoop);
    expect(linkStat.nlink).toBeGreaterThan(1);

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
    });
  });

  it('does not falsely refuse a project loop.md when the workspace root is a filesystem root', async () => {
    // When the CLI runs from a filesystem root, realRoot is `/` (or `C:\`), so the
    // old `realRoot + path.sep` prefix became `//` (`C:\\`) — which no descendant
    // startsWith, wrongly refusing every project loop.md. Drive realRoot to the
    // filesystem root via a realpath mock; the real loop.md still resolves to a
    // normal absolute path (a descendant of the root) and must be read, not refused.
    await writeProject('- root-level tasks');
    const root = path.parse(projectRoot).root; // '/' on POSIX, e.g. 'C:\\' on Windows
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.spyOn(fs, 'realpath').mockImplementation((p) =>
      String(p) === projectRoot
        ? Promise.resolve(root)
        : actual.realpath(p as string),
    );

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toMatchObject({
      status: 'found',
      source: 'project',
      content: '- root-level tasks',
    });
  });

  it('skips a FIFO/non-regular project loop.md before opening it (does not hang)', async () => {
    // A FIFO at the project path must be rejected BEFORE the blocking fs.open:
    // open() on a FIFO blocks until a writer appears, wedging the tick forever.
    // Drive a FIFO-typed node via a mocked lstat (a real mkfifo is platform-
    // fragile); the load-bearing proof is that fs.open is never called on the
    // project path, so no blocking open() can happen.
    await writeHome('user tasks');
    const projectLoop = path.join(projectRoot, '.qwen', 'loop.md');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const fifoStat = {
      isSymbolicLink: () => false,
      isFile: () => false,
      isFIFO: () => true,
    } as unknown as Awaited<ReturnType<typeof fs.lstat>>;
    vi.spyOn(fs, 'lstat').mockImplementation(async (p) =>
      String(p) === projectLoop ? fifoStat : actual.lstat(p as string),
    );
    const openSpy = vi.mocked(fs.open);
    openSpy.mockClear();

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toMatchObject({ source: 'home', content: 'user tasks' });
    // The project FIFO path is never opened — proof there is no blocking open().
    for (const call of openSpy.mock.calls) {
      expect(String(call[0])).not.toBe(projectLoop);
    }
  });

  it('reads a home loop.md that is a symlink to a real regular file inside $HOME', async () => {
    // The user's own dotfile may legitimately be a symlink (e.g. into a synced
    // dotfiles repo). Follow it, as long as the target is a real regular file
    // that resolves WITHIN $HOME (the confinement added for escapes).
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    const target = path.join(homeDir, 'dotfiles', 'loop.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'symlinked user tasks');
    await fs.symlink(target, path.join(homeDir, '.qwen', 'loop.md'));

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'symlinked user tasks',
      truncated: false,
    });
  });

  it('skips a home loop.md whose symlink target escapes $HOME', async () => {
    // Home symlinks are allowed (dotfiles repos), but only if they resolve
    // WITHIN $HOME. A `~/.qwen/loop.md -> /etc/passwd`-style escape (here a
    // sibling outside homeDir) must be skipped, not read and fed to the model.
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    const outside = path.join(tempDir, 'outside-secret');
    await fs.writeFile(outside, 'SECRET=should-not-be-read');
    await fs.symlink(outside, path.join(homeDir, '.qwen', 'loop.md'));

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
    });
  });

  it('reads the home loop.md from a relocated homeQwenDir (QWEN_HOME)', async () => {
    // The home candidate lives in the QWEN_HOME-aware global dir, not always
    // <homeDir>/.qwen — write loop.md into a relocated global dir and confirm it
    // is read as the `home` source from <homeQwenDir>/loop.md.
    const relocated = path.join(tempDir, 'relocated-qwen');
    await fs.mkdir(relocated, { recursive: true });
    await fs.writeFile(path.join(relocated, 'loop.md'), 'relocated user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      // Caller passes the global dir as both candidate dir and confinement root
      // when QWEN_HOME is set (see Session.#getLoopTickResolver).
      homeDir: relocated,
      homeQwenDir: relocated,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(relocated, 'loop.md'),
      source: 'home',
      content: 'relocated user tasks',
      truncated: false,
    });
  });

  it('keeps confinement for a relocated homeQwenDir (escaping symlink refused)', async () => {
    // Relocation must not loosen the earlier confinement: a symlink whose target
    // escapes the home confinement root is still refused, not read.
    const relocated = path.join(tempDir, 'relocated-qwen');
    await fs.mkdir(relocated, { recursive: true });
    const outside = path.join(tempDir, 'outside-secret');
    await fs.writeFile(outside, 'SECRET=should-not-be-read');
    await fs.symlink(outside, path.join(relocated, 'loop.md'));

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir: relocated,
      homeQwenDir: relocated,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(relocated, 'loop.md'),
      ],
    });
  });

  it('skips a home loop.md that is a self-referential symlink (ELOOP) instead of throwing', async () => {
    // fs.stat follows the home symlink; a self-referential link raises ELOOP.
    // That must be treated as a skippable candidate (→ missing), not crash the
    // tick — without ELOOP in the skip whitelist this rethrows and aborts.
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    const loop = path.join(homeDir, '.qwen', 'loop.md');
    await fs.symlink(loop, loop); // points at itself → ELOOP on stat

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [path.join(projectRoot, '.qwen', 'loop.md'), loop],
    });
  });

  it('skips a home loop.md that resolves to a non-regular file (directory/FIFO)', async () => {
    // The home candidate follows symlinks via fs.stat; if the (possibly
    // symlinked) target is a directory/FIFO it must be skipped — the project
    // path proves this via lstat, but the home path's fs.stat needs its own
    // coverage so a blocking open / directory read never happens.
    const homeLoop = path.join(homeDir, '.qwen', 'loop.md');
    await fs.mkdir(path.dirname(homeLoop), { recursive: true });
    await fs.writeFile(homeLoop, '- user tasks'); // real file so realpath resolves
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const dirStat = {
      isFile: () => false,
      isDirectory: () => true,
    } as unknown as Awaited<ReturnType<typeof fs.stat>>;
    vi.spyOn(fs, 'stat').mockImplementation(async (p) =>
      String(p) === homeLoop ? dirStat : actual.stat(p as string),
    );
    const openSpy = vi.mocked(fs.open);
    openSpy.mockClear();

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('missing');
    // The non-regular guard fired before any open() on the home path.
    for (const call of openSpy.mock.calls) {
      expect(String(call[0])).not.toBe(homeLoop);
    }
  });

  it('defaults to fail-secure: omitting allowProjectFile skips the project file', async () => {
    // This function is re-exported from the core barrel; an external caller that
    // forgets the option must NOT read the repo-controlled project loop.md from
    // an untrusted workspace. The default is false — callers opt IN to trust.
    await writeProject('repo-controlled tasks');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('skips the project candidate entirely when allowProjectFile is false', async () => {
    // Untrusted folder: the repo-controlled project loop.md is not read even
    // when present; the user-owned home loop.md still is.
    await writeProject('repo-controlled tasks');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: false,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('reports only the home path as missing when allowProjectFile is false', async () => {
    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: false,
    });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [path.join(homeDir, '.qwen', 'loop.md')],
    });
  });

  it('skips a non-directory component at .qwen (ENOTDIR) and falls through', async () => {
    // A regular file where the `.qwen` dir should be → reading .qwen/loop.md
    // raises ENOTDIR; skip to home rather than throwing.
    await fs.writeFile(path.join(projectRoot, '.qwen'), 'not a dir');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('skips a directory at the loop.md path and falls through', async () => {
    // A directory at the project path yields EISDIR on read — skip it, not throw.
    await fs.mkdir(path.join(projectRoot, '.qwen', 'loop.md'), {
      recursive: true,
    });
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('rethrows non-whitelisted fs errors (e.g. EACCES)', async () => {
    // Only ENOENT/EISDIR/ENOTDIR fall through to the next candidate; a real
    // error such as a permission denial must surface, not be swallowed.
    await writeProject('project tasks');
    const eacces = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    vi.mocked(fs.open).mockRejectedValueOnce(eacces);

    await expect(
      readLoopTaskFile({ projectRoot, homeDir, allowProjectFile: true }),
    ).rejects.toThrow(/EACCES/);
  });

  it('evicts the cached project-root realpath after a transient failure and retries on the next tick', async () => {
    // The project-root realpath is cached per process. A TRANSIENT failure
    // (EACCES/ENOENT) must NOT be pinned: the entry is evicted on rejection so
    // the next tick re-resolves instead of replaying a permanently-cached
    // rejection. Drop that eviction and one transient error would break loop.md
    // resolution for this root forever. Drive it purely via the realpath mock.
    await writeProject('project tasks');

    const eacces = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const realpathSpy = vi.spyOn(fs, 'realpath');
    // Fail the first project-root resolution, then resolve normally.
    realpathSpy.mockRejectedValueOnce(eacces);
    realpathSpy.mockImplementation((p) => actual.realpath(p as string));

    // First tick: the transient error surfaces (current per-tick semantics).
    await expect(
      readLoopTaskFile({ projectRoot, homeDir, allowProjectFile: true }),
    ).rejects.toThrow(/EACCES/);

    // Second tick: the poisoned entry was evicted, so realpath is retried and
    // the project loop.md resolves — proving the rejection was not cached.
    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(projectRoot, '.qwen', 'loop.md'),
      source: 'project',
      content: 'project tasks',
      truncated: false,
    });
    // The root was re-resolved on the retry (call #2), not served from a
    // poisoned cache entry; #3 is the loop.md realpath on the successful tick.
    expect(realpathSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips an empty or whitespace-only file and falls through', async () => {
    await writeProject('   \n\t  \n');
    await writeHome('user tasks');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('logs a debug line when it skips a whitespace-only loop.md', async () => {
    // The whitespace-only skip was the ONLY skip branch with no debug log, so a
    // present-but-empty file was indistinguishable from an absent one in logs.
    // Assert the labelled skip line fires for the project candidate before the
    // fall-through to home.
    await writeProject('   \n\t  \n');
    await writeHome('user tasks');
    debugSpy.mockClear();

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toMatchObject({ source: 'home', content: 'user tasks' });
    expect(debugSpy).toHaveBeenCalledWith('skipping whitespace-only loop.md', {
      source: 'project',
      filePath: path.join(projectRoot, '.qwen', 'loop.md'),
    });
  });

  it('returns missing when every candidate is empty', async () => {
    await writeProject('');
    await writeHome('\n  \n');

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
    });
  });

  it('returns a missing result when no task file exists', async () => {
    await expect(
      readLoopTaskFile({ projectRoot, homeDir, allowProjectFile: true }),
    ).resolves.toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
    });
  });

  it('byte-caps task files above the cap and flags them truncated', async () => {
    await writeProject('x'.repeat(LOOP_TASK_FILE_MAX_BYTES + 5));

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(
      LOOP_TASK_FILE_MAX_BYTES,
    );
    expect(result.truncated).toBe(true);
  });

  it('bounds the read for a very large file (never reads past the cap)', async () => {
    // A multi-MB file must not be fully read/decoded every tick. Observe the
    // actual handle.read() calls: neither any single read nor their sum may
    // exceed the cap budget — so a "read the whole file, then slice" regression
    // (which would pull all 2 MB through these reads) fails this test.
    await writeProject('x'.repeat(2_000_000));
    const cap = LOOP_TASK_FILE_MAX_BYTES + 1;
    const openSpy = vi.mocked(fs.open);
    openSpy.mockClear();
    const readLengths = await recordHandleReadLengths();

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(
      LOOP_TASK_FILE_MAX_BYTES,
    );
    // A single bounded fs.open handle, not fs.readFile of the whole.
    expect(openSpy).toHaveBeenCalledTimes(1);
    // Load-bearing: every read, and the total bytes requested, stay within cap.
    expect(readLengths.length).toBeGreaterThan(0);
    for (const length of readLengths) {
      expect(length).toBeLessThanOrEqual(cap);
    }
    expect(readLengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(cap);
  });

  it('reads a short file fully via bounded reads that never exceed the cap', async () => {
    // The EOF path: a sub-cap file is returned whole (not truncated), and the
    // bounded reader still never requests past the cap on any read.
    const body = 'short tasks\n';
    await writeProject(body);
    const cap = LOOP_TASK_FILE_MAX_BYTES + 1;
    const readLengths = await recordHandleReadLengths();

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toMatchObject({
      status: 'found',
      content: body,
      truncated: false,
    });
    expect(readLengths.length).toBeGreaterThan(0);
    for (const length of readLengths) {
      expect(length).toBeLessThanOrEqual(cap);
    }
    // Load-bearing: the buffer is sized to the file (+1 for truncation
    // detection), NOT the 25 KB cap — so a tiny loop.md doesn't zero-fill 25 KB
    // every tick. The first read requests exactly that bounded length.
    expect(readLengths[0]).toBe(body.length + 1);
  });

  it('does not truncate task files at exactly the byte cap', async () => {
    await writeProject('x'.repeat(LOOP_TASK_FILE_MAX_BYTES));

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(
      LOOP_TASK_FILE_MAX_BYTES,
    );
    expect(result.truncated).toBe(false);
  });

  it('truncates on a UTF-8 boundary without exceeding the cap or inserting a replacement char', async () => {
    // 3-byte chars make the raw byte cap land mid-character.
    await writeProject('一'.repeat(LOOP_TASK_FILE_MAX_BYTES));

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
      LOOP_TASK_FILE_MAX_BYTES,
    );
    expect(result.content).not.toContain('�');
  });

  it('drops an INCOMPLETE trailing multi-byte sequence at the cap (no orphan lead / U+FFFD)', async () => {
    // A buffer cut mid-4-byte-sequence whose final byte is NOT a continuation
    // (the sequence is incomplete) defeats the continuation-only back-off: it
    // would keep `f0 9f a6` and decode a trailing U+FFFD. Sized so the orphan
    // lands exactly on the cap, so the byte-length re-clamp can't mask it — only
    // dropping the whole incomplete lead keeps the tail clean.
    const head = Buffer.alloc(LOOP_TASK_FILE_MAX_BYTES - 3, 0x61); // 'a' * (cap-3)
    const partial = Buffer.from([0xf0, 0x9f, 0xa6]); // 3 of a 4-byte char...
    const tail = Buffer.from([0x62]); // ...then 'b' (non-continuation) → incomplete
    const raw = Buffer.concat([head, partial, tail]); // cap + 1 bytes → truncated
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.qwen', 'loop.md'), raw);

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
      LOOP_TASK_FILE_MAX_BYTES,
    );
    // The incomplete sequence is gone entirely — no replacement char, and the
    // body ends on the last complete ('a') char.
    expect(result.content).not.toContain('�');
    expect(result.content.endsWith('a')).toBe(true);
  });

  it('drops an INCOMPLETE trailing 2-byte lead at the cap (covers the 2-byte width branch)', async () => {
    // A lone 2-byte lead (0xc3, its continuation replaced by a non-continuation)
    // must be dropped by the width branch ((b & 0xe0) === 0xc0 → width 2), not
    // kept as an orphan decoding to U+FFFD. The two trailing continuation bytes
    // are sized so a width-table regression (treating 0xc3 as width 1) leaves
    // the orphan's U+FFFD at exactly the cap, where the byte-length re-clamp
    // can't mask it — catching a regression the re-clamp alone would hide.
    const N = LOOP_TASK_FILE_MAX_BYTES;
    const head = Buffer.alloc(N - 3, 0x61); // 'a' * (N-3)
    const tail = Buffer.from([0xc3, 0x41, 0x80, 0x80]); // 2-byte lead, 'A', 2 conts
    const raw = Buffer.concat([head, tail]); // N + 1 bytes → truncated
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.qwen', 'loop.md'), raw);

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(result.truncated).toBe(true);
    expect(result.content).not.toContain('�');
    expect(result.content).toBe('a'.repeat(N - 3));
  });

  it('drops an INCOMPLETE trailing 3-byte lead at the cap (covers the 3-byte width branch)', async () => {
    // A 3-byte lead with only ONE of its two continuations (0xe4 0xb8) followed
    // by a non-continuation must be dropped by the width branch
    // ((b & 0xf0) === 0xe0 → width 3). Sized so a width-table regression (0xe4
    // treated as width 1 or 2) leaves the orphan's U+FFFD below the cap, where
    // it survives the re-clamp — so the regression is observable.
    const N = LOOP_TASK_FILE_MAX_BYTES;
    const head = Buffer.alloc(N - 4, 0x61); // 'a' * (N-4)
    const tail = Buffer.from([0xe4, 0xb8, 0x41, 0x80, 0x80]); // lead+1 cont, 'A', 2 conts
    const raw = Buffer.concat([head, tail]); // N + 1 bytes → truncated
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.qwen', 'loop.md'), raw);

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(result.truncated).toBe(true);
    expect(result.content).not.toContain('�');
    expect(result.content).toBe('a'.repeat(N - 4));
  });

  it('drops an ORPHAN lead followed by an ASCII byte and stray continuations (no U+FFFD)', async () => {
    // The continuation back-off walks `lead` to the LAST non-continuation byte,
    // so a `> end` width check alone stops at the ASCII `0x41` (a complete 1-byte
    // char) and keeps the orphan `0xc3` before it plus the three stray `0x80`
    // continuations after it — all of which decode to trailing U+FFFD. Re-checking
    // the boundary against the EXACT char width (and re-running after each trim)
    // is what strips the whole malformed tail. The trailing `0x61` defeats the
    // initial continuation back-off, so the stray `0x80` bytes are not at the very
    // end and only the boundary loop removes them.
    const N = LOOP_TASK_FILE_MAX_BYTES;
    const head = Buffer.alloc(N - 5, 0x61); // 'a' * (N-5)
    const tail = Buffer.from([0xc3, 0x41, 0x80, 0x80, 0x80, 0x61]); // orphan lead, 'A', 3 conts, 'a'
    const raw = Buffer.concat([head, tail]); // N + 1 bytes → truncated
    await fs.mkdir(path.join(projectRoot, '.qwen'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.qwen', 'loop.md'), raw);

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') {
      throw new Error('expected loop.md to be found');
    }
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
      LOOP_TASK_FILE_MAX_BYTES,
    );
    // The whole malformed tail is gone: no replacement char, and the body ends
    // on the last complete ('a') char — a clean UTF-8 boundary.
    expect(result.content).not.toContain('�');
    expect(result.content).toBe('a'.repeat(N - 5));
  });

  it('skips a candidate that raises ENAMETOOLONG and falls through instead of throwing', async () => {
    // The over-long-path code is in the skip whitelist but otherwise untested; a
    // typo'd entry would start throwing on a real ENAMETOOLONG instead of falling
    // through. Drive it via a mocked lstat on the project path; home still reads.
    await writeHome('user tasks');
    const projectLoop = path.join(projectRoot, '.qwen', 'loop.md');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const enametoolong = Object.assign(new Error('ENAMETOOLONG'), {
      code: 'ENAMETOOLONG',
    });
    vi.spyOn(fs, 'lstat').mockImplementation(async (p) =>
      String(p) === projectLoop
        ? Promise.reject(enametoolong)
        : actual.lstat(p as string),
    );

    const result = await readLoopTaskFile({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });

    expect(result).toMatchObject({
      status: 'found',
      source: 'home',
      content: 'user tasks',
    });
  });

  it('lets the original read error propagate when handle.close() also throws', async () => {
    // readBoundedTaskFile closes the handle in a `finally`. If read() throws
    // (e.g. EIO) AND close() also throws (e.g. EBADF), an unguarded `finally`
    // would replace the original I/O error with the close error, masking the
    // real cause. The close is guarded, so the ORIGINAL read error must survive.
    await writeProject('project tasks'); // real file so lstat/realpath/confine pass
    const eio = Object.assign(new Error('EIO: i/o error, read'), {
      code: 'EIO',
    });
    const ebadf = Object.assign(
      new Error('EBADF: bad file descriptor, close'),
      { code: 'EBADF' },
    );
    const close = vi.fn().mockRejectedValue(ebadf);
    const fakeHandle = {
      stat: async () => ({ isFile: () => true, size: 100 }),
      read: vi.fn().mockRejectedValue(eio),
      close,
    } as unknown as Awaited<ReturnType<typeof fs.open>>;
    // The first fs.open is the project candidate (read first); hand it the
    // fake handle. lstat/realpath above this still run against the real file.
    vi.mocked(fs.open).mockImplementationOnce(async () => fakeHandle);

    await expect(
      readLoopTaskFile({ projectRoot, homeDir, allowProjectFile: true }),
    ).rejects.toBe(eio);
    // The close was still attempted (we swallow its failure, not skip it).
    expect(close).toHaveBeenCalled();
  });
});
