/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createWorktreeSessionMarkerExclusive,
  GitWorktreeService,
  readWorktreeSessionMarkerStrict,
} from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import {
  readWorktreeSessionStrict,
  writeWorktreeSession,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import {
  restoreWorktreeSnapshot,
  selectWorktreeSnapshot,
  verifyRestoredWorktreeSnapshot,
} from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import { runGit } from '@qwen-code/qwen-code-core/utils/git-branches.js';
import { NO_EXEC_CONFIG } from '@qwen-code/qwen-code-core/utils/gitUtils.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  acquireWorktreeCleanupLock,
  canonicalPathForTesting,
  preclassifyWorktreeCleanup,
  worktreeAllowedRoots,
  type WorktreeCleanupPlan,
} from './worktree-orphan-cleanup.js';
import type { SessionArchiveCoordinator } from './session-archive.js';

async function stateAt(directory: string): Promise<string | null> {
  try {
    return (await fs.lstat(directory)).isDirectory() ? directory : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function headAndBranch(
  directory: string,
): Promise<{ head: string; branch: string }> {
  const [head, branch] = await Promise.all([
    runGit(directory, [...NO_EXEC_CONFIG, 'rev-parse', 'HEAD']),
    runGit(directory, [...NO_EXEC_CONFIG, 'branch', '--show-current']),
  ]);
  return { head: head.trim(), branch: branch.trim() };
}

async function assertRestoreCoordinates(
  plan: WorktreeCleanupPlan,
): Promise<void> {
  if (plan.sidecar.workspaceCwd === undefined) {
    throw new WorktreeRestoreUnavailableError(
      'Snapshot restore requires a registered workspace owner',
    );
  }
  const source = new GitWorktreeService(plan.sidecar.originalCwd);
  const expected = canonicalPathForTesting(
    source.getUserWorktreePath(plan.sidecar.slug),
  );
  if (expected !== canonicalPathForTesting(plan.sidecar.worktreePath)) {
    throw new WorktreeRestoreUnavailableError(
      'Snapshot restore path does not match the managed slug',
    );
  }
  const managedRoot = canonicalPathForTesting(source.getUserWorktreesDir());
  const allowed = await worktreeAllowedRoots(
    plan.sidecar.workspaceCwd,
    plan.sidecar.originalCwd,
  );
  if (
    !allowed.some(
      (root) =>
        canonicalPathForTesting(root) === canonicalPathForTesting(managedRoot),
    )
  ) {
    throw new WorktreeRestoreUnavailableError(
      'Snapshot restore is outside the workspace managed roots',
    );
  }
  if (GitWorktreeService.validateUserWorktreeSlug(plan.sidecar.slug)) {
    throw new WorktreeRestoreUnavailableError(
      'Snapshot restore slug is invalid',
    );
  }
}

async function preservedMarkerMatches(
  sessionId: string,
  directory: string,
): Promise<boolean> {
  const marker = await readWorktreeSessionMarkerStrict(directory);
  return marker.state === 'valid' && marker.sessionId === sessionId;
}

async function namedRefAtHead(
  sourceCwd: string,
  branch: string,
  head: string,
): Promise<boolean> {
  if (!branch) return false;
  const resolved = await runGit(sourceCwd, [
    ...NO_EXEC_CONFIG,
    'rev-parse',
    '--verify',
    `refs/heads/${branch}^{commit}`,
  ]).catch(() => '');
  return resolved.trim() === head;
}

export class WorktreeRestoreUnavailableError extends Error {
  readonly code = 'worktree_restore_unavailable';
  override readonly name = 'WorktreeRestoreUnavailableError';
}

export interface RestoredWorktreeBinding {
  session: WorktreeSession;
  branch: string;
  reconstructed: boolean;
}

export async function restoreWorktreeFromSessionSnapshot(options: {
  runtime: WorkspaceRuntime;
  sessionId: string;
  archiveCoordinator: SessionArchiveCoordinator;
  assertRuntimeGenerationOpen?: () => void;
  /** True only for an explicit registered owner supplied by the caller. */
  explicitWorkspaceCwd?: boolean;
}): Promise<RestoredWorktreeBinding> {
  const { runtime, sessionId, archiveCoordinator } = options;
  if (!runtime.primary && options.explicitWorkspaceCwd !== true) {
    throw new WorktreeRestoreUnavailableError(
      'Non-primary snapshot restore requires an explicit registered workspace owner',
    );
  }
  const service = createWorkspaceRuntimeSessionService(runtime);
  const initial = await preclassifyWorktreeCleanup(
    service,
    sessionId,
    runtime.workspaceCwd,
  );
  if (!initial)
    throw new WorktreeRestoreUnavailableError(
      'No owned snapshot restoration candidate',
    );
  await assertRestoreCoordinates(initial);
  const source = new GitWorktreeService(initial.sidecar.originalCwd);
  const expected = canonicalPathForTesting(
    source.getUserWorktreePath(initial.sidecar.slug),
  );
  // A missing checkout intentionally uses the raw managed-path lock key.
  const release = await acquireWorktreeCleanupLock(initial);
  try {
    return await archiveCoordinator.runExclusiveMany([sessionId], async () => {
      const latest = await preclassifyWorktreeCleanup(
        service,
        sessionId,
        runtime.workspaceCwd,
      );
      if (!latest)
        throw new WorktreeRestoreUnavailableError(
          'Snapshot restoration state changed',
        );
      await assertRestoreCoordinates(latest);
      if (
        latest.sidecar.slug !== initial.sidecar.slug ||
        latest.sidecar.originalCwd !== initial.sidecar.originalCwd ||
        latest.sidecar.workspaceCwd !== initial.sidecar.workspaceCwd
      ) {
        throw new WorktreeRestoreUnavailableError(
          'Snapshot restoration ownership changed',
        );
      }
      const selected = await selectWorktreeSnapshot({
        directory: path.dirname(latest.sidecarPath),
        sessionId,
        slug: latest.sidecar.slug,
        ...(latest.sidecar.worktreeRemoved
          ? { archiveKey: latest.sidecar.worktreeRemoved.archiveKey }
          : {}),
      });
      if (!selected) {
        throw new WorktreeRestoreUnavailableError(
          'The snapshot pair for this session is unavailable',
        );
      }
      const objectFormat = (
        await runGit(latest.sidecar.originalCwd, [
          ...NO_EXEC_CONFIG,
          'rev-parse',
          '--show-object-format',
        ])
      ).trim();
      const hexLength =
        objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
      if (
        hexLength === 0 ||
        !new RegExp(`^[0-9a-f]{${hexLength}}$`).test(selected.meta.headCommit)
      ) {
        throw new WorktreeRestoreUnavailableError(
          'Snapshot head is not a full object id for this repository',
        );
      }
      await runGit(latest.sidecar.originalCwd, [
        ...NO_EXEC_CONFIG,
        'cat-file',
        '-e',
        `${selected.meta.headCommit}^{commit}`,
      ]);

      const existing = await stateAt(expected);
      if (existing) {
        if (!(await preservedMarkerMatches(sessionId, expected))) {
          throw new WorktreeRestoreUnavailableError(
            'The restore target does not have the exclusive session marker',
          );
        }
        if (!latest.sidecar.worktreeRemoved) {
          return {
            session: latest.sidecar,
            branch: latest.sidecar.worktreeBranch,
            reconstructed: false,
          };
        }
      } else {
        const attach =
          latest.sidecar.worktreeRemoved !== undefined &&
          (await namedRefAtHead(
            latest.sidecar.originalCwd,
            selected.meta.branch,
            selected.meta.headCommit,
          ));
        const created = await source.createUserWorktree(
          latest.sidecar.slug,
          selected.meta.headCommit,
          { detached: true },
        );
        if (!created.success || !created.worktree) {
          throw new WorktreeRestoreUnavailableError(
            created.error ?? 'Could not create the restore target',
          );
        }
        // The ref is attached only at the unchanged captured commit. It is
        // never reset, and a moved/inaccessible ref leaves a detached HEAD.
        if (
          attach &&
          (await namedRefAtHead(
            latest.sidecar.originalCwd,
            selected.meta.branch,
            selected.meta.headCommit,
          ))
        ) {
          await source
            .checkoutBranchInCheckout(expected, selected.meta.branch, {
              noOverwriteIgnore: true,
            })
            .catch(() => undefined);
        }
        await restoreWorktreeSnapshot(
          selected.snapshotPath,
          expected,
          selected.meta,
        );
      }
      options.assertRuntimeGenerationOpen?.();
      if (!(await preservedMarkerMatches(sessionId, expected))) {
        if (existing) {
          throw new WorktreeRestoreUnavailableError(
            'The retained target changed during restoration',
          );
        }
        await createWorktreeSessionMarkerExclusive(expected, sessionId);
      }
      let actual = await headAndBranch(expected);
      const matching = async () =>
        verifyRestoredWorktreeSnapshot({
          worktreePath: expected,
          snapshotPath: selected.snapshotPath,
          meta: { ...selected.meta, branch: actual.branch },
        });
      if (!(await matching())) {
        throw new WorktreeRestoreUnavailableError(
          'Restored content does not match the selected snapshot',
        );
      }
      options.assertRuntimeGenerationOpen?.();
      actual = await headAndBranch(expected);
      if (!(await matching())) {
        throw new WorktreeRestoreUnavailableError(
          'Restored content changed before binding',
        );
      }
      const session = {
        ...latest.sidecar,
        worktreePath: expected,
        worktreeBranch: actual.branch,
      };
      delete session.worktreeRemoved;
      await writeWorktreeSession(latest.sidecarPath, session);
      const persisted = await readWorktreeSessionForBinding(latest.sidecarPath);
      if (
        !persisted ||
        persisted.worktreeBranch !== actual.branch ||
        Boolean(persisted.worktreeRemoved)
      ) {
        throw new WorktreeRestoreUnavailableError(
          'Restored binding failed its final state check',
        );
      }
      return { session, branch: actual.branch, reconstructed: !existing };
    });
  } finally {
    release();
  }
}

async function readWorktreeSessionForBinding(
  filePath: string,
): Promise<WorktreeSession | undefined> {
  const result = await readWorktreeSessionStrict(filePath);
  if (result.state !== 'valid') return undefined;
  return result.session;
}
