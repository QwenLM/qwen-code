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
import { normalizeSessionIdForLookup } from '../../config/session-id.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  canonicalPathForTesting,
  preclassifyWorktreeCleanup,
} from './worktree-orphan-cleanup.js';
import {
  sessionLiveOnBridge,
  type SessionArchiveCoordinator,
} from './session-archive.js';
import type { WorktreeRestoreHandoff } from './session-restore.js';
import { acquireWorktreeOwnershipOp } from './worktree-ownership-op.js';
import { finishInterruptedSnapshotMove } from './worktree-snapshot-pairs.js';
import {
  assertNoConflictingWorktreeOwners,
  assertRestoreCoordinates,
  resolveManagedWorktreePath,
} from './worktree-snapshot-binding.js';

export function assertNotRetirementFenced(
  bridge: Partial<Pick<AcpSessionBridge, 'getSessionRetirement'>>,
  candidateIds: readonly string[],
): void {
  if (!bridge.getSessionRetirement) return;
  const ids = new Set<string>();
  for (const id of candidateIds) {
    ids.add(id);
    ids.add(normalizeSessionIdForLookup(id));
  }
  for (const id of ids) {
    if (bridge.getSessionRetirement(id)) {
      throw Object.assign(
        new Error('This native session is fenced for retirement'),
        { code: 'session_retirement_fenced' },
      );
    }
  }
}

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
  const validBranch = await runGit(sourceCwd, [
    ...NO_EXEC_CONFIG,
    'check-ref-format',
    '--branch',
    branch,
  ]).then(
    () => true,
    () => false,
  );
  if (!validBranch) return false;
  const resolved = await runGit(sourceCwd, [
    ...NO_EXEC_CONFIG,
    'rev-parse',
    '--verify',
    `refs/heads/${branch}^{commit}`,
  ]).catch(() => '');
  return resolved.trim() === head;
}

import { WorktreeRestoreUnavailableError } from './worktree-restore-errors.js';
export { WorktreeRestoreUnavailableError };

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
  /** Server-local transfer into the ordinary load that follows this restore. */
  handoffWorktreeOwnership?: (handoff: WorktreeRestoreHandoff) => void;
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
  // Pre-acquire both the missing-path raw key and the future resolved key in
  // global lexicographic order BEFORE taking the archive exclusive lock. This
  // matches withWorktreeArchiveMove's sorted lock order and eliminates ABBA
  // deadlocks across symlinked worktrees parents without changing the
  // raw-fallback lock key contract relied on by the reset route.
  const sortedLockKeys = [
    ...new Set([
      initial.lockKey,
      expected,
      resolveManagedWorktreePath(expected),
    ]),
  ].sort();
  const heldLockKeys = new Set<string>();
  const releases: Array<() => void> = [];
  const releaseAll = () => {
    for (let i = releases.length - 1; i >= 0; i--) {
      releases[i]!();
    }
  };
  let handedOff = false;
  let handoffKey = initial.lockKey;
  try {
    for (const key of sortedLockKeys) {
      releases.push(await acquireWorktreeOwnershipOp(key));
      heldLockKeys.add(key);
    }
    const task = archiveCoordinator.runExclusiveMany([sessionId], async () => {
      assertNotRetirementFenced(runtime.bridge, [sessionId]);
      const location = await service.getMaintainableSessionLocation(sessionId);
      if (location === 'archived') {
        throw new WorktreeRestoreUnavailableError(
          'Unarchive this session before restoring its worktree',
        );
      }
      if (location !== 'active') {
        throw new WorktreeRestoreUnavailableError(
          'Resolve active/archived session conflicts before restoring its worktree',
        );
      }
      const latest = await preclassifyWorktreeCleanup(
        service,
        sessionId,
        runtime.workspaceCwd,
      );
      if (
        !latest ||
        latest.sidecarPath !== service.getWorktreeSessionPath(sessionId)
      ) {
        throw new WorktreeRestoreUnavailableError(
          'Snapshot restoration state changed',
        );
      }
      await assertRestoreCoordinates(latest);
      await assertNoConflictingWorktreeOwners(
        service,
        sessionId,
        latest.sidecarPath,
        expected,
        (otherId) => sessionLiveOnBridge(runtime.bridge, otherId),
      );
      if (
        latest.sidecar.slug !== initial.sidecar.slug ||
        latest.sidecar.originalCwd !== initial.sidecar.originalCwd ||
        latest.sidecar.workspaceCwd !== initial.sidecar.workspaceCwd
      ) {
        throw new WorktreeRestoreUnavailableError(
          'Snapshot restoration ownership changed',
        );
      }
      if (
        latest.otherStateSidecarDir !== undefined &&
        latest.sidecar.worktreeRemoved !== undefined
      ) {
        await finishInterruptedSnapshotMove(
          latest.otherStateSidecarDir,
          path.dirname(latest.sidecarPath),
          sessionId,
          latest.sidecar.worktreeRemoved.archiveKey,
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
      try {
        await runGit(latest.sidecar.originalCwd, [
          ...NO_EXEC_CONFIG,
          'cat-file',
          '-e',
          `${selected.meta.headCommit}^{commit}`,
        ]);
      } catch {
        throw new WorktreeRestoreUnavailableError(
          'The snapshot base commit is no longer present in the repository',
        );
      }

      const existing = await stateAt(expected);
      let expectedBranch = '';
      if (existing) {
        if (!(await preservedMarkerMatches(sessionId, expected))) {
          throw new WorktreeRestoreUnavailableError(
            'The restore target does not have the exclusive session marker',
          );
        }
        if (!latest.sidecar.worktreeRemoved) {
          const canonicalKey = canonicalPathForTesting(expected);
          if (!heldLockKeys.has(canonicalKey)) {
            throw new WorktreeRestoreUnavailableError(
              'Restored worktree path changed while restoring',
            );
          }
          handoffKey = canonicalKey;
          return {
            session: latest.sidecar,
            branch: latest.sidecar.worktreeBranch,
            reconstructed: false,
          };
        }
        const current = await headAndBranch(expected);
        if (current.branch !== '' && current.branch !== selected.meta.branch) {
          throw new WorktreeRestoreUnavailableError(
            'Restored worktree branch does not match the selected snapshot',
          );
        }
        expectedBranch = current.branch;
        const firstExistingMatch = await verifyRestoredWorktreeSnapshot({
          worktreePath: expected,
          snapshotPath: selected.snapshotPath,
          meta: { ...selected.meta, branch: expectedBranch },
        });
        if (!firstExistingMatch) {
          throw new WorktreeRestoreUnavailableError(
            'Restored content does not match the selected snapshot',
          );
        }
      } else {
        const attach =
          latest.sidecar.worktreeRemoved !== undefined &&
          (await namedRefAtHead(
            latest.sidecar.originalCwd,
            selected.meta.branch,
            selected.meta.headCommit,
          ));
        assertNotRetirementFenced(runtime.bridge, [sessionId]);
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
        // Re-canonicalize `expected` now that the directory exists so a
        // symlinked parent matches the newly created realpath.
        const canDiscardCreatedCheckout =
          canonicalPathForTesting(created.worktree.path) ===
          canonicalPathForTesting(expected);
        let hasOwnershipMarker = false;
        try {
          let attachedBranch = false;
          if (
            attach &&
            (await namedRefAtHead(
              latest.sidecar.originalCwd,
              selected.meta.branch,
              selected.meta.headCommit,
            ))
          ) {
            attachedBranch = await source
              .checkoutBranchInCheckout(expected, selected.meta.branch, {
                noOverwriteIgnore: true,
              })
              .then(
                () => true,
                () => false,
              );
            if (attachedBranch) {
              const afterBranch = await headAndBranch(expected);
              if (
                afterBranch.head !== selected.meta.headCommit ||
                (afterBranch.branch !== '' &&
                  afterBranch.branch !== selected.meta.branch)
              ) {
                await runGit(expected, [
                  ...NO_EXEC_CONFIG,
                  'checkout',
                  '--detach',
                  selected.meta.headCommit,
                ]);
                attachedBranch = false;
              } else if (afterBranch.branch !== selected.meta.branch) {
                attachedBranch = false;
              }
            }
          }
          expectedBranch = attachedBranch ? selected.meta.branch : '';
          await restoreWorktreeSnapshot(
            selected.snapshotPath,
            expected,
            selected.meta,
          );
          // Verify restored content/HEAD before claiming the directory with
          // the exclusive marker so a first-pass mismatch cleanly rolls back
          // the newly created checkout instead of stranding retries.
          const firstCreatedMatch = await verifyRestoredWorktreeSnapshot({
            worktreePath: expected,
            snapshotPath: selected.snapshotPath,
            meta: { ...selected.meta, branch: expectedBranch },
          });
          if (!firstCreatedMatch) {
            throw new WorktreeRestoreUnavailableError(
              'Restored content does not match the selected snapshot',
            );
          }
          options.assertRuntimeGenerationOpen?.();
          assertNotRetirementFenced(runtime.bridge, [sessionId]);
          if (!(await preservedMarkerMatches(sessionId, expected))) {
            await createWorktreeSessionMarkerExclusive(expected, sessionId);
          }
          hasOwnershipMarker = true;
        } catch (error) {
          // Only an exactly identified new target may be rolled back. Once
          // ownership is established, the existing partial-restore verifier
          // must decide whether it can recover; this is not a general delete.
          if (canDiscardCreatedCheckout && !hasOwnershipMarker) {
            let markerMissing = false;
            try {
              markerMissing =
                (await readWorktreeSessionMarkerStrict(expected)).state ===
                'missing';
            } catch (markerError) {
              throw new AggregateError(
                [error, markerError],
                'Could not verify ownership before cleaning up the restore target',
              );
            }
            if (markerMissing) {
              try {
                await fs.rm(expected, { recursive: true, force: true });
                await runGit(latest.sidecar.originalCwd, [
                  ...NO_EXEC_CONFIG,
                  'worktree',
                  'prune',
                ]).catch(() => undefined);
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  'Could not clean up the newly created restore target',
                );
              }
            }
          }
          throw error;
        }
      }
      options.assertRuntimeGenerationOpen?.();
      const secondMatch = await verifyRestoredWorktreeSnapshot({
        worktreePath: expected,
        snapshotPath: selected.snapshotPath,
        meta: { ...selected.meta, branch: expectedBranch },
      });
      if (!secondMatch) {
        throw new WorktreeRestoreUnavailableError(
          'Restored content changed before binding',
        );
      }
      options.assertRuntimeGenerationOpen?.();
      assertNotRetirementFenced(runtime.bridge, [sessionId]);
      if (!(await preservedMarkerMatches(sessionId, expected))) {
        throw new WorktreeRestoreUnavailableError(
          'The restore target does not have the exclusive session marker',
        );
      }
      const canonicalKey = canonicalPathForTesting(expected);
      if (!heldLockKeys.has(canonicalKey)) {
        throw new WorktreeRestoreUnavailableError(
          'Restored worktree path changed while restoring',
        );
      }
      const session = {
        ...latest.sidecar,
        worktreePath: canonicalKey,
        worktreeBranch: expectedBranch,
      };
      delete session.worktreeRemoved;
      await writeWorktreeSession(latest.sidecarPath, session);
      const persisted = await readWorktreeSessionForBinding(latest.sidecarPath);
      if (
        !persisted ||
        persisted.worktreeBranch !== expectedBranch ||
        Boolean(persisted.worktreeRemoved)
      ) {
        throw new WorktreeRestoreUnavailableError(
          'Restored binding failed its final state check',
        );
      }
      handoffKey = canonicalKey;
      return { session, branch: expectedBranch, reconstructed: !existing };
    });
    const binding = await task;
    if (options.handoffWorktreeOwnership) {
      options.handoffWorktreeOwnership({
        worktreeKey: handoffKey,
        release: releaseAll,
      });
      handedOff = true;
    }
    return binding;
  } finally {
    if (!handedOff) {
      releaseAll();
    }
  }
}

async function readWorktreeSessionForBinding(
  filePath: string,
): Promise<WorktreeSession | undefined> {
  const result = await readWorktreeSessionStrict(filePath);
  if (result.state !== 'valid') return undefined;
  return result.session;
}
