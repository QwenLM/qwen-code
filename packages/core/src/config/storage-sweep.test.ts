/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage, sweepStaleWorktreeProjects } from './storage.js';
import { sanitizeCwd } from '../utils/paths.js';

// The sweep must treat a failed removal as skippable. Simulate the failure by
// mocking rm for the stuck entry only: chmod-based DAC failure is silently
// bypassed when the runner is root (Docker CI, devcontainers).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (dir: fs.PathLike, options?: never) => {
      const entries = await actual.readdir(dir, options);
      // deterministic iteration order: the stuck entry first, so a
      // continue-vs-break regression cannot hide behind filesystem order
      if (Array.isArray(entries)) {
        return [...entries].sort((a, b) => {
          const sa = String(a);
          const sb = String(b);
          if (sa.includes('aaa-stuck') === sb.includes('aaa-stuck')) return 0;
          return sa.includes('aaa-stuck') ? -1 : 1;
        });
      }
      return entries;
    },
    rm: async (target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target).includes('aaa-stuck')) {
        const err = new Error('Permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return actual.rm(target, options);
    },
  };
});

function makeProjectSnapshot(
  base: string,
  entry: string,
  sidecar?: Record<string, string>,
): string {
  const projectDir = path.join(base, 'projects', entry);
  const chatsDir = path.join(projectDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  if (sidecar !== undefined) {
    fs.writeFileSync(
      path.join(chatsDir, 'session-1.worktree.json'),
      JSON.stringify(sidecar),
    );
  }
  return projectDir;
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('sweepStaleWorktreeProjects', () => {
  let base: string;

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-storage-test-'));
  });

  afterEach(async () => {
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('removes project dirs whose worktree no longer exists', async () => {
    const goneWorktree = path.join(base, 'definitely-not-here');
    const entry = sanitizeCwd(goneWorktree);
    const gone = makeProjectSnapshot(base, entry, {
      worktreePath: goneWorktree,
      originalCwd: '/repo',
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([entry]);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('keeps a normal project bucket whose worktree sidecar points at a gone path', async () => {
    // enter/exit run from the original repo never relocates session storage,
    // so the sidecar lands in the normal bucket; deleting it would wipe the
    // repo's chat history.
    const normal = makeProjectSnapshot(base, sanitizeCwd('/repo'), {
      worktreePath: path.join(base, 'removed-worktree'),
      originalCwd: '/repo',
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(normal)).toBe(true);
  });

  it('removes a bucket keyed by a gone ephemeral launch cwd', async () => {
    // #7906's main class: enter_worktree from a throwaway cwd T inside the
    // OS temp dir lands the sidecar in bucket sanitizeCwd(T), and the gate
    // keyed by the worktree path can never match that shape.
    const launchCwd = path.join(base, 'gone-launch-cwd');
    const entry = sanitizeCwd(launchCwd);
    const gone = makeProjectSnapshot(base, entry, {
      worktreePath: path.join(launchCwd, '.qwen', 'worktrees', 'slug'),
      originalCwd: launchCwd,
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([entry]);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('keeps a repo bucket that merely holds an ephemeral-launch sidecar', async () => {
    // /cd relocation can move a sidecar into a bucket it does not key: the
    // ephemeral-launch arm must not delete the repo's history over that.
    const launchCwd = path.join(base, 'gone-launch-cwd');
    const kept = makeProjectSnapshot(base, sanitizeCwd('/repo'), {
      worktreePath: path.join(launchCwd, '.qwen', 'worktrees', 'slug'),
      originalCwd: launchCwd,
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('keeps the bucket when the ephemeral launch cwd still exists', async () => {
    const launchCwd = path.join(base, 'still-here');
    fs.mkdirSync(launchCwd, { recursive: true });
    const kept = makeProjectSnapshot(base, sanitizeCwd(launchCwd), {
      worktreePath: path.join(launchCwd, '.qwen', 'worktrees', 'slug'),
      originalCwd: launchCwd,
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('keeps a bucket whose launch cwd is outside the temp dir and gone', async () => {
    // An absent repo dir can mean an unplugged drive, not garbage.
    const launchCwd = path.join(base, 'outside-tmp');
    const kept = makeProjectSnapshot(base, sanitizeCwd('/gone/repo'), {
      worktreePath: path.join(launchCwd, 'worktrees', 'slug'),
      originalCwd: '/gone/repo',
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('keeps a gate-mismatched bucket whose sidecar has no originalCwd', async () => {
    const kept = makeProjectSnapshot(base, sanitizeCwd('/some/where'), {
      worktreePath: path.join(base, 'removed-worktree'),
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('keeps project dirs whose worktree still exists', async () => {
    const alive = path.join(base, 'wt-alive');
    fs.mkdirSync(alive, { recursive: true });
    const kept = makeProjectSnapshot(base, sanitizeCwd(alive), {
      worktreePath: alive,
      originalCwd: '/repo',
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('keeps project dirs without sidecars and with corrupted sidecars', async () => {
    const noSidecar = makeProjectSnapshot(base, 'normal-project');
    const corrupted = makeProjectSnapshot(base, 'corrupted-project');
    fs.writeFileSync(
      path.join(corrupted, 'chats', 'session-2.worktree.json'),
      '{not json',
    );

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(noSidecar)).toBe(true);
    expect(fs.existsSync(corrupted)).toBe(true);
  });

  it('returns empty when the projects dir does not exist', async () => {
    await expect(
      sweepStaleWorktreeProjects(path.join(base, 'nope')),
    ).resolves.toEqual([]);
  });

  it('judges by archived sidecars too', async () => {
    const goneWorktree = path.join(base, 'definitely-not-here');
    const projectDir = path.join(base, 'projects', sanitizeCwd(goneWorktree));
    const archiveDir = path.join(projectDir, 'chats', 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'session-1.worktree.json'),
      JSON.stringify({
        worktreePath: goneWorktree,
        originalCwd: '/repo',
      }),
    );

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([sanitizeCwd(goneWorktree)]);
    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('falls through a corrupted sidecar to the next valid one', async () => {
    const alive = path.join(base, 'wt-still-here');
    fs.mkdirSync(alive, { recursive: true });
    const projectDir = makeProjectSnapshot(base, sanitizeCwd(alive), {
      worktreePath: path.join(base, 'gone'),
      originalCwd: '/repo',
    });
    fs.writeFileSync(
      path.join(projectDir, 'chats', 'session-0.worktree.json'),
      '{not json',
    );
    fs.writeFileSync(
      path.join(projectDir, 'chats', 'session-2.worktree.json'),
      JSON.stringify({ worktreePath: alive, originalCwd: '/repo' }),
    );

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  it('keeps the bucket when any sidecar points at a live worktree', async () => {
    const alive = path.join(base, 'wt-second-session');
    fs.mkdirSync(alive, { recursive: true });
    const projectDir = makeProjectSnapshot(base, sanitizeCwd(alive), {
      worktreePath: path.join(base, 'gone'),
      originalCwd: '/repo',
    });
    fs.writeFileSync(
      path.join(projectDir, 'chats', 'session-2.worktree.json'),
      JSON.stringify({ worktreePath: alive, originalCwd: '/repo' }),
    );

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  it('continues the sweep when one entry cannot be removed', async () => {
    const stuck = makeProjectSnapshot(
      base,
      sanitizeCwd(path.join(base, 'aaa-stuck-wt')),
      {
        worktreePath: path.join(base, 'aaa-stuck-wt'),
        originalCwd: '/repo',
      },
    );
    const goneWorktree = path.join(base, 'gone-2');
    const gone = makeProjectSnapshot(base, sanitizeCwd(goneWorktree), {
      worktreePath: goneWorktree,
      originalCwd: '/repo',
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([sanitizeCwd(goneWorktree)]);
    expect(fs.existsSync(stuck)).toBe(true);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('keeps the bucket when a runtime.json reports a live session', async () => {
    const goneWorktree = path.join(base, 'gone-wt');
    const entry = sanitizeCwd(goneWorktree);
    const projectDir = makeProjectSnapshot(base, entry, {
      worktreePath: goneWorktree,
      originalCwd: '/repo',
    });
    fs.writeFileSync(
      path.join(projectDir, 'chats', 'session-live.runtime.json'),
      JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        session_id: 'session-live',
        work_dir: '/repo',
        hostname: os.hostname(),
        started_at: Date.now(),
        qwen_version: 'test',
      }),
    );

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([]);
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  it('a dead runtime.json does not veto the sweep', async () => {
    const goneWorktree = path.join(base, 'gone-wt');
    const entry = sanitizeCwd(goneWorktree);
    const projectDir = makeProjectSnapshot(base, entry, {
      worktreePath: goneWorktree,
      originalCwd: '/repo',
    });
    fs.writeFileSync(
      path.join(projectDir, 'chats', 'session-dead.runtime.json'),
      JSON.stringify({
        schema_version: 1,
        pid: 4194303,
        session_id: 'session-dead',
        work_dir: '/repo',
        hostname: os.hostname(),
        started_at: Date.now(),
        qwen_version: 'test',
      }),
    );

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([entry]);
    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('a plain file at the worktree path is not a live worktree', async () => {
    const filePath = path.join(base, 'wt-is-a-file');
    fs.writeFileSync(filePath, 'not a directory');
    const entry = sanitizeCwd(filePath);
    const projectDir = makeProjectSnapshot(base, entry, {
      worktreePath: filePath,
      originalCwd: '/repo',
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual([entry]);
    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('the Storage constructor schedules the sweep once per base dir', async () => {
    const missingWorktree = path.join(base, 'missing');
    makeProjectSnapshot(base, sanitizeCwd(missingWorktree), {
      worktreePath: missingWorktree,
      originalCwd: '/repo',
    });

    new Storage('/tmp/x', base);
    new Storage('/tmp/y', base);
    const firstSnapshot = path.join(
      base,
      'projects',
      sanitizeCwd(missingWorktree),
    );
    await waitFor(() => !fs.existsSync(firstSnapshot));
    expect(fs.existsSync(firstSnapshot)).toBe(false);

    // A later construction on the same base must not sweep again.
    const alsoMissing = path.join(base, 'also-missing');
    makeProjectSnapshot(base, sanitizeCwd(alsoMissing), {
      worktreePath: alsoMissing,
      originalCwd: '/repo',
    });
    new Storage('/tmp/z', base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      fs.existsSync(path.join(base, 'projects', sanitizeCwd(alsoMissing))),
    ).toBe(true);
  });
});
