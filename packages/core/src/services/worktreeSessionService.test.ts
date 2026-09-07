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
  type WorktreeSession,
} from './worktreeSessionService.js';
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
        const stats = await originalStat.call(this);
        return Object.assign(stats, {
          ino: typeof stats.ino === 'bigint' ? stats.ino + 1n : stats.ino + 1,
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
        const stats = await originalStat.call(this);
        statCalls++;
        return statCalls === 2
          ? Object.assign(stats, {
              ino:
                typeof stats.ino === 'bigint' ? stats.ino + 1n : stats.ino + 1,
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
});

describe('createWorktreeSession', () => {
  it('exclusively creates a durable sidecar', async () => {
    await createWorktreeSession(filePath, sample);
    expect(await readWorktreeSession(filePath)).toEqual(sample);

    await expect(createWorktreeSession(filePath, sample)).rejects.toMatchObject(
      { code: 'EEXIST' },
    );
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

  it('rejects and clears a sidecar when the marker has another owner', async () => {
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

    const result = await restoreWorktreeContext(
      filePath,
      undefined,
      'old-owner',
    );

    expect(result).toEqual({ contextMessage: null, session: null });
    expect(await readWorktreeSession(filePath)).toBeNull();
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
