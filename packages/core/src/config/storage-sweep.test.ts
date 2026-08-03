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
