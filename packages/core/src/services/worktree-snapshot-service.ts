/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worktree snapshot capture/restore (P6, design D7). A snapshot is a
 * self-contained `tar.gz` of a managed worktree's tree plus a JSON metadata
 * header, saved before the worktree is deleted so the work survives cleanup
 * and can be restored when the chat is reopened. Only regenerable output the
 * has-work gate actually waives — ignored `node_modules`/`dist`/`coverage`
 * trees — plus the `.git` link and the session marker are excluded; tracked
 * or non-ignored files under those directory names are work and are
 * archived. Uncommitted tracked deletions are recorded in the header and
 * re-applied on restore, so a deleted file is not resurrected by extraction
 * over a recreated HEAD.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as tar from 'tar';
import {
  WORKTREE_SESSION_FILE,
  isDisposableIgnoredEntry,
} from './gitWorktreeService.js';
import { runGit } from '../utils/git-branches.js';
import { NO_EXEC_CONFIG } from '../utils/gitUtils.js';

export const WORKTREE_SNAPSHOT_SCHEMA_VERSION = 2;

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
  dirty: {
    tracked: number;
    untracked: number;
    /**
     * Repo-relative tracked paths absent from the working tree at capture
     * (unstaged or staged deletions, and rename sources). Restore removes
     * them after extraction so the deletion survives; the archive alone
     * cannot represent an absent file.
     */
    deleted: string[];
  };
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
 * A repo-relative path safe to join under a worktree root: relative, no
 * `..` segment, no drive/leading separator. The header is validated input
 * to a destructive restore step, so a traversal path is refused.
 */
function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || path.isAbsolute(p)) return false;
  return !p.split('/').some((segment) => segment === '..' || segment === '');
}

/**
 * Whether a worktree-relative path is excluded from the snapshot. `.git`
 * (the worktree link file or a real dir) and the session marker are always
 * excluded. A regenerable directory segment is excluded only when git
 * reports the path ignored — the same geometry the has-work gate waives —
 * so a tracked or non-ignored file under `dist/` (or `node_modules/`,
 * `coverage/`) is archived rather than silently dropped.
 */
function isExcludedFromSnapshot(
  relativePath: string,
  ignored: ReadonlySet<string>,
): boolean {
  const norm = relativePath.replace(/^\.\//, '').replace(/\/$/, '');
  if (norm.length === 0) return false;
  if (norm === '.git' || norm.startsWith('.git/')) return true;
  if (norm === WORKTREE_SESSION_FILE) return true;
  return isDisposableIgnoredEntry(norm) && ignored.has(norm);
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
 * Read the worktree's HEAD and dirty-state summary to build a snapshot meta
 * header (P6 U3). The session marker is excluded from the counts (it is
 * daemon bookkeeping, not work, and is excluded from the archive too).
 * Tracked deletions and rename sources are recorded so restore can re-apply
 * them. Rejects if the worktree's own `.git` is missing or its git state
 * cannot be read — the caller must not snapshot-and-delete a worktree it
 * cannot describe, and git's upward discovery from a worktree whose own
 * `.git` is gone would otherwise answer about the enclosing repository.
 */
export async function buildWorktreeSnapshotMeta(
  worktreePath: string,
  info: {
    sessionId: string;
    slug: string;
    baseCommit: string;
    branch: string;
  },
): Promise<Omit<WorktreeSnapshotMeta, 'version' | 'createdAt'>> {
  await fs.access(path.join(worktreePath, '.git'));
  const headCommit = (
    await runGit(worktreePath, [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'rev-parse',
      'HEAD',
    ])
  ).trim();
  const status = await runGit(worktreePath, [
    ...NO_EXEC_CONFIG,
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '-z',
  ]);
  let tracked = 0;
  let untracked = 0;
  const deleted: string[] = [];
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length === 0) continue;
    const xy = record.slice(0, 2);
    const entry = record.slice(3);
    // A rename/copy record is followed by a second NUL-separated record
    // naming the source path. A rename deletes the source; a copy keeps it.
    if (xy[0] === 'R' || xy[0] === 'C') {
      const source = records[i + 1] ?? '';
      i += 1;
      if (entry === WORKTREE_SESSION_FILE) continue;
      tracked += 1;
      if (xy[0] === 'R' && source.length > 0) deleted.push(source);
      continue;
    }
    if (entry === WORKTREE_SESSION_FILE) continue;
    if (xy === '??') {
      untracked += 1;
      continue;
    }
    tracked += 1;
    if (xy[0] === 'D' || xy[1] === 'D') deleted.push(entry);
  }
  // git output is decoded as UTF-8; a non-UTF-8 filename arrives as U+FFFD
  // and could not be re-applied by name on restore. Refuse the capture (the
  // caller preserves the checkout) rather than record a deletion that would
  // silently fail to restore.
  if (deleted.some((p) => p.includes('\uFFFD'))) {
    throw new Error(
      'Worktree snapshot meta: a deleted path is not valid UTF-8; cannot restore it faithfully',
    );
  }
  return { ...info, headCommit, dirty: { tracked, untracked, deleted } };
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
  await fs.access(path.join(worktreePath, '.git'));
  // The ignored set the exclusion geometry consults: file-level, so a
  // tracked or non-ignored file under a regenerable directory name is not
  // mistaken for disposable output.
  const ignoredOut = await runGit(worktreePath, [
    ...NO_EXEC_CONFIG,
    '--no-optional-locks',
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
  ]);
  const ignored = new Set(ignoredOut.split('\0').filter((p) => p.length > 0));
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
        filter: (p) => !isExcludedFromSnapshot(p, ignored),
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
 * Version 1 headers (no recorded deletions) are refused: they cannot
 * faithfully restore a tracked deletion.
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
  const dirty = v['dirty'];
  if (dirty === null || typeof dirty !== 'object') {
    throw new Error(`Worktree snapshot meta at ${metaPath} is malformed`);
  }
  const d = dirty as Record<string, unknown>;
  if (
    typeof d['tracked'] !== 'number' ||
    typeof d['untracked'] !== 'number' ||
    !Array.isArray(d['deleted']) ||
    !d['deleted'].every((p) => typeof p === 'string' && isSafeRelativePath(p))
  ) {
    throw new Error(`Worktree snapshot meta at ${metaPath} is malformed`);
  }
  return parsed as WorktreeSnapshotMeta;
}

/**
 * Extract a snapshot over a freshly recreated worktree and re-apply the
 * recorded tracked deletions, without losing any archived content. The caller
 * recreates the worktree (detached at the recorded HEAD, or on the recorded
 * branch) first. Three steps, in order:
 *
 * 1. Clear a conflicting HEAD target for every archived non-directory entry:
 *    node-tar replaces a file with a directory but not a directory with a
 *    file, so a dir→file replacement would otherwise silently drop the
 *    archived file.
 * 2. Re-apply the *pure* deletions (paths absent from the archive) before
 *    extraction, so a deleted tracked file is not resurrected from HEAD. A
 *    deleted path the session recreated (present in the archive) is left for
 *    extraction to restore — removing it would delete the session's new
 *    content. A deleted path that became a directory holds archived content
 *    and is likewise left alone.
 * 3. Extract with `strict`, so any residual conflict fails loudly rather than
 *    silently dropping content.
 *
 * Regenerable directories were excluded at capture and are not restored.
 * Index state (staged vs unstaged) is not preserved — the contract is that no
 * file content is lost.
 */
export async function restoreWorktreeSnapshot(
  snapshotPath: string,
  targetWorktreePath: string,
  meta: WorktreeSnapshotMeta,
): Promise<void> {
  await fs.mkdir(targetWorktreePath, { recursive: true });
  const root = path.resolve(targetWorktreePath);
  const archived = new Map<string, string>();
  await tar.t({
    file: snapshotPath,
    onReadEntry: (entry) => {
      const norm = entry.path.replace(/^\.\//, '').replace(/\/$/, '');
      if (norm.length > 0) archived.set(norm, entry.type);
    },
  });
  const confine = (rel: string): string => {
    if (!isSafeRelativePath(rel)) {
      throw new Error(`Unsafe path in snapshot meta: ${rel}`);
    }
    if (
      rel === '.git' ||
      rel.startsWith('.git/') ||
      rel === WORKTREE_SESSION_FILE
    ) {
      throw new Error(`Snapshot meta names a protected path: ${rel}`);
    }
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Snapshot path escapes worktree root: ${rel}`);
    }
    return target;
  };
  for (const [rel, type] of archived) {
    if (type === 'Directory') continue;
    const target = confine(rel);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  for (const rel of meta.dirty.deleted) {
    const target = confine(rel);
    const norm = rel.replace(/^\.\//, '').replace(/\/$/, '');
    if (archived.has(norm)) continue;
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isDirectory()) continue;
    await fs.rm(target, { force: true, recursive: true });
  }
  await tar.extract({
    file: snapshotPath,
    cwd: targetWorktreePath,
    strict: true,
  });
}
