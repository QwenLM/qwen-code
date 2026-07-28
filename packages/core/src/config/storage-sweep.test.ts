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

  it('the Storage constructor schedules the sweep once per base dir', async () => {
    makeProjectSnapshot(base, '-tmp-qwen-exit-sess-ccc', {
      worktreePath: path.join(base, 'missing'),
      originalCwd: '/repo',
    });

    new Storage('/tmp/x', base);
    new Storage('/tmp/y', base);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(
      fs.existsSync(path.join(base, 'projects', '-tmp-qwen-exit-sess-ccc')),
    ).toBe(false);
  });
});
