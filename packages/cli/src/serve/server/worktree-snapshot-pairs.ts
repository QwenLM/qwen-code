/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { selectWorktreeSnapshot } from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import { GitWorktreeService } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { readWorktreeSessionStrict } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import type {
  SessionService,
  SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import { canonicalPathForTesting } from './worktree-orphan-cleanup.js';
import { reconcileUnrecordedRemovedWorktree } from './worktree-snapshot-binding.js';

function otherState(state: SessionArchiveState): SessionArchiveState {
  return state === 'active' ? 'archived' : 'active';
}

interface SnapshotLink {
  source: string;
  target: string;
  dev: bigint;
  ino: bigint;
}

async function rollbackSnapshotLinks(
  links: SnapshotLink[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const link of links.toReversed()) {
    try {
      const target = await fs.lstat(link.target, { bigint: true });
      if (target.dev !== link.dev || target.ino !== link.ino) {
        throw new Error(
          `Refusing to roll back a replaced snapshot link: ${link.target}`,
        );
      }
      let source: { dev: bigint; ino: bigint } | undefined;
      try {
        source = await fs.lstat(link.source, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (source !== undefined) {
        if (source.dev !== link.dev || source.ino !== link.ino) {
          throw new Error(
            `Refusing to roll back a replaced snapshot source: ${link.source}`,
          );
        }
        await fs.unlink(link.target);
      } else {
        // Restore the source alias before dropping the only other known
        // alias. link() also refuses a concurrently created source path.
        await fs.link(link.target, link.source);
        await fs.unlink(link.target);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** Move an owned exact pair after reconciling any eligible historical binding. */
export async function moveWorktreeSnapshotsWithSession(
  service: SessionService,
  sessionId: string,
  destination: SessionArchiveState,
  isSessionLive?: (sessionId: string) => boolean,
): Promise<void> {
  const destinationSidecar = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    destination,
  );
  let record = await readWorktreeSessionStrict(destinationSidecar);
  // Arbitrary orphan files still carry no move authority. When the surviving
  // record lost its post-removal binding, first prove a unique exact pair on
  // either side of the same archive, then let the normal move protocol proceed.
  if (record.state !== 'valid') return;
  if (record.session.worktreeRemoved === undefined) {
    await reconcileUnrecordedRemovedWorktree(
      service,
      sessionId,
      destinationSidecar,
      canonicalPathForTesting(record.session.worktreePath),
      canonicalPathForTesting(
        new GitWorktreeService(
          record.session.originalCwd,
        ).getUserWorktreesDir(),
      ),
      isSessionLive,
    );
    record = await readWorktreeSessionStrict(destinationSidecar);
    if (record.state !== 'valid') return;
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
  if (!selected) {
    const alreadyMoved = await selectWorktreeSnapshot({
      directory: destinationDirectory,
      sessionId,
      slug: record.session.slug,
      archiveKey: removal.archiveKey,
    });
    if (alreadyMoved) return;
    throw new Error('The owned snapshot pair is missing');
  }
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
  const links: SnapshotLink[] = [];
  try {
    for (const source of [selected.snapshotPath, selected.metaPath]) {
      const target = path.join(destinationDirectory, path.basename(source));
      // link() cannot overwrite a destination created after the preflight.
      const sourceIdentity = await fs.lstat(source, { bigint: true });
      await fs.link(source, target);
      const link = {
        source,
        target,
        dev: sourceIdentity.dev,
        ino: sourceIdentity.ino,
      };
      // Register a successful attempt before a later identity probe can fail.
      links.push(link);
      const targetIdentity = await fs.lstat(target, { bigint: true });
      if (targetIdentity.dev !== link.dev || targetIdentity.ino !== link.ino) {
        throw new Error(`Snapshot source changed during move: ${source}`);
      }
      await fs.unlink(source);
    }
    const moved = await selectWorktreeSnapshot({
      directory: destinationDirectory,
      sessionId,
      slug: record.session.slug,
      archiveKey: removal.archiveKey,
    });
    const expectedTargets = new Set(
      [selected.snapshotPath, selected.metaPath].map((source) =>
        path.join(destinationDirectory, path.basename(source)),
      ),
    );
    if (
      !moved ||
      ![moved.snapshotPath, moved.metaPath].every((candidate) =>
        expectedTargets.has(candidate),
      )
    ) {
      throw new Error('The moved snapshot pair is unavailable');
    }
  } catch (error) {
    const rollbackErrors = await rollbackSnapshotLinks(links);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Worktree snapshot move failed and rollback was incomplete',
      );
    }
    throw error;
  }
}
