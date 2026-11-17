/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  captureWorktreeSnapshot,
  readWorktreeSnapshotMeta,
  restoreWorktreeSnapshot,
  buildWorktreeSnapshotMeta,
  WORKTREE_SNAPSHOT_SCHEMA_VERSION,
} from './worktree-snapshot-service.js';
import { WORKTREE_SESSION_FILE } from './gitWorktreeService.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('worktreeSnapshotService (P6 U1)', () => {
  let root: string;
  let worktree: string;
  let snapshotDir: string;

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-snap-')),
    );
    worktree = path.join(root, 'wt');
    snapshotDir = path.join(root, 'snapshots');
    await fs.mkdir(worktree);
    git(worktree, 'init', '-q', '-b', 'main');
    git(worktree, 'config', 'user.email', 't@e.com');
    git(worktree, 'config', 'user.name', 't');
    git(worktree, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'base\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'init', '--no-verify');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const meta = () => ({
    sessionId: 'session-snap',
    slug: 'snap',
    baseCommit: git(worktree, 'rev-parse', 'HEAD'),
    headCommit: git(worktree, 'rev-parse', 'HEAD'),
    branch: 'main',
    dirty: { tracked: 1, untracked: 1 },
  });

  it('captures work and excludes regenerable dirs, .git, and the marker', async () => {
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'dirty-tracked\n');
    await fs.writeFile(
      path.join(worktree, 'untracked.txt'),
      'dirty-untracked\n',
    );
    await fs.mkdir(path.join(worktree, 'node_modules', 'x'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(worktree, 'node_modules', 'x', 'i.js'),
      '//\n',
    );
    await fs.writeFile(path.join(worktree, WORKTREE_SESSION_FILE), 'marker\n');

    const { snapshotPath, metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });

    // Restore over a fresh directory and inspect what survived.
    const restored = path.join(root, 'restored');
    await restoreWorktreeSnapshot(snapshotPath, restored);
    await expect(
      fs.readFile(path.join(restored, 'committed.txt'), 'utf8'),
    ).resolves.toBe('dirty-tracked\n');
    await expect(
      fs.readFile(path.join(restored, 'untracked.txt'), 'utf8'),
    ).resolves.toBe('dirty-untracked\n');
    await expect(
      fs.access(path.join(restored, 'node_modules')),
    ).rejects.toThrow();
    await expect(fs.access(path.join(restored, '.git'))).rejects.toThrow();
    await expect(
      fs.access(path.join(restored, WORKTREE_SESSION_FILE)),
    ).rejects.toThrow();
    await expect(fs.access(metaPath)).resolves.toBeUndefined();
  });

  it('round-trips the metadata header with the current schema version', async () => {
    const m = meta();
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: m,
    });
    const read = await readWorktreeSnapshotMeta(metaPath);
    expect(read.version).toBe(WORKTREE_SNAPSHOT_SCHEMA_VERSION);
    expect(read.sessionId).toBe(m.sessionId);
    expect(read.slug).toBe(m.slug);
    expect(read.baseCommit).toBe(m.baseCommit);
    expect(read.branch).toBe('main');
    expect(read.dirty).toEqual({ tracked: 1, untracked: 1 });
    expect(typeof read.createdAt).toBe('number');
  });

  it('refuses an unknown schema version', async () => {
    const { metaPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    parsed.version = WORKTREE_SNAPSHOT_SCHEMA_VERSION + 99;
    await fs.writeFile(metaPath, JSON.stringify(parsed), 'utf8');
    await expect(readWorktreeSnapshotMeta(metaPath)).rejects.toThrow(
      /Unsupported worktree snapshot version/,
    );
  });

  it('rejects a capture from a worktree path that does not exist', async () => {
    await expect(
      captureWorktreeSnapshot({
        worktreePath: path.join(root, 'missing'),
        snapshotDir,
        meta: meta(),
      }),
    ).rejects.toThrow();
    // A failed capture must not leave a final archive behind.
    await expect(
      fs.access(
        path.join(snapshotDir, 'session-snap.worktree-snapshot.tar.gz'),
      ),
    ).rejects.toThrow();
  });

  it('restores a clean committed tree faithfully', async () => {
    const { snapshotPath } = await captureWorktreeSnapshot({
      worktreePath: worktree,
      snapshotDir,
      meta: meta(),
    });
    const restored = path.join(root, 'restored-clean');
    await restoreWorktreeSnapshot(snapshotPath, restored);
    await expect(
      fs.readFile(path.join(restored, 'committed.txt'), 'utf8'),
    ).resolves.toBe('base\n');
  });

  it('builds a meta header from HEAD and dirty counts, excluding the marker (P6 U3)', async () => {
    await fs.writeFile(path.join(worktree, 'committed.txt'), 'dirty\n');
    await fs.writeFile(path.join(worktree, 'untracked.txt'), 'new\n');
    await fs.writeFile(path.join(worktree, WORKTREE_SESSION_FILE), 'marker\n');
    const head = git(worktree, 'rev-parse', 'HEAD');

    const m = await buildWorktreeSnapshotMeta(worktree, {
      sessionId: 'session-meta',
      slug: 'meta',
      baseCommit: head,
      branch: 'main',
    });

    expect(m.headCommit).toBe(head);
    expect(m.baseCommit).toBe(head);
    expect(m.branch).toBe('main');
    // One tracked edit + one untracked file; the marker is not counted.
    expect(m.dirty).toEqual({ tracked: 1, untracked: 1 });
  });
});
