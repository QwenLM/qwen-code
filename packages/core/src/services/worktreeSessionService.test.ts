/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readWorktreeSession,
  readWorktreeSessionStrict,
  writeWorktreeSession,
  createWorktreeSession,
  clearWorktreeSession,
  clearWorktreeSessionDurable,
  restoreWorktreeContext,
  getSessionRuntimeLiveness,
  isSessionRuntimeActive,
  WorktreeSessionReadInconclusiveError,
  WorktreeRestoreRefusedError,
  type WorktreeSession,
} from './worktreeSessionService.js';
import { readWorktreeSessionMarker } from './gitWorktreeService.js';
import { Storage } from '../config/storage.js';
import { writeRuntimeStatus } from '../utils/runtimeStatus.js';

const sample: WorktreeSession = {
  slug: 'my-feature',
  worktreePath: '/repo/.qwen/worktrees/my-feature',
  worktreeBranch: 'worktree-my-feature',
  originalCwd: '/repo',
  originalBranch: 'main',
  originalHeadCommit: 'abc1234',
};

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-session-test-'));
  filePath = path.join(tmpDir, 'test.worktree.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readWorktreeSession', () => {
  it('propagates the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('worktree sidecar read cancelled');
    controller.abort(reason);

    await expect(
      readWorktreeSession(filePath, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it('returns null when file does not exist', async () => {
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('reads back what was written', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf-8');
    expect(await readWorktreeSession(filePath)).toEqual(sample);
  });

  it('returns null for malformed JSON instead of throwing', async () => {
    // Robustness against partial writes / crashes / manual edits.
    // A throwing read would block --resume on every subsequent attempt.
    await fs.writeFile(filePath, 'not valid json {', 'utf-8');
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('returns null when sidecar is missing required fields', async () => {
    // Partial write or schema drift — must not propagate undefined paths
    // to consumers (removeUserWorktree, git status, Footer rendering).
    await fs.writeFile(
      filePath,
      JSON.stringify({ slug: 'x', worktreePath: '/p' }), // missing 4 fields
      'utf-8',
    );
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('returns null when a required field has the wrong type', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ ...sample, slug: 42 }),
      'utf-8',
    );
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('rejects an oversized sidecar without reading it into memory', async () => {
    await fs.writeFile(filePath, 'x'.repeat(64 * 1024 + 1), 'utf8');
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('re-reads and returns the new document when a rename lands during the read', async () => {
    // The daemon's writeWorktreeSession call sites rename a complete,
    // fsync'd document over the sidecar path. A read that observes the swap
    // must not collapse into the corrupt-sidecar null (restoreWorktreeContext
    // deletes that) — it re-reads once and returns the replacement.
    await writeWorktreeSession(filePath, sample);
    const replacement: WorktreeSession = { ...sample, slug: 'slug-b' };
    const stagedPath = path.join(tmpDir, 'staged.worktree.json');
    await writeWorktreeSession(stagedPath, replacement);

    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalStat = prototype.stat;
    await probe.close();
    let renamed = false;
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementation(async function (this: typeof probe) {
        const stats = await originalStat.call(this);
        if (!renamed) {
          renamed = true;
          await fs.rename(stagedPath, filePath);
        }
        return stats;
      });

    try {
      await expect(readWorktreeSession(filePath)).resolves.toEqual(replacement);
      expect(renamed).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });

  it('continues reading a stable sidecar after a short read', async () => {
    // POSIX permits short reads on regular files (FUSE/NFS); a truncated
    // document must not be misread as corrupt JSON and deleted.
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf8');
    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalRead = prototype.read;
    await probe.close();
    const shortRead = function (
      this: typeof probe,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      return originalRead.call(this, {
        buffer,
        offset,
        length: Math.min(length, 5),
        position,
      });
    };
    const readSpy = vi
      .spyOn(prototype, 'read')
      .mockImplementation(shortRead as typeof prototype.read);

    try {
      await expect(readWorktreeSession(filePath)).resolves.toEqual(sample);
      expect(readSpy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a sidecar symlink',
    async () => {
      const target = path.join(tmpDir, 'target.json');
      await fs.writeFile(target, JSON.stringify(sample), 'utf8');
      await fs.symlink(target, filePath);

      expect(await readWorktreeSession(filePath)).toBeNull();
      expect(await fs.readFile(target, 'utf8')).toBe(JSON.stringify(sample));
    },
  );
});

describe('readWorktreeSessionStrict', () => {
  const differentIdentity = (value: number | bigint): number | bigint =>
    typeof value === 'bigint' ? (value === 1n ? 2n : 1n) : value === 1 ? 2 : 1;

  it('distinguishes missing, valid, and malformed sidecars', async () => {
    await expect(readWorktreeSessionStrict(filePath)).resolves.toEqual({
      state: 'missing',
    });

    await fs.writeFile(filePath, JSON.stringify(sample), 'utf8');
    await expect(readWorktreeSessionStrict(filePath)).resolves.toEqual({
      state: 'valid',
      session: sample,
    });

    await fs.writeFile(filePath, '{broken', 'utf8');
    await expect(readWorktreeSessionStrict(filePath)).resolves.toMatchObject({
      state: 'invalid',
    });
  });

  it('rejects symlinked, hard-linked, and oversized sidecars', async () => {
    const target = path.join(tmpDir, 'target');
    await fs.writeFile(target, JSON.stringify(sample), 'utf8');
    await fs.symlink(target, filePath);
    await expect(readWorktreeSessionStrict(filePath)).resolves.toMatchObject({
      state: 'invalid',
    });

    await fs.unlink(filePath);
    await fs.link(target, filePath);
    await expect(readWorktreeSessionStrict(filePath)).resolves.toMatchObject({
      state: 'invalid',
    });

    await fs.unlink(filePath);
    await fs.writeFile(filePath, 'x'.repeat(64 * 1024 + 1));
    await expect(readWorktreeSessionStrict(filePath)).resolves.toMatchObject({
      state: 'invalid',
    });
  });

  it('uses a bounded read for sidecar contents', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf8');
    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as Pick<
      typeof probe,
      'read' | 'readFile'
    >;
    const readSpy = vi.spyOn(prototype, 'read');
    const readFileSpy = vi.spyOn(prototype, 'readFile');
    await probe.close();

    try {
      await expect(readWorktreeSessionStrict(filePath)).resolves.toMatchObject({
        state: 'valid',
      });
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(readSpy).toHaveBeenCalledWith(
        expect.any(Buffer),
        0,
        64 * 1024 + 1,
        0,
      );
    } finally {
      readSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it('rejects a sidecar whose opened identity differs from its path', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf8');
    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalStat = prototype.stat;
    await probe.close();
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementationOnce(async function (this: typeof probe) {
        const stats = await originalStat.call(this, { bigint: true });
        return Object.assign(stats, {
          ino: differentIdentity(stats.ino),
        });
      });

    try {
      await expect(readWorktreeSessionStrict(filePath)).resolves.toEqual({
        state: 'invalid',
        reason: 'sidecar identity changed before read',
      });
    } finally {
      statSpy.mockRestore();
    }
  });

  it('rejects a sidecar whose opened identity changes during the read', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf8');
    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalStat = prototype.stat;
    await probe.close();
    let statCalls = 0;
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementation(async function (this: typeof probe) {
        const stats = await originalStat.call(this, { bigint: true });
        statCalls++;
        return statCalls === 2
          ? Object.assign(stats, {
              ino: differentIdentity(stats.ino),
            })
          : stats;
      });

    try {
      await expect(readWorktreeSessionStrict(filePath)).resolves.toEqual({
        state: 'invalid',
        reason: 'sidecar identity changed during read',
      });
    } finally {
      statSpy.mockRestore();
    }
  });

  it('distinguishes a sidecar that disappears during the read', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf8');
    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalRead = prototype.read;
    await probe.close();
    let removed = false;
    const readSpy = vi
      .spyOn(prototype, 'read')
      .mockImplementation(async function (
        this: typeof probe,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) {
        const result = await originalRead.call(this, {
          buffer,
          offset,
          length,
          position,
        });
        if (!removed) {
          removed = true;
          await fs.unlink(filePath);
        }
        return result;
      } as typeof prototype.read);

    try {
      await expect(readWorktreeSessionStrict(filePath)).resolves.toEqual({
        state: 'invalid',
        reason: 'sidecar disappeared during read',
      });
    } finally {
      readSpy.mockRestore();
    }
  });

  it('continues reading a stable sidecar after a short read', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf8');
    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalRead = prototype.read;
    await probe.close();
    const shortRead = function (
      this: typeof probe,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      return originalRead.call(this, {
        buffer,
        offset,
        length: Math.min(length, 5),
        position,
      });
    };
    const readSpy = vi
      .spyOn(prototype, 'read')
      .mockImplementation(shortRead as typeof prototype.read);

    try {
      await expect(readWorktreeSessionStrict(filePath)).resolves.toEqual({
        state: 'valid',
        session: sample,
      });
      expect(readSpy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
    }
  });
});

describe('writeWorktreeSession', () => {
  it('writes a readable JSON file', async () => {
    await writeWorktreeSession(filePath, sample);
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(sample);
  });

  it('overwrites existing file', async () => {
    await writeWorktreeSession(filePath, sample);
    const updated = { ...sample, slug: 'updated' };
    await writeWorktreeSession(filePath, updated);
    expect(await readWorktreeSession(filePath)).toEqual(updated);
  });

  it('creates parent directory if missing', async () => {
    const nestedPath = path.join(tmpDir, 'nested', 'deep', 'session.json');
    await writeWorktreeSession(nestedPath, sample);
    expect(await readWorktreeSession(nestedPath)).toEqual(sample);
  });

  it('round-trips the supersede link fields used by worktree reset', async () => {
    const linked: WorktreeSession = { ...sample, supersedes: 'session-old' };
    await writeWorktreeSession(filePath, linked);
    await expect(readWorktreeSessionStrict(filePath)).resolves.toEqual({
      state: 'valid',
      session: linked,
    });

    const superseded: WorktreeSession = {
      ...sample,
      supersededBy: 'session-new',
    };
    await writeWorktreeSession(filePath, superseded);
    await expect(readWorktreeSession(filePath)).resolves.toEqual(superseded);
  });

  it('rejects sidecars with non-string supersede links', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ ...sample, supersededBy: 42 }),
      'utf-8',
    );
    await expect(readWorktreeSessionStrict(filePath)).resolves.toMatchObject({
      state: 'invalid',
    });

    await fs.writeFile(
      filePath,
      JSON.stringify({ ...sample, supersedes: null }),
      'utf-8',
    );
    await expect(readWorktreeSessionStrict(filePath)).resolves.toMatchObject({
      state: 'invalid',
    });
  });
});

describe('createWorktreeSession', () => {
  it('does not publish an empty or partial sidecar', async () => {
    const probe = await fs.open(path.join(tmpDir, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as Pick<
      typeof probe,
      'stat' | 'writeFile' | 'sync'
    >;
    const originalStat = prototype.stat;
    const originalWriteFile = prototype.writeFile;
    const originalSync = prototype.sync;
    await probe.close();

    const sizes: Array<number | 'absent'> = [];
    const samplePath = async (): Promise<void> => {
      try {
        sizes.push((await fs.lstat(filePath)).size);
      } catch {
        sizes.push('absent');
      }
    };
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementation(async function (this: typeof prototype) {
        await samplePath();
        const result = await originalStat.call(this);
        await samplePath();
        return result;
      });
    const writeSpy = vi
      .spyOn(prototype, 'writeFile')
      .mockImplementation(async function (
        this: typeof prototype,
        ...args: Parameters<typeof originalWriteFile>
      ) {
        await samplePath();
        await originalWriteFile.apply(this, args);
        await samplePath();
      });
    const syncSpy = vi
      .spyOn(prototype, 'sync')
      .mockImplementation(async function (this: typeof prototype) {
        await samplePath();
        await originalSync.call(this);
        await samplePath();
      });
    try {
      await createWorktreeSession(filePath, sample);
    } finally {
      statSpy.mockRestore();
      writeSpy.mockRestore();
      syncSpy.mockRestore();
    }

    const fullSize = Buffer.byteLength(`${JSON.stringify(sample, null, 2)}\n`);
    expect(sizes.length).toBeGreaterThan(0);
    expect(
      sizes.filter((size) => size !== 'absent' && size !== fullSize),
    ).toEqual([]);
  });

  it('exclusively creates a durable sidecar', async () => {
    await createWorktreeSession(filePath, sample);
    expect(await readWorktreeSession(filePath)).toEqual(sample);

    await expect(createWorktreeSession(filePath, sample)).rejects.toMatchObject(
      { code: 'EEXIST' },
    );
    expect(
      (await fs.readdir(tmpDir)).filter((name) =>
        name.startsWith('test.worktree.json.'),
      ),
    ).toEqual([]);
  });
});

describe('clearWorktreeSession', () => {
  it('deletes the file', async () => {
    await writeWorktreeSession(filePath, sample);
    await clearWorktreeSession(filePath);
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('is a no-op when file does not exist', async () => {
    await expect(clearWorktreeSession(filePath)).resolves.not.toThrow();
  });
});

describe('clearWorktreeSessionDurable', () => {
  it('deletes the sidecar idempotently', async () => {
    await createWorktreeSession(filePath, sample);
    await clearWorktreeSessionDurable(filePath);
    await expect(clearWorktreeSessionDurable(filePath)).resolves.not.toThrow();
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('is idempotent when the parent directory is absent', async () => {
    await expect(clearWorktreeSessionDurable(filePath)).resolves.not.toThrow();
  });
});

describe('isSessionRuntimeActive', () => {
  beforeEach(() => {
    Storage.setRuntimeBaseDir(null);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
  });

  it('lets active runtime status win over a dead status found in an earlier root', async () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const worktreePath = path.join(repoRoot, '.qwen', 'worktrees', 'feature');
    await fs.mkdir(worktreePath, { recursive: true });

    Storage.setRuntimeBaseDir(path.join(tmpDir, 'runtime'));
    await writeRuntimeStatus(
      new Storage(repoRoot).getRuntimeStatusPath('owner-session'),
      {
        sessionId: 'owner-session',
        workDir: repoRoot,
        pid: 2147483647,
      },
    );
    await writeRuntimeStatus(
      new Storage(worktreePath).getRuntimeStatusPath('owner-session'),
      {
        sessionId: 'owner-session',
        workDir: worktreePath,
        pid: process.pid,
      },
    );

    await expect(
      isSessionRuntimeActive('owner-session', [repoRoot, worktreePath]),
    ).resolves.toBe(true);
  });

  it('distinguishes missing evidence from confirmed inactivity', async () => {
    const repoRoot = path.join(tmpDir, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    Storage.setRuntimeBaseDir(path.join(tmpDir, 'runtime'));

    await expect(
      getSessionRuntimeLiveness('owner-session', repoRoot),
    ).resolves.toBe('unknown');
    await expect(
      isSessionRuntimeActive('owner-session', repoRoot),
    ).resolves.toBe(true);

    await writeRuntimeStatus(
      new Storage(repoRoot).getRuntimeStatusPath('owner-session'),
      {
        sessionId: 'owner-session',
        workDir: repoRoot,
        pid: 2147483647,
      },
    );
    await expect(
      getSessionRuntimeLiveness('owner-session', repoRoot),
    ).resolves.toBe('inactive');
  });

  it('treats EPERM from the local pid probe as active', async () => {
    const repoRoot = path.join(tmpDir, 'repo');
    await fs.mkdir(repoRoot, { recursive: true });
    Storage.setRuntimeBaseDir(path.join(tmpDir, 'runtime'));
    await writeRuntimeStatus(
      new Storage(repoRoot).getRuntimeStatusPath('owner-session'),
      {
        sessionId: 'owner-session',
        workDir: repoRoot,
        pid: process.pid,
      },
    );
    const error = Object.assign(new Error('operation not permitted'), {
      code: 'EPERM',
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });

    try {
      await expect(
        getSessionRuntimeLiveness('owner-session', repoRoot),
      ).resolves.toBe('active');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does not trust repo-contained dead runtime status as proof of inactivity', async () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const fakeRuntimeBase = path.join(repoRoot, 'src');
    await fs.mkdir(fakeRuntimeBase, { recursive: true });
    Storage.setRuntimeBaseDir(path.join(tmpDir, 'external-runtime'));
    await writeRuntimeStatus(
      path.join(
        fakeRuntimeBase,
        'projects',
        'fake-project',
        'chats',
        'owner-session.runtime.json',
      ),
      {
        sessionId: 'owner-session',
        workDir: repoRoot,
        pid: 2147483647,
      },
    );

    await expect(
      isSessionRuntimeActive('owner-session', repoRoot),
    ).resolves.toBe(true);
  });
});

describe('restoreWorktreeContext', () => {
  it('returns nulls when no sidecar exists', async () => {
    const result = await restoreWorktreeContext(filePath);
    expect(result.session).toBeNull();
    expect(result.contextMessage).toBeNull();
  });

  it('returns context message + session when worktree dir is alive', async () => {
    // Build a sidecar where worktreePath sits under the structural
    // invariant `<originalCwd>/.qwen/worktrees/<slug>` enforced by
    // restoreWorktreeContext (Phase C review #3256839787).
    const liveCwd = path.join(tmpDir, 'repo');
    const liveWorktree = path.join(liveCwd, '.qwen', 'worktrees', 'my-feature');
    await fs.mkdir(liveWorktree, { recursive: true });
    const live: WorktreeSession = {
      ...sample,
      originalCwd: liveCwd,
      worktreePath: liveWorktree,
    };
    await writeWorktreeSession(filePath, live);
    await fs.writeFile(
      path.join(liveWorktree, '.qwen-session'),
      'session-owner',
      'utf8',
    );
    const result = await restoreWorktreeContext(
      filePath,
      undefined,
      'session-owner',
    );

    expect(result.session).toEqual(live);
    expect(result.contextMessage).toContain(`"${live.slug}"`);
    expect(result.contextMessage).toContain(live.worktreePath);
    expect(result.contextMessage).toContain(live.worktreeBranch);
    // Sidecar should remain on disk so subsequent reads still see it.
    expect(await readWorktreeSession(filePath)).toEqual(live);
  });

  it('restores a sidecar caught in the link-then-unlink publish window', async () => {
    // createWorktreeSession publishes by hard-linking the staged inode onto
    // the sidecar path and only then unlinking the staged name, so a crash
    // (or a concurrent reader) can observe nlink === 2. That state carries
    // complete, fsync'd content — it must restore, not be deleted as stale.
    const liveCwd = path.join(tmpDir, 'repo-inflight');
    const liveWorktree = path.join(liveCwd, '.qwen', 'worktrees', 'inflight');
    await fs.mkdir(liveWorktree, { recursive: true });
    const live: WorktreeSession = {
      ...sample,
      slug: 'inflight',
      originalCwd: liveCwd,
      worktreePath: liveWorktree,
    };
    await createWorktreeSession(filePath, live);
    await fs.writeFile(
      path.join(liveWorktree, '.qwen-session'),
      'session-owner',
      'utf8',
    );
    const inflight = `${filePath}.inflight`;
    await fs.link(filePath, inflight);
    try {
      const result = await restoreWorktreeContext(
        filePath,
        undefined,
        'session-owner',
      );

      expect(result.session).toEqual(live);
      expect(await readWorktreeSession(filePath)).toEqual(live);
    } finally {
      await fs.unlink(inflight);
    }
  });

  it('preserves a sidecar whose identity keeps changing across reads', async () => {
    // A concurrent atomic rewrite makes every read observe an identity swap.
    // That is not corruption: the sidecar on disk holds a complete document,
    // so restore must refuse inconclusively and leave it for the next resume
    // instead of deleting it as stale.
    const liveCwd = path.join(tmpDir, 'repo-unstable');
    const liveWorktree = path.join(liveCwd, '.qwen', 'worktrees', 'unstable');
    await fs.mkdir(liveWorktree, { recursive: true });
    const live: WorktreeSession = {
      ...sample,
      slug: 'unstable',
      originalCwd: liveCwd,
      worktreePath: liveWorktree,
    };
    await writeWorktreeSession(filePath, live);

    const probe = await fs.open(filePath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalStat = prototype.stat;
    await probe.close();
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementation(async function (this: typeof probe) {
        const stats = await originalStat.call(this);
        return Object.assign(stats, { ino: stats.ino === 1 ? 2 : 1 });
      });

    const onWarn = vi.fn();
    let result: Awaited<ReturnType<typeof restoreWorktreeContext>>;
    try {
      result = await restoreWorktreeContext(filePath, onWarn);
    } finally {
      statSpy.mockRestore();
    }

    expect(result!).toEqual({ contextMessage: null, session: null });
    expect(onWarn).toHaveBeenCalledWith(
      expect.any(WorktreeSessionReadInconclusiveError),
    );
    expect(await readWorktreeSession(filePath)).toEqual(live);
  });

  it('restores when the marker sits at nlink 2 in the publish window', async () => {
    // createWorktreeSessionMarkerExclusive publishes by linking the staged
    // sibling onto the marker path and only then unlinking the sibling, so
    // a crash leaves the marker at nlink 2 with complete, fsync'd content
    // naming the owner. The strict reader reports that residue as invalid;
    // the resume path must read it leniently or the legitimate owner loses
    // its worktree binding on every --resume.
    const liveCwd = path.join(tmpDir, 'repo-residue');
    const liveWorktree = path.join(liveCwd, '.qwen', 'worktrees', 'residue');
    await fs.mkdir(liveWorktree, { recursive: true });
    const live: WorktreeSession = {
      ...sample,
      slug: 'residue',
      originalCwd: liveCwd,
      worktreePath: liveWorktree,
    };
    await writeWorktreeSession(filePath, live);
    const markerPath = path.join(liveWorktree, '.qwen-session');
    const stagedPath = `${markerPath}.deadbeef.tmp`;
    await fs.writeFile(stagedPath, 'session-owner', 'utf8');
    await fs.link(stagedPath, markerPath);

    const onWarn = vi.fn();
    const result = await restoreWorktreeContext(
      filePath,
      onWarn,
      'session-owner',
    );

    expect(result.session).toEqual(live);
    expect(result.contextMessage).toContain(live.worktreePath);
    expect(onWarn).not.toHaveBeenCalled();
    expect(await readWorktreeSession(filePath)).toEqual(live);
  });

  it('rejects and preserves a sidecar when the marker has another owner', async () => {
    const liveCwd = path.join(tmpDir, 'repo');
    const liveWorktree = path.join(liveCwd, '.qwen', 'worktrees', 'reowned');
    await fs.mkdir(liveWorktree, { recursive: true });
    const live: WorktreeSession = {
      ...sample,
      slug: 'reowned',
      originalCwd: liveCwd,
      worktreePath: liveWorktree,
    };
    await writeWorktreeSession(filePath, live);
    await fs.writeFile(
      path.join(liveWorktree, '.qwen-session'),
      'new-owner',
      'utf8',
    );

    const onWarn = vi.fn();
    const result = await restoreWorktreeContext(filePath, onWarn, 'old-owner');

    expect(result).toEqual({ contextMessage: null, session: null });
    expect(await readWorktreeSession(filePath)).toEqual(live);
    // A present marker naming another session must refuse — and through
    // the typed error, so entry points surface the lost binding as a
    // user-visible warning instead of a debug log line.
    expect(onWarn).toHaveBeenCalledWith(
      expect.any(WorktreeRestoreRefusedError),
    );
  });

  it('heals a missing marker and restores the binding', async () => {
    // A missing marker is a tolerated state (pre-guard worktree,
    // `git clean -xdf`, a failed publish), and exit_worktree's removal
    // guard treats it as "owner unknown — allow". Refusing the restore
    // would lock the legitimate owner out of its own worktree while the
    // sidecar keeps advertising the binding; instead the sidecar has
    // already passed the containment check, so the marker is re-created
    // for the resuming session and the restore proceeds.
    const liveCwd = path.join(tmpDir, 'repo-missing');
    const liveWorktree = path.join(liveCwd, '.qwen', 'worktrees', 'missing');
    await fs.mkdir(liveWorktree, { recursive: true });
    const live: WorktreeSession = {
      ...sample,
      slug: 'missing',
      originalCwd: liveCwd,
      worktreePath: liveWorktree,
    };
    await writeWorktreeSession(filePath, live);

    const onWarn = vi.fn();
    const result = await restoreWorktreeContext(
      filePath,
      onWarn,
      'session-owner',
    );

    expect(result.session).toEqual(live);
    expect(result.contextMessage).toContain(`"${live.slug}"`);
    expect(result.contextMessage).toContain(live.worktreePath);
    expect(onWarn).not.toHaveBeenCalled();
    // The healed marker re-binds the worktree to the resuming session.
    expect(await readWorktreeSessionMarker(liveWorktree)).toBe('session-owner');
    expect(await readWorktreeSession(filePath)).toEqual(live);
  });

  it('rejects and preserves a sidecar when the marker is invalid', async () => {
    const liveCwd = path.join(tmpDir, 'repo-invalid');
    const liveWorktree = path.join(liveCwd, '.qwen', 'worktrees', 'invalid');
    await fs.mkdir(liveWorktree, { recursive: true });
    const live: WorktreeSession = {
      ...sample,
      slug: 'invalid',
      originalCwd: liveCwd,
      worktreePath: liveWorktree,
    };
    await writeWorktreeSession(filePath, live);
    await fs.mkdir(path.join(liveWorktree, '.qwen-session'));

    const result = await restoreWorktreeContext(
      filePath,
      undefined,
      'session-owner',
    );

    expect(result).toEqual({ contextMessage: null, session: null });
    expect(await readWorktreeSession(filePath)).toEqual(live);
  });

  it('refuses to restore a live worktree whose sidecar names a replacement session', async () => {
    // A worktree reset moves ownership of the checkout to the replacement
    // session but leaves the superseded sidecar (and transcript) on disk.
    // Resuming the old id must not inject the "continue using this path"
    // notice — that would put a second live writer in the replacement's
    // worktree.
    const supersededCwd = path.join(tmpDir, 'superseded-repo');
    const supersededWorktree = path.join(
      supersededCwd,
      '.qwen',
      'worktrees',
      'my-feature',
    );
    await fs.mkdir(supersededWorktree, { recursive: true });
    const superseded: WorktreeSession = {
      ...sample,
      originalCwd: supersededCwd,
      worktreePath: supersededWorktree,
      supersededBy: 'session-replacement',
    };
    await writeWorktreeSession(filePath, superseded);
    const warnings: unknown[] = [];

    const result = await restoreWorktreeContext(filePath, (e) =>
      warnings.push(e),
    );

    expect(result.session).toBeNull();
    expect(result.contextMessage).toBeNull();
    // Unlike the stale cases, the sidecar survives: its supersede link is the
    // daemon reset route's redirect and interrupted-transfer evidence.
    expect(await readWorktreeSession(filePath)).toEqual(superseded);
    expect(warnings).toHaveLength(1);
  });

  it('rejects and clears a sidecar whose worktreePath escapes the managed subtree', async () => {
    // A tampered sidecar pointing at /tmp itself (a real dir) but not
    // under `<originalCwd>/.qwen/worktrees/` must be treated as
    // untrusted, regardless of fs.stat success.
    const escape: WorktreeSession = {
      ...sample,
      originalCwd: tmpDir,
      worktreePath: tmpDir, // outside .qwen/worktrees/
    };
    await writeWorktreeSession(filePath, escape);
    const warnings: unknown[] = [];

    const result = await restoreWorktreeContext(filePath, (e) =>
      warnings.push(e),
    );
    expect(result.session).toBeNull();
    expect(result.contextMessage).toBeNull();
    // Sidecar should have been cleared.
    expect(await readWorktreeSession(filePath)).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects and clears a sidecar that names the managed root itself', async () => {
    const managedRoot = path.join(tmpDir, '.qwen', 'worktrees');
    await fs.mkdir(managedRoot, { recursive: true });
    await writeWorktreeSession(filePath, {
      ...sample,
      originalCwd: tmpDir,
      worktreePath: managedRoot,
    });
    const warnings: unknown[] = [];

    const result = await restoreWorktreeContext(filePath, (error) =>
      warnings.push(error),
    );

    expect(result.session).toBeNull();
    expect(result.contextMessage).toBeNull();
    expect(await readWorktreeSession(filePath)).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('cleans up stale sidecar when worktree dir is gone', async () => {
    // sample.worktreePath points at /repo/.qwen/... which does not exist.
    await writeWorktreeSession(filePath, sample);
    expect(await readWorktreeSession(filePath)).toEqual(sample);

    const result = await restoreWorktreeContext(filePath);
    expect(result.session).toBeNull();
    expect(result.contextMessage).toBeNull();
    // Sidecar should be deleted.
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('treats a regular file at worktreePath as not-a-worktree', async () => {
    const filePathTarget = path.join(tmpDir, 'pretend-worktree');
    await fs.writeFile(filePathTarget, 'not a dir', 'utf-8');
    const bogus: WorktreeSession = { ...sample, worktreePath: filePathTarget };
    await writeWorktreeSession(filePath, bogus);

    const result = await restoreWorktreeContext(filePath);
    expect(result.session).toBeNull();
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('cleans up malformed sidecar so subsequent --resume calls do not keep hitting it', async () => {
    // Reviewer #4174 finding 3252368651: a malformed sidecar used to be
    // returned as null without cleanup, so every --resume hit the same
    // parse error indefinitely. The clear should be best-effort and
    // not surface a warning for the benign null-return case.
    await fs.writeFile(filePath, 'not valid json {', 'utf-8');
    expect(
      await fs
        .stat(filePath)
        .then((s) => s.isFile())
        .catch(() => false),
    ).toBe(true);

    const result = await restoreWorktreeContext(filePath);
    expect(result.session).toBeNull();
    expect(result.contextMessage).toBeNull();
    expect(
      await fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it('cleans up sidecar with valid JSON but missing required fields', async () => {
    // Partial write or schema drift — same recovery as malformed JSON.
    await fs.writeFile(
      filePath,
      JSON.stringify({ slug: 'incomplete' }),
      'utf-8',
    );
    const result = await restoreWorktreeContext(filePath);
    expect(result.session).toBeNull();
    expect(
      await fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });
});
