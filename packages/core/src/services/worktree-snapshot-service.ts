/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worktree snapshot capture/restore (P6, design D7). A snapshot is a
 * self-contained `tar.gz` of a managed worktree's tree plus a JSON metadata
 * header, saved before the worktree is deleted so the work survives cleanup
 * and can be restored when the chat is reopened. Regenerable directories
 * (`node_modules`, build output — the same set `worktreeHasWork` waives), the
 * `.git` link, and the session marker are excluded: restore recreates the
 * worktree and regenerates those, so archiving them would bloat the snapshot
 * without preserving work.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as tar from 'tar';
import {
  DISPOSABLE_IGNORED_ROOTS,
  WORKTREE_SESSION_FILE,
} from './gitWorktreeService.js';

export const WORKTREE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface WorktreeSnapshotMeta {
  version: number;
  sessionId: string;
  slug: string;
  /** The commit the worktree was created at (its detached base or branch tip). */
  baseCommit: string;
  /** The worktree HEAD at capture time (may be ahead of base). */
  headCommit: string;
  /** The checked-out branch, or '' for a detached worktree. */
  branch: string;
  dirty: { tracked: number; untracked: number };
  /** Epoch ms when the snapshot was captured. */
  createdAt: number;
}

export interface CaptureWorktreeSnapshotOptions {
  worktreePath: string;
  /** Directory the snapshot files are written to (the session chats dir). */
  snapshotDir: string;
  meta: Omit<WorktreeSnapshotMeta, 'version' | 'createdAt'>;
}

export interface WorktreeSnapshotPaths {
  snapshotPath: string;
  metaPath: string;
}

/**
 * Whether a worktree-relative path is excluded from the snapshot. `.git` (the
 * worktree link file or a real dir), the session marker, and any path with a
 * regenerable directory segment are excluded.
 */
function isExcludedFromSnapshot(relativePath: string): boolean {
  const norm = relativePath.replace(/^\.\//, '').replace(/\/$/, '');
  if (norm.length === 0) return false;
  if (norm === '.git' || norm.startsWith('.git/')) return true;
  if (norm === WORKTREE_SESSION_FILE) return true;
  return norm
    .split('/')
    .some((segment) => DISPOSABLE_IGNORED_ROOTS.has(segment));
}

async function atomicWriteFile(
  target: string,
  write: (tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await write(tmp);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Capture a worktree to `<snapshotDir>/<sessionId>.worktree-snapshot.tar.gz`
 * with a `.json` metadata header beside it. Both writes are atomic (stage to a
 * temp file, rename), so a crash mid-capture never leaves a half-written
 * archive a later restore would trust. Rejects on any capture error — the
 * caller must not delete the worktree without a durable snapshot.
 */
export async function captureWorktreeSnapshot(
  options: CaptureWorktreeSnapshotOptions,
): Promise<WorktreeSnapshotPaths> {
  const { worktreePath, snapshotDir, meta } = options;
  await fs.mkdir(snapshotDir, { recursive: true });
  const base = path.join(snapshotDir, `${meta.sessionId}.worktree-snapshot`);
  const snapshotPath = `${base}.tar.gz`;
  const metaPath = `${base}.json`;

  await atomicWriteFile(snapshotPath, (tmp) =>
    tar.create(
      {
        cwd: worktreePath,
        file: tmp,
        gzip: true,
        portable: true,
        noMtime: true,
        filter: (p) => !isExcludedFromSnapshot(p),
      },
      ['.'],
    ),
  );

  const fullMeta: WorktreeSnapshotMeta = {
    version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
    createdAt: Date.now(),
    ...meta,
  };
  await atomicWriteFile(metaPath, async (tmp) => {
    await fs.writeFile(tmp, `${JSON.stringify(fullMeta, null, 2)}\n`, 'utf8');
  });

  return { snapshotPath, metaPath };
}

/**
 * Read and validate a snapshot metadata header. An unknown schema version is
 * refused rather than mis-restored; a missing or malformed header rejects.
 */
export async function readWorktreeSnapshotMeta(
  metaPath: string,
): Promise<WorktreeSnapshotMeta> {
  const raw = await fs.readFile(metaPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Worktree snapshot meta at ${metaPath} is not an object`);
  }
  const v = parsed as Record<string, unknown>;
  if (v['version'] !== WORKTREE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported worktree snapshot version ${String(v['version'])} at ${metaPath}`,
    );
  }
  if (
    typeof v['sessionId'] !== 'string' ||
    typeof v['slug'] !== 'string' ||
    typeof v['baseCommit'] !== 'string' ||
    typeof v['headCommit'] !== 'string' ||
    typeof v['branch'] !== 'string' ||
    typeof v['createdAt'] !== 'number'
  ) {
    throw new Error(`Worktree snapshot meta at ${metaPath} is malformed`);
  }
  return parsed as WorktreeSnapshotMeta;
}

/**
 * Extract a snapshot over a freshly recreated worktree. The caller recreates
 * the worktree (detached at the recorded HEAD, or on the recorded branch)
 * first; this only lays the archived tree over it. Regenerable directories
 * were excluded at capture and are not restored.
 */
export async function restoreWorktreeSnapshot(
  snapshotPath: string,
  targetWorktreePath: string,
): Promise<void> {
  await fs.mkdir(targetWorktreePath, { recursive: true });
  await tar.extract({
    file: snapshotPath,
    cwd: targetWorktreePath,
  });
}
