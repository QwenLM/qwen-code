/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GitWorktreeService } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { selectWorktreeSnapshot } from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import {
  readWorktreeSessionStrict,
  writeWorktreeSession,
} from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import type { SessionService } from '@qwen-code/qwen-code-core';
import {
  preclassifyWorktreeCleanup,
  type WorktreeCleanupPlan,
} from './worktree-orphan-cleanup.js';
import { WorktreeRestoreUnavailableError } from './worktree-restore-errors.js';

/**
 * Resolves a managed worktree path consistently before and after checkout
 * removal: resolves existing paths via `fs.realpathSync`, and when the leaf is
 * absent (`ENOENT`) resolves the nearest existing ancestor so a symlinked
 * `.qwen/worktrees` parent yields the same coordinate before and after removal.
 * Used for coordinate/owner matching and pre-locking, never to replace the
 * raw-fallback ownership lock key the reset route depends on.
 */
export function resolveManagedWorktreePath(candidate: string): string {
  if (candidate.length === 0) return candidate;
  const resolved = path.resolve(candidate);
  try {
    return fsSync.realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return resolved;
    }
  }
  const trailing: string[] = [];
  let current = resolved;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    trailing.push(path.basename(current));
    current = parent;
    try {
      const realAncestor = fsSync.realpathSync(current);
      return path.join(realAncestor, ...trailing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return resolved;
      }
    }
  }
}

export async function assertRestoreCoordinates(
  plan: WorktreeCleanupPlan,
): Promise<void> {
  if (plan.sidecar.workspaceCwd === undefined) {
    throw new WorktreeRestoreUnavailableError(
      'Snapshot restore requires a registered workspace owner',
    );
  }
  const source = new GitWorktreeService(plan.sidecar.originalCwd);
  const expected = resolveManagedWorktreePath(
    source.getUserWorktreePath(plan.sidecar.slug),
  );
  if (expected !== resolveManagedWorktreePath(plan.sidecar.worktreePath)) {
    throw new WorktreeRestoreUnavailableError(
      'Snapshot restore path does not match the managed slug',
    );
  }
  if (GitWorktreeService.validateUserWorktreeSlug(plan.sidecar.slug)) {
    throw new WorktreeRestoreUnavailableError(
      'Snapshot restore slug is invalid',
    );
  }
}

export async function assertNoConflictingWorktreeOwners(
  service: SessionService,
  sessionId: string,
  sidecarPath: string,
  expected: string,
  isSessionLive: (sessionId: string) => boolean,
): Promise<void> {
  const expectedResolved = resolveManagedWorktreePath(expected);
  const olderTombstones: string[] = [];
  for (const state of ['active', 'archived'] as const) {
    const directory = path.dirname(
      service.getWorktreeSessionPathForArchiveState('', state),
    );
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.worktree.json')) continue;
      const filePath = path.join(directory, entry);
      if (filePath === sidecarPath) continue;
      const other = await readWorktreeSessionStrict(filePath);
      if (other.state === 'missing') continue;
      if (other.state !== 'valid') {
        throw new WorktreeRestoreUnavailableError(
          'Other worktree records have become unavailable',
        );
      }
      if (
        resolveManagedWorktreePath(other.session.worktreePath) !==
        expectedResolved
      ) {
        continue;
      }
      if (other.session.supersededBy === sessionId) continue;
      if (other.session.supersededBy !== undefined) {
        olderTombstones.push(entry.slice(0, -'.worktree.json'.length));
        continue;
      }
      throw new WorktreeRestoreUnavailableError(
        'The restore target is claimed by another session',
      );
    }
  }
  for (const otherId of olderTombstones) {
    if (isSessionLive(otherId)) {
      throw new WorktreeRestoreUnavailableError(
        'An older session still claims the restore target',
      );
    }
  }
}

export async function reconcileUnrecordedRemovedWorktree(
  service: SessionService,
  sessionId: string,
  sidecarPath: string,
  expectedWorktreePath: string,
  expectedManagedRoot: string | undefined,
  // Archive callers may lack a live registry: unknown ownership stays preserved.
  isSessionLive: (sessionId: string) => boolean = () => true,
): Promise<boolean> {
  const latest = await preclassifyWorktreeCleanup(
    service,
    sessionId,
    service.getProjectRoot(),
  );
  if (
    !latest ||
    latest.sidecarPath !== sidecarPath ||
    resolveManagedWorktreePath(latest.lockKey) !==
      resolveManagedWorktreePath(expectedWorktreePath) ||
    latest.sidecar.worktreeRemoved !== undefined ||
    (expectedManagedRoot === undefined
      ? true
      : resolveManagedWorktreePath(
          new GitWorktreeService(
            latest.sidecar.originalCwd,
          ).getUserWorktreesDir(),
        ) !== resolveManagedWorktreePath(expectedManagedRoot))
  ) {
    return false;
  }
  try {
    await fs.lstat(latest.lockKey);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const directories = new Set([path.dirname(latest.sidecarPath)]);
  if (latest.otherStateSidecarDir !== undefined) {
    directories.add(latest.otherStateSidecarDir);
  }
  const candidates: Array<
    NonNullable<Awaited<ReturnType<typeof selectWorktreeSnapshot>>>
  > = [];
  for (const directory of directories) {
    // The other archive-state directory may legitimately be absent. Other
    // errors stay fail-closed rather than authorizing a different pair.
    const directoryExists = await fs.lstat(directory).then(
      () => true,
      (error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? false : Promise.reject(error),
    );
    if (!directoryExists) continue;
    const selected = await selectWorktreeSnapshot({
      directory,
      sessionId,
      slug: latest.sidecar.slug,
    });
    if (selected) candidates.push(selected);
  }
  if (candidates.length === 0) return false;
  if (candidates.length !== 1) {
    throw new WorktreeRestoreUnavailableError(
      'Historical retained snapshot pairs are ambiguous across archive states',
    );
  }
  await assertRestoreCoordinates(latest);
  await assertNoConflictingWorktreeOwners(
    service,
    sessionId,
    latest.sidecarPath,
    latest.lockKey,
    isSessionLive,
  );
  // Re-check after the ownership/pair scans: an appearing directory is not
  // the already-removed checkout this historical repair is allowed to bind.
  try {
    await fs.lstat(latest.lockKey);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const archiveKey = path.basename(candidates[0]!.snapshotPath);
  await writeWorktreeSession(latest.sidecarPath, {
    ...latest.sidecar,
    worktreeRemoved: { archiveKey },
  });
  const persisted = await readWorktreeSessionStrict(latest.sidecarPath);
  return (
    persisted.state === 'valid' &&
    persisted.session.worktreeRemoved?.archiveKey === archiveKey
  );
}
