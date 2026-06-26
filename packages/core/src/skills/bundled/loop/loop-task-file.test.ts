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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toMatchObject({ source: 'home', content: 'user tasks' });
    // The project FIFO path is never opened — proof there is no blocking open().
    for (const call of openSpy.mock.calls) {
      expect(String(call[0])).not.toBe(projectLoop);
    }
  });

  it('reads a home loop.md that is a symlink to a real regular file', async () => {
    // The user's own dotfile may legitimately be a symlink (e.g. into a synced
    // dotfiles repo). Follow it, as long as the target is a real regular file.
    await fs.mkdir(path.join(homeDir, '.qwen'), { recursive: true });
    const target = path.join(tempDir, 'dotfiles-loop.md');
    await fs.writeFile(target, 'symlinked user tasks');
    await fs.symlink(target, path.join(homeDir, '.qwen', 'loop.md'));

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'symlinked user tasks',
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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

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

    await expect(readLoopTaskFile({ projectRoot, homeDir })).rejects.toThrow(
      /EACCES/,
    );
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
    await expect(readLoopTaskFile({ projectRoot, homeDir })).rejects.toThrow(
      /EACCES/,
    );

    // Second tick: the poisoned entry was evicted, so realpath is retried and
    // the project loop.md resolves — proving the rejection was not cached.
    const result = await readLoopTaskFile({ projectRoot, homeDir });

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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'found',
      path: path.join(homeDir, '.qwen', 'loop.md'),
      source: 'home',
      content: 'user tasks',
      truncated: false,
    });
  });

  it('returns missing when every candidate is empty', async () => {
    await writeProject('');
    await writeHome('\n  \n');

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
    });
  });

  it('returns a missing result when no task file exists', async () => {
    await expect(readLoopTaskFile({ projectRoot, homeDir })).resolves.toEqual({
      status: 'missing',
      checkedPaths: [
        path.join(projectRoot, '.qwen', 'loop.md'),
        path.join(homeDir, '.qwen', 'loop.md'),
      ],
    });
  });

  it('byte-caps task files above the cap and flags them truncated', async () => {
    await writeProject('x'.repeat(LOOP_TASK_FILE_MAX_BYTES + 5));

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.truncated).toBe(true);
    }
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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(
        LOOP_TASK_FILE_MAX_BYTES,
      );
    }
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

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result).toMatchObject({
      status: 'found',
      content: body,
      truncated: false,
    });
    expect(readLengths.length).toBeGreaterThan(0);
    for (const length of readLengths) {
      expect(length).toBeLessThanOrEqual(cap);
    }
  });

  it('does not truncate task files at exactly the byte cap', async () => {
    await writeProject('x'.repeat(LOOP_TASK_FILE_MAX_BYTES));

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(Buffer.byteLength(result.content, 'utf8')).toBe(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.truncated).toBe(false);
    }
  });

  it('truncates on a UTF-8 boundary without exceeding the cap or inserting a replacement char', async () => {
    // 3-byte chars make the raw byte cap land mid-character.
    await writeProject('一'.repeat(LOOP_TASK_FILE_MAX_BYTES));

    const result = await readLoopTaskFile({ projectRoot, homeDir });

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
        LOOP_TASK_FILE_MAX_BYTES,
      );
      expect(result.content).not.toContain('�');
    }
  });
});
