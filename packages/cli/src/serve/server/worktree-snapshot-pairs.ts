/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { selectWorktreeSnapshot } from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import { readWorktreeSessionStrict } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import type {
  SessionService,
  SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import { canonicalPathForTesting } from './worktree-orphan-cleanup.js';

function otherState(state: SessionArchiveState): SessionArchiveState {
  return state === 'active' ? 'archived' : 'active';
}

/** Move only the exact pair owned by a strict surviving removed-state binding. */
export async function moveWorktreeSnapshotsWithSession(
  service: SessionService,
  sessionId: string,
  destination: SessionArchiveState,
): Promise<void> {
  const destinationSidecar = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    destination,
  );
  const record = await readWorktreeSessionStrict(destinationSidecar);
  // Ordinary sessions have no snapshot pair associated with their sidecar.
  if (record.state === 'missing') return;
  if (record.state !== 'valid') {
    throw new Error(
      `Cannot read the worktree sidecar after archive: ${record.state}`,
    );
  }
  const removal = record.session.worktreeRemoved;
  if (!removal) return;
  if (
    record.session.workspaceCwd === undefined ||
    canonicalPathForTesting(record.session.workspaceCwd) !==
      canonicalPathForTesting(service.getProjectRoot())
  ) {
    throw new Error(
      'Cannot verify the workspace owner of the archived snapshot',
    );
  }
  const sourceSidecar = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    otherState(destination),
  );
  if (sourceSidecar === destinationSidecar) return;
  const destinationDirectory = path.dirname(destinationSidecar);
  const selected = await selectWorktreeSnapshot({
    directory: path.dirname(sourceSidecar),
    sessionId,
    slug: record.session.slug,
    archiveKey: removal.archiveKey,
  });
  if (!selected) throw new Error('The owned snapshot pair is missing');
  for (const source of [selected.snapshotPath, selected.metaPath]) {
    const target = path.join(destinationDirectory, path.basename(source));
    if (
      await fs.lstat(target).then(
        () => true,
        (error: NodeJS.ErrnoException) =>
          error.code === 'ENOENT' ? false : Promise.reject(error),
      )
    ) {
      throw new Error(
        `Cannot replace an existing archived snapshot: ${target}`,
      );
    }
  }
  await fs.mkdir(destinationDirectory, { recursive: true });
  for (const source of [selected.snapshotPath, selected.metaPath]) {
    const target = path.join(destinationDirectory, path.basename(source));
    // A link neither duplicates bytes nor overwrites a destination created
    // concurrently. If unlink fails, both safely linked copies are retained.
    await fs.link(source, target);
    await fs.unlink(source);
  }
  await selectWorktreeSnapshot({
    directory: destinationDirectory,
    sessionId,
    slug: record.session.slug,
    archiveKey: removal.archiveKey,
  });
}
