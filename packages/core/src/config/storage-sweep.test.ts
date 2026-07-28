/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage, sweepStaleWorktreeProjects } from './storage.js';

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
    const gone = makeProjectSnapshot(base, '-tmp-qwen-exit-sess-aaa', {
      worktreePath: path.join(base, 'definitely-not-here'),
      originalCwd: '/repo',
    });

    const removed = await sweepStaleWorktreeProjects(base);

    expect(removed).toEqual(['-tmp-qwen-exit-sess-aaa']);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('keeps project dirs whose worktree still exists', async () => {
    const alive = path.join(base, 'wt-alive');
    fs.mkdirSync(alive, { recursive: true });
    const kept = makeProjectSnapshot(base, '-tmp-qwen-exit-sess-bbb', {
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

  it('continues the sweep when one entry cannot be removed', async () => {
    const stuck = makeProjectSnapshot(base, '-tmp-qwen-exit-sess-aaa-stuck', {
      worktreePath: path.join(base, 'gone-1'),
      originalCwd: '/repo',
    });
    const gone = makeProjectSnapshot(base, '-tmp-qwen-exit-sess-bbb-gone', {
      worktreePath: path.join(base, 'gone-2'),
      originalCwd: '/repo',
    });
    fs.chmodSync(stuck, 0o000);
    try {
      const removed = await sweepStaleWorktreeProjects(base);
      expect(removed).toEqual(['-tmp-qwen-exit-sess-bbb-gone']);
      expect(fs.existsSync(stuck)).toBe(true);
      expect(fs.existsSync(gone)).toBe(false);
    } finally {
      fs.chmodSync(stuck, 0o755);
    }
  });

  it('the Storage constructor schedules the sweep once per base dir', async () => {
    makeProjectSnapshot(base, '-tmp-qwen-exit-sess-ccc', {
      worktreePath: path.join(base, 'missing'),
      originalCwd: '/repo',
    });

    new Storage('/tmp/x', base);
    new Storage('/tmp/y', base);
    const firstSnapshot = path.join(
      base,
      'projects',
      '-tmp-qwen-exit-sess-ccc',
    );
    await waitFor(() => !fs.existsSync(firstSnapshot));
    expect(fs.existsSync(firstSnapshot)).toBe(false);

    // A later construction on the same base must not sweep again.
    makeProjectSnapshot(base, '-tmp-qwen-exit-sess-ddd', {
      worktreePath: path.join(base, 'also-missing'),
      originalCwd: '/repo',
    });
    new Storage('/tmp/z', base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      fs.existsSync(path.join(base, 'projects', '-tmp-qwen-exit-sess-ddd')),
    ).toBe(true);
  });
});
