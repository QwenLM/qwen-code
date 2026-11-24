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
  // Pass 1: restore every missing source alias before unlinking any
  // destination twin. If any source cannot be restored, stop before touching
  // destination entries so the destination retains both members and remaining
  // twins stay at nlink === 2 for finishInterruptedSnapshotMove to converge.
  for (const link of links.toReversed()) {
    try {
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
        continue;
      }
      const target = await fs.lstat(link.target, { bigint: true });
      if (target.dev !== link.dev || target.ino !== link.ino) {
        throw new Error(
          `Refusing to roll back a replaced snapshot link: ${link.target}`,
        );
      }
      // Restore the source alias before dropping the only other known
      // alias. link() also refuses a concurrently created source path.
      await fs.link(link.target, link.source);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    return errors;
  }
  // Pass 2: every source alias is verified intact; now drop destination twins.
  for (const link of links.toReversed()) {
    try {
      const target = await fs.lstat(link.target, { bigint: true });
      if (target.dev !== link.dev || target.ino !== link.ino) {
        throw new Error(
          `Refusing to roll back a replaced snapshot link: ${link.target}`,
        );
      }
      const source = await fs.lstat(link.source, { bigint: true });
      if (source.dev !== link.dev || source.ino !== link.ino) {
        throw new Error(
          `Refusing to roll back a replaced snapshot source: ${link.source}`,
        );
      }
      await fs.unlink(link.target);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function statOrNull(
  filePath: string,
): Promise<import('node:fs').BigIntStats | null> {
  try {
    return await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Completes an interrupted two-phase snapshot move left behind by a crash
 * between Phase 1 `fs.link` and Phase 2 `fs.unlink`. Only acts when at least
 * one pair member is an exact same-inode twin (`nlink === 2n`) across source
 * and destination and the other member is either also a twin, unmoved
 * (`nlink === 1n` in source only), or already moved (`nlink === 1n` in
 * destination only). Any foreign hardlink or conflicting destination file is
 * left untouched so downstream validation fails closed.
 */
export async function finishInterruptedSnapshotMove(
  sourceDirectory: string,
  destinationDirectory: string,
  sessionId: string,
  archiveKey: string,
): Promise<void> {
  if (
    archiveKey.includes('/') ||
    archiveKey.includes('\\') ||
    archiveKey.includes('..') ||
    !archiveKey.startsWith(`${sessionId}.`) ||
    !archiveKey.endsWith('.worktree-snapshot.tar.gz')
  ) {
    return;
  }
  const [srcDirLstat, dstDirLstat] = await Promise.all([
    statOrNull(sourceDirectory),
    statOrNull(destinationDirectory),
  ]);
  // Never follow a directory-level symlink at either endpoint (matches
  // selectWorktreeSnapshot's directory boundary), and skip if both paths
  // resolve to the same physical directory.
  if (
    !srcDirLstat?.isDirectory() ||
    !dstDirLstat?.isDirectory() ||
    (srcDirLstat.dev === dstDirLstat.dev && srcDirLstat.ino === dstDirLstat.ino)
  ) {
    return;
  }
  const metaName = `${archiveKey.slice(0, -'.tar.gz'.length)}.json`;
  const members = [archiveKey, metaName].map((name) => ({
    source: path.join(sourceDirectory, name),
    target: path.join(destinationDirectory, name),
  }));
  const states: Array<{
    source: string;
    target: string;
    kind: 'linked' | 'sourceOnly' | 'destOnly';
  }> = [];
  for (const member of members) {
    const src = await statOrNull(member.source);
    const dst = await statOrNull(member.target);
    if (
      src?.isFile() &&
      dst?.isFile() &&
      src.dev === dst.dev &&
      src.ino === dst.ino &&
      src.nlink === 2n
    ) {
      states.push({ ...member, kind: 'linked' });
    } else if (src?.isFile() && dst === null && src.nlink === 1n) {
      states.push({ ...member, kind: 'sourceOnly' });
    } else if (src === null && dst?.isFile() && dst.nlink === 1n) {
      states.push({ ...member, kind: 'destOnly' });
    } else {
      return;
    }
  }
  if (!states.some((entry) => entry.kind === 'linked')) {
    return;
  }
  const createdLinks: SnapshotLink[] = [];
  let phase1Complete = false;
  try {
    for (const entry of states) {
      if (entry.kind !== 'sourceOnly') continue;
      const sourceIdentity = await fs.lstat(entry.source, { bigint: true });
      await fs.link(entry.source, entry.target);
      const link: SnapshotLink = {
        source: entry.source,
        target: entry.target,
        dev: sourceIdentity.dev,
        ino: sourceIdentity.ino,
      };
      createdLinks.push(link);
      const targetIdentity = await fs.lstat(entry.target, { bigint: true });
      if (targetIdentity.dev !== link.dev || targetIdentity.ino !== link.ino) {
        const currentSource = await statOrNull(entry.source);
        if (
          currentSource?.isFile() &&
          currentSource.dev === targetIdentity.dev &&
          currentSource.ino === targetIdentity.ino &&
          targetIdentity.nlink === 2n
        ) {
          link.dev = targetIdentity.dev;
          link.ino = targetIdentity.ino;
        }
        throw new Error(`Snapshot source changed during move: ${entry.source}`);
      }
    }
    // Every pair member now exists in destinationDirectory. Do not roll back
    // createdLinks once source unlinks begin, otherwise a second-member unlink
    // error would unlink the new destination twin without restoring the already
    // unlinked first source member and permanently split the pair.
    phase1Complete = true;
    for (const entry of states) {
      if (entry.kind === 'destOnly') continue;
      await fs.unlink(entry.source);
    }
  } catch (error) {
    if (phase1Complete) {
      throw error;
    }
    const rollbackErrors = await rollbackSnapshotLinks(createdLinks);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Worktree snapshot move failed and rollback was incomplete',
      );
    }
    throw error;
  }
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
  const sourceDirectory = path.dirname(sourceSidecar);
  const destinationDirectory = path.dirname(destinationSidecar);
  await finishInterruptedSnapshotMove(
    sourceDirectory,
    destinationDirectory,
    sessionId,
    removal.archiveKey,
  );
  const selected = await selectWorktreeSnapshot({
    directory: sourceDirectory,
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
  const existingDestDir = await statOrNull(destinationDirectory);
  if (existingDestDir !== null && !existingDestDir.isDirectory()) {
    throw new Error(
      `Snapshot directory is not a real directory: ${destinationDirectory}`,
    );
  }
  await fs.mkdir(destinationDirectory, { recursive: true });
  const links: SnapshotLink[] = [];
  try {
    // Phase 1: hardlink every pair member into the destination before removing
    // any source entry, so a mid-move failure or crash never splits the pair
    // across source and destination directories.
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
        // If `source` was replaced between `lstat(source)` and `link(source,
        // target)`, `target` is a hardlink twin of the new source inode; record
        // that inode so rollback can safely unlink our twin instead of leaving
        // the replacement poisoned at nlink === 2.
        const currentSource = await statOrNull(source);
        if (
          currentSource?.isFile() &&
          currentSource.dev === targetIdentity.dev &&
          currentSource.ino === targetIdentity.ino &&
          targetIdentity.nlink === 2n
        ) {
          link.dev = targetIdentity.dev;
          link.ino = targetIdentity.ino;
        }
        throw new Error(`Snapshot source changed during move: ${source}`);
      }
    }
    // Phase 2: remove source aliases only after both destination entries exist.
    for (const link of links) {
      await fs.unlink(link.source);
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
