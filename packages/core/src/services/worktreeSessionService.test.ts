/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readWorktreeSession,
  writeWorktreeSession,
  clearWorktreeSession,
  restoreWorktreeContext,
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
    const result = await restoreWorktreeContext(filePath);

    expect(result.session).toEqual(live);
    expect(result.contextMessage).toContain(`"${live.slug}"`);
    expect(result.contextMessage).toContain(live.worktreePath);
    expect(result.contextMessage).toContain(live.worktreeBranch);
    // Sidecar should remain on disk so subsequent reads still see it.
    expect(await readWorktreeSession(filePath)).toEqual(live);
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
