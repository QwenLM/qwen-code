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
  LOOP_TASK_FILE_MAX_BYTES as CAP,
  readLoopTaskFile,
  type LoopTaskFileResult,
  type LoopTaskFileSource,
  type ReadLoopTaskFileOptions,
} from './loop-task-file.js';

// Only open is controllable (the bounded reader's injection point: fs.open +
// filehandle.read); it and every other fs call default to the real impl.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

// Captures debug calls so a test can assert WHY a candidate was skipped (the
// whitespace-only branch); production debug() no-ops without a session anyway.
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

type Found = Extract<LoopTaskFileResult, { status: 'found' }>;
const realFs = () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const fsError = (message: string, code: string) =>
  Object.assign(new Error(message), { code });
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
// `n` bytes of 'a' followed by the given raw bytes.
const aThen = (n: number, tail: number[]) =>
  Buffer.concat([Buffer.alloc(n, 0x61), Buffer.from(tail)]);

// Asserts a `found` result and narrows it for the content/truncated checks.
function expectFound(result: LoopTaskFileResult): asserts result is Found {
  expect(result.status).toBe('found');
  if (result.status !== 'found') {
    throw new Error('expected loop.md to be found');
  }
}

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

  const loopIn = (dir: string) => path.join(dir, '.qwen', 'loop.md');
  const mkQwen = (dir: string) =>
    fs.mkdir(path.join(dir, '.qwen'), { recursive: true });
  const writeLoop = (dir: string, content: string | Buffer) =>
    mkQwen(dir).then(() => fs.writeFile(loopIn(dir), content));
  const writeProject = (content: string | Buffer) =>
    writeLoop(projectRoot, content);
  const writeHome = (content: string) => writeLoop(homeDir, content);
  const read = (opts: Partial<ReadLoopTaskFileOptions> = {}) =>
    readLoopTaskFile({ projectRoot, homeDir, allowProjectFile: true, ...opts });
  const found = (
    source: LoopTaskFileSource,
    content: string,
    filePath = loopIn(source === 'project' ? projectRoot : homeDir),
  ) => ({ status: 'found', path: filePath, source, content, truncated: false });
  const missing = (...checkedPaths: string[]) => ({
    status: 'missing',
    checkedPaths,
  });
  const missingBoth = () => missing(loopIn(projectRoot), loopIn(homeDir));

  // Reads with defaults, asserts `found` + truncation flag; returns content.
  const readFound = async (truncated: boolean) => {
    const result = await read();
    expectFound(result);
    expect(result.truncated).toBe(truncated);
    return result.content;
  };

  // Fake one fs function for `target` only; every other path stays real.
  const fakeFor = async (
    name: 'lstat' | 'stat' | 'realpath',
    target: string,
    fake: () => Promise<unknown>,
  ) => {
    const actual = await realFs();
    const real = actual[name] as (p: string) => Promise<unknown>;
    vi.spyOn(fs, name).mockImplementation(((p: string) =>
      String(p) === target ? fake() : real(p)) as never);
  };

  // Records each handle.read() length on the next (real) fs.open handle, so a
  // "read the whole file, then slice" regression trips the per-read/cumulative
  // cap assertions. Returns the array, filled by reference.
  const recordHandleReadLengths = async (): Promise<number[]> => {
    const lengths: number[] = [];
    const actual = await realFs();
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

  // Every read stays within the cap budget (cap + 1 detects truncation).
  const expectReadsBounded = (lengths: number[]) => {
    expect(lengths.length).toBeGreaterThan(0);
    for (const length of lengths) expect(length).toBeLessThanOrEqual(CAP + 1);
  };

  it('reads the project loop task file first', async () => {
    await writeProject('project tasks');
    await writeHome('user tasks');

    expect(await read()).toEqual(found('project', 'project tasks'));
  });

  it('falls back to the user loop task file', async () => {
    await writeHome('user tasks');

    expect(await read()).toEqual(found('home', 'user tasks'));
  });

  it('does not follow symlinked project loop task files', async () => {
    await mkQwen(projectRoot);
    const outside = path.join(tempDir, 'secret.txt');
    await fs.writeFile(outside, 'secret tasks');
    await fs.symlink(outside, loopIn(projectRoot));
    await writeHome('user tasks');

    expect(await read()).toEqual(found('home', 'user tasks'));
  });

  it('refuses a project loop.md whose .qwen ancestor symlinks outside the workspace', async () => {
    // `.qwen -> <outside>` makes a final-component lstat pass while the file
    // resolves outside the project; realpath must catch the ancestor symlink.
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'loop.md'), 'escaped tasks');
    await fs.symlink(outside, path.join(projectRoot, '.qwen'));
    await writeHome('user tasks');

    expect(await read()).toEqual(found('home', 'user tasks'));
  });

  it('refuses a project loop.md resolving to a SIBLING dir that shares a name prefix', async () => {
    // isWithin appends path.sep before startsWith, so root `<ws>/foo` must NOT
    // accept a candidate under the sibling `<ws>/foobar`: symlink foo's `.qwen`
    // to `<ws>/foobar/.qwen`, whose canonical path bare-startsWith `<ws>/foo`
    // yet is NOT a descendant. A regression to a bare `real.startsWith(root)`
    // (no separator) would wave this cross-workspace read through.
    const fooRoot = path.join(tempDir, 'foo');
    const siblingQwen = path.join(tempDir, 'foobar', '.qwen');
    await fs.mkdir(fooRoot, { recursive: true });
    await fs.mkdir(siblingQwen, { recursive: true });
    await fs.writeFile(path.join(siblingQwen, 'loop.md'), 'sibling tasks');
    await fs.symlink(siblingQwen, path.join(fooRoot, '.qwen'));
    await writeHome('user tasks');

    // Refused → falls through to home; the sibling content is never returned.
    expect(await read({ projectRoot: fooRoot })).toEqual(
      found('home', 'user tasks'),
    );
  });

  it('does not read a project loop.md symlinked to an in-workspace file (exfiltration guard)', async () => {
    // What confinement alone misses: a repo-committed `.qwen/loop.md -> ../.env`
    // resolves INSIDE the workspace, so confinement passes — yet it must NOT be
    // read. A symlinked project loop.md is refused outright; only a real
    // regular file at the literal path is read.
    await mkQwen(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, '.env'),
      'SECRET=should-not-be-read',
    );
    await fs.symlink(path.join('..', '.env'), loopIn(projectRoot));
    await writeHome('user tasks');

    expect(await read()).toEqual(found('home', 'user tasks'));
  });

  it('does not read a HARD-LINKED project loop.md (exfiltration guard)', async () => {
    // What the symlink guard misses: `ln <secret> .qwen/loop.md` is an ordinary
    // regular file (no symlink, isFile() true) SHARING the secret's inode
    // (nlink 2) and resolving to itself in the workspace, so confinement passes
    // too — only the `nlink > 1` guard refuses it. Mutation check: drop that
    // guard and the secret is returned as the project source.
    await mkQwen(projectRoot);
    const secret = path.join(tempDir, 'secret-env');
    await fs.writeFile(secret, 'SECRET=should-not-be-read');
    const projectLoop = loopIn(projectRoot);
    await fs.link(secret, projectLoop); // hard link → nlink 2, same inode
    // Precondition: the link really is a hard link to the secret, not a symlink.
    const linkStat = await fs.lstat(projectLoop);
    expect(linkStat.isSymbolicLink()).toBe(false);
    expect(linkStat.nlink).toBeGreaterThan(1);
    await writeHome('user tasks');

    // Skipped → home is read; the secret is never returned from any candidate.
    const result = await read();
    expect(result).toEqual(found('home', 'user tasks'));
    expect((result as Found).content).not.toContain('SECRET');
  });

  it('does not read a HARD-LINKED home loop.md (exfiltration guard)', async () => {
    // Same vector on the home candidate: fs.stat follows to a regular file with
    // nlink 2, so isFile()/confinement pass — only `nlink > 1` refuses it. No
    // project file here, so the result is `missing`; the secret never returns.
    await mkQwen(homeDir);
    const secret = path.join(tempDir, 'home-secret');
    await fs.writeFile(secret, 'SECRET=should-not-be-read');
    await fs.link(secret, loopIn(homeDir));
    expect((await fs.lstat(loopIn(homeDir))).nlink).toBeGreaterThan(1);

    expect(await read()).toEqual(missingBoth());
  });

  it('does not falsely refuse a project loop.md when the workspace root is a filesystem root', async () => {
    // From a filesystem root realRoot is `/` (or `C:\`), so the old
    // `realRoot + path.sep` prefix became `//` (`C:\\`), which no descendant
    // startsWith — wrongly refusing every project loop.md. Mock realpath so the
    // root resolves to the filesystem root; loop.md must be read, not refused.
    await writeProject('- root-level tasks');
    const root = path.parse(projectRoot).root; // '/' on POSIX, e.g. 'C:\\' on Windows
    await fakeFor('realpath', projectRoot, async () => root);

    expect(await read()).toMatchObject({
      status: 'found',
      source: 'project',
      content: '- root-level tasks',
    });
  });

  it('skips a FIFO/non-regular project loop.md before opening it (does not hang)', async () => {
    // A FIFO must be rejected BEFORE the blocking fs.open: open() on a FIFO
    // blocks until a writer appears, wedging the tick forever. A mocked lstat
    // stands in for a (platform-fragile) real mkfifo; the load-bearing proof is
    // that fs.open is never called on the project path.
    await writeHome('user tasks');
    const projectLoop = loopIn(projectRoot);
    await fakeFor('lstat', projectLoop, async () => ({
      isSymbolicLink: () => false,
      isFile: () => false,
      isFIFO: () => true,
    }));
    vi.mocked(fs.open).mockClear();

    expect(await read()).toMatchObject({
      source: 'home',
      content: 'user tasks',
    });
    // The project FIFO path is never opened — proof there is no blocking open().
    for (const call of vi.mocked(fs.open).mock.calls) {
      expect(String(call[0])).not.toBe(projectLoop);
    }
  });

  it('reads a home loop.md that is a symlink to a real regular file inside $HOME', async () => {
    // The user's own dotfile may legitimately be a symlink (e.g. into a synced
    // dotfiles repo). Follow it, as long as the target is a real regular file
    // that resolves WITHIN $HOME (the confinement added for escapes).
    await mkQwen(homeDir);
    const target = path.join(homeDir, 'dotfiles', 'loop.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'symlinked user tasks');
    await fs.symlink(target, loopIn(homeDir));

    expect(await read()).toEqual(found('home', 'symlinked user tasks'));
  });

  it('skips a home loop.md whose symlink target escapes $HOME', async () => {
    // Home symlinks are allowed (dotfiles repos), but only if they resolve
    // WITHIN $HOME. A `~/.qwen/loop.md -> /etc/passwd`-style escape (here a
    // sibling outside homeDir) must be skipped, not read and fed to the model.
    await mkQwen(homeDir);
    const outside = path.join(tempDir, 'outside-secret');
    await fs.writeFile(outside, 'SECRET=should-not-be-read');
    await fs.symlink(outside, loopIn(homeDir));

    expect(await read()).toEqual(missingBoth());
  });

  it('reads the home loop.md from a relocated homeQwenDir (QWEN_HOME)', async () => {
    // The home candidate lives in the QWEN_HOME-aware global dir, not always
    // <homeDir>/.qwen — loop.md in a relocated global dir is read as the `home`
    // source from <homeQwenDir>/loop.md.
    const relocated = path.join(tempDir, 'relocated-qwen');
    await fs.mkdir(relocated, { recursive: true });
    await fs.writeFile(path.join(relocated, 'loop.md'), 'relocated user tasks');

    // Caller passes the global dir as both candidate dir and confinement root
    // when QWEN_HOME is set (see Session.#getLoopTickResolver).
    expect(await read({ homeDir: relocated, homeQwenDir: relocated })).toEqual(
      found('home', 'relocated user tasks', path.join(relocated, 'loop.md')),
    );
  });

  it('keeps confinement for a relocated homeQwenDir (escaping symlink refused)', async () => {
    // Relocation must not loosen the earlier confinement: a symlink whose target
    // escapes the home confinement root is still refused, not read.
    const relocated = path.join(tempDir, 'relocated-qwen');
    await fs.mkdir(relocated, { recursive: true });
    const outside = path.join(tempDir, 'outside-secret');
    await fs.writeFile(outside, 'SECRET=should-not-be-read');
    await fs.symlink(outside, path.join(relocated, 'loop.md'));

    expect(await read({ homeDir: relocated, homeQwenDir: relocated })).toEqual(
      missing(loopIn(projectRoot), path.join(relocated, 'loop.md')),
    );
  });

  it('skips a home loop.md that is a self-referential symlink (ELOOP) instead of throwing', async () => {
    // fs.stat follows the home symlink; a self-referential link raises ELOOP,
    // which must skip the candidate (→ missing), not crash the tick — without
    // ELOOP in the skip whitelist this rethrows and aborts.
    await mkQwen(homeDir);
    const loop = loopIn(homeDir);
    await fs.symlink(loop, loop); // points at itself → ELOOP on stat

    expect(await read()).toEqual(missing(loopIn(projectRoot), loop));
  });

  it('skips a home loop.md that resolves to a non-regular file (directory/FIFO)', async () => {
    // The home candidate follows symlinks via fs.stat; a directory/FIFO target
    // must be skipped. The project path proves this via lstat, but the home
    // path's fs.stat needs its own coverage so a blocking open / directory
    // read never happens.
    const homeLoop = loopIn(homeDir);
    await writeHome('- user tasks'); // real file so realpath resolves
    await fakeFor('stat', homeLoop, async () => ({
      isFile: () => false,
      isDirectory: () => true,
    }));
    vi.mocked(fs.open).mockClear();

    expect((await read()).status).toBe('missing');
    // The non-regular guard fired before any open() on the home path.
    for (const call of vi.mocked(fs.open).mock.calls) {
      expect(String(call[0])).not.toBe(homeLoop);
    }
  });

  it('defaults to fail-secure: omitting allowProjectFile skips the project file', async () => {
    // Re-exported from the core barrel: an external caller that forgets the
    // option must NOT read the repo-controlled project loop.md from an untrusted
    // workspace. The default is false — callers opt IN to trust.
    await writeProject('repo-controlled tasks');
    await writeHome('user tasks');

    expect(await readLoopTaskFile({ projectRoot, homeDir })).toEqual(
      found('home', 'user tasks'),
    );
  });

  it('skips the project candidate entirely when allowProjectFile is false', async () => {
    // Untrusted folder: the repo-controlled project loop.md is not read even
    // when present; the user-owned home loop.md still is.
    await writeProject('repo-controlled tasks');
    await writeHome('user tasks');

    expect(await read({ allowProjectFile: false })).toEqual(
      found('home', 'user tasks'),
    );
  });

  it('reports only the home path as missing when allowProjectFile is false', async () => {
    expect(await read({ allowProjectFile: false })).toEqual(
      missing(loopIn(homeDir)),
    );
  });

  it('skips a non-directory component at .qwen (ENOTDIR) and falls through', async () => {
    // A regular file where the `.qwen` dir should be → reading .qwen/loop.md
    // raises ENOTDIR; skip to home rather than throwing.
    await fs.writeFile(path.join(projectRoot, '.qwen'), 'not a dir');
    await writeHome('user tasks');

    expect(await read()).toEqual(found('home', 'user tasks'));
  });

  it('skips a directory at the loop.md path and falls through', async () => {
    // A directory at the project path yields EISDIR on read — skip it, not throw.
    await fs.mkdir(loopIn(projectRoot), { recursive: true });
    await writeHome('user tasks');

    expect(await read()).toEqual(found('home', 'user tasks'));
  });

  it('rethrows non-whitelisted fs errors (e.g. EACCES)', async () => {
    // Only ENOENT/EISDIR/ENOTDIR fall through to the next candidate; a real
    // error such as a permission denial must surface, not be swallowed.
    await writeProject('project tasks');
    vi.mocked(fs.open).mockRejectedValueOnce(
      fsError('EACCES: permission denied', 'EACCES'),
    );

    await expect(read()).rejects.toThrow(/EACCES/);
  });

  it('evicts the cached project-root realpath after a transient failure and retries on the next tick', async () => {
    // The project-root realpath is cached per process. A TRANSIENT failure
    // (EACCES/ENOENT) must NOT be pinned: the entry is evicted on rejection so
    // the next tick re-resolves instead of replaying a cached rejection. Drop
    // that eviction and one transient error breaks loop.md resolution for this
    // root forever. Driven purely via the realpath mock.
    await writeProject('project tasks');
    const actual = await realFs();
    const realpathSpy = vi.spyOn(fs, 'realpath');
    // Fail the first project-root resolution, then resolve normally.
    realpathSpy.mockRejectedValueOnce(
      fsError('EACCES: permission denied', 'EACCES'),
    );
    realpathSpy.mockImplementation((p) => actual.realpath(p as string));

    // First tick: the transient error surfaces (current per-tick semantics).
    await expect(read()).rejects.toThrow(/EACCES/);

    // Second tick: the poisoned entry was evicted, so realpath is retried and
    // the project loop.md resolves — proving the rejection was not cached.
    expect(await read()).toEqual(found('project', 'project tasks'));
    // The root was re-resolved on the retry (call #2), not served from a
    // poisoned cache entry; #3 is the loop.md realpath on the successful tick.
    expect(realpathSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips an empty or whitespace-only file and falls through', async () => {
    await writeProject('   \n\t  \n');
    await writeHome('user tasks');

    expect(await read()).toEqual(found('home', 'user tasks'));
  });

  it('logs a debug line when it skips a whitespace-only loop.md', async () => {
    // The whitespace-only skip was the ONLY skip branch with no debug log, so a
    // present-but-empty file looked like an absent one in logs. Assert the
    // labelled skip line fires for the project candidate before falling
    // through to home.
    await writeProject('   \n\t  \n');
    await writeHome('user tasks');
    debugSpy.mockClear();

    expect(await read()).toMatchObject({
      source: 'home',
      content: 'user tasks',
    });
    expect(debugSpy).toHaveBeenCalledWith('skipping whitespace-only loop.md', {
      source: 'project',
      filePath: loopIn(projectRoot),
    });
  });

  it('returns missing when every candidate is empty', async () => {
    await writeProject('');
    await writeHome('\n  \n');

    expect(await read()).toEqual(missingBoth());
  });

  it('returns a missing result when no task file exists', async () => {
    await expect(read()).resolves.toEqual(missingBoth());
  });

  it('byte-caps task files above the cap and flags them truncated', async () => {
    await writeProject('x'.repeat(CAP + 5));

    expect(bytes(await readFound(true))).toBe(CAP);
  });

  it('bounds the read for a very large file (never reads past the cap)', async () => {
    // A multi-MB file must not be fully read/decoded every tick. Observe the
    // actual handle.read() calls: neither any single read nor their sum may
    // exceed the cap budget — so a "read the whole file, then slice" regression
    // (which would pull all 2 MB through these reads) fails this test.
    await writeProject('x'.repeat(2_000_000));
    vi.mocked(fs.open).mockClear();
    const readLengths = await recordHandleReadLengths();

    expect(bytes(await readFound(true))).toBe(CAP);
    // A single bounded fs.open handle, not fs.readFile of the whole.
    expect(fs.open).toHaveBeenCalledTimes(1);
    // Load-bearing: every read, and the total bytes requested, stay within cap.
    expectReadsBounded(readLengths);
    expect(readLengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CAP + 1);
  });

  it('reads a short file fully via bounded reads that never exceed the cap', async () => {
    // The EOF path: a sub-cap file is returned whole (not truncated), and the
    // bounded reader still never requests past the cap on any read.
    const body = 'short tasks\n';
    await writeProject(body);
    const readLengths = await recordHandleReadLengths();

    expect(await read()).toMatchObject({
      status: 'found',
      content: body,
      truncated: false,
    });
    expectReadsBounded(readLengths);
    // Load-bearing: the buffer is sized to the file (+1 for truncation
    // detection), NOT the 25 KB cap — so a tiny loop.md doesn't zero-fill 25 KB
    // every tick. The first read requests exactly that bounded length.
    expect(readLengths[0]).toBe(body.length + 1);
  });

  it('does not truncate task files at exactly the byte cap', async () => {
    await writeProject('x'.repeat(CAP));

    expect(bytes(await readFound(false))).toBe(CAP);
  });

  it('truncates on a UTF-8 boundary without exceeding the cap or inserting a replacement char', async () => {
    // 3-byte chars make the raw byte cap land mid-character.
    await writeProject('一'.repeat(CAP));

    const content = await readFound(true);
    expect(bytes(content)).toBeLessThanOrEqual(CAP);
    expect(content).not.toContain('�');
  });

  it('drops an INCOMPLETE trailing multi-byte sequence at the cap (no orphan lead / U+FFFD)', async () => {
    // A cut mid-4-byte-sequence whose final byte is NOT a continuation defeats
    // the continuation-only back-off: it would keep `f0 9f a6` and decode a
    // trailing U+FFFD. The orphan lands exactly on the cap so the byte-length
    // re-clamp can't mask it; only dropping the whole incomplete lead keeps the
    // tail clean. Bytes: 3 of a 4-byte char, then 'b' (cap + 1 in total).
    await writeProject(aThen(CAP - 3, [0xf0, 0x9f, 0xa6, 0x62]));

    const content = await readFound(true);
    expect(bytes(content)).toBeLessThanOrEqual(CAP);
    // The incomplete sequence is gone entirely — no replacement char, and the
    // body ends on the last complete ('a') char.
    expect(content).not.toContain('�');
    expect(content.endsWith('a')).toBe(true);
  });

  it('drops an INCOMPLETE trailing 2-byte lead at the cap (covers the 2-byte width branch)', async () => {
    // A lone 2-byte lead (0xc3, then a non-continuation) must be dropped by the
    // width branch ((b & 0xe0) === 0xc0 → width 2), not kept as an orphan
    // decoding to U+FFFD. The two trailing continuations put a width-table
    // regression's (0xc3 as width 1) U+FFFD exactly at the cap, where the
    // byte-length re-clamp can't hide it. Bytes: lead, 'A', 2 conts (cap + 1).
    await writeProject(aThen(CAP - 3, [0xc3, 0x41, 0x80, 0x80]));

    const content = await readFound(true);
    expect(content).not.toContain('�');
    expect(content).toBe('a'.repeat(CAP - 3));
  });

  it('drops an INCOMPLETE trailing 3-byte lead at the cap (covers the 3-byte width branch)', async () => {
    // A 3-byte lead with only ONE of its two continuations (0xe4 0xb8), then a
    // non-continuation, must be dropped by the width branch ((b & 0xf0) ===
    // 0xe0 → width 3). A width-table regression (0xe4 as width 1 or 2) leaves
    // its U+FFFD below the cap, surviving the re-clamp, so it is observable.
    // Bytes: lead + 1 cont, 'A', 2 conts (cap + 1).
    await writeProject(aThen(CAP - 4, [0xe4, 0xb8, 0x41, 0x80, 0x80]));

    const content = await readFound(true);
    expect(content).not.toContain('�');
    expect(content).toBe('a'.repeat(CAP - 4));
  });

  it('drops an ORPHAN lead followed by an ASCII byte and stray continuations (no U+FFFD)', async () => {
    // The continuation back-off walks `lead` to the LAST non-continuation byte,
    // so a `> end` width check alone stops at the complete ASCII `0x41` and
    // keeps the orphan `0xc3` before it plus the three stray `0x80`s after it,
    // all decoding to trailing U+FFFD. Re-checking the boundary against the
    // EXACT char width (re-run after each trim) strips the whole tail. The
    // trailing `0x61` defeats the initial back-off, so only the boundary loop
    // removes the `0x80`s. Bytes: orphan lead, 'A', 3 conts, 'a' (cap + 1).
    await writeProject(aThen(CAP - 5, [0xc3, 0x41, 0x80, 0x80, 0x80, 0x61]));

    const content = await readFound(true);
    expect(bytes(content)).toBeLessThanOrEqual(CAP);
    // The whole malformed tail is gone: no replacement char, and the body ends
    // on the last complete ('a') char — a clean UTF-8 boundary.
    expect(content).not.toContain('�');
    expect(content).toBe('a'.repeat(CAP - 5));
  });

  it('skips a candidate that raises ENAMETOOLONG and falls through instead of throwing', async () => {
    // The over-long-path code is in the skip whitelist but otherwise untested; a
    // typo'd entry would start throwing on a real ENAMETOOLONG instead of falling
    // through. Drive it via a mocked lstat on the project path; home still reads.
    await writeHome('user tasks');
    await fakeFor('lstat', loopIn(projectRoot), () =>
      Promise.reject(fsError('ENAMETOOLONG', 'ENAMETOOLONG')),
    );

    expect(await read()).toMatchObject({
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
    const eio = fsError('EIO: i/o error, read', 'EIO');
    const close = vi
      .fn()
      .mockRejectedValue(fsError('EBADF: bad file descriptor, close', 'EBADF'));
    const fakeHandle = {
      stat: async () => ({ isFile: () => true, size: 100 }),
      read: vi.fn().mockRejectedValue(eio),
      close,
    } as unknown as Awaited<ReturnType<typeof fs.open>>;
    // The first fs.open is the project candidate (read first); hand it the
    // fake handle. lstat/realpath above this still run against the real file.
    vi.mocked(fs.open).mockImplementationOnce(async () => fakeHandle);

    await expect(read()).rejects.toBe(eio);
    // The close was still attempted (we swallow its failure, not skip it).
    expect(close).toHaveBeenCalled();
  });
});
