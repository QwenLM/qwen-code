/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {
  GitWorktreeService,
  hasTrackedChanges,
  readWorktreeSessionMarkerStrict,
  readWorktreeSessionStrict,
  type SessionService,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import { acquireWorktreeOwnershipOp } from './worktree-ownership-op.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { safeLogValue } from './request-helpers.js';

/**
 * Ownership-verified worktree cleanup for the delete path (#11024).
 *
 * `deleteDaemonSessions` removes the persisted record AND the sidecar
 * (the ownership evidence), so cleanup classification must happen before
 * the record is deleted and execution after the deletion is confirmed.
 * Every step fails closed: any doubt preserves the checkout and logs a
 * named warning; the session record deletion itself is never blocked.
 */

export interface WorktreeCleanupPlan {
  sessionId: string;
  sidecar: WorktreeSession;
  sidecarPath: string;
  /** Canonical worktree path: realpath when resolvable, raw otherwise. */
  lockKey: string;
}

function canonicalPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function logWarning(message: string): void {
  writeStderrLine(`qwen serve: ${message}`);
}

export function logWorktreeCleanupPreserve(
  sessionId: string,
  reason: string,
): void {
  logWarning(
    `worktree cleanup preserved checkout action=delete session=${safeLogValue(
      sessionId,
    )} reason=${safeLogValue(reason)}`,
  );
}

/**
 * Advisory pre-read of the session's sidecar (no locks held). Returns a
 * cleanup plan only for a daemon-route-owned worktree session
 * (strict-valid sidecar with `workspaceCwd`). A `supersededBy` link
 * marks the expected post-reset state — the checkout belongs to the
 * replacement now — and skips silently so preserve-and-log keeps its
 * meaning. A `supersedes` link means this session IS the current owner
 * (it took the checkout from a predecessor), so it stays cleanable;
 * the predecessor's tombstone sidecar is discounted by the sharing
 * scan instead.
 */
export async function preclassifyWorktreeCleanup(
  service: SessionService,
  sessionId: string,
): Promise<WorktreeCleanupPlan | undefined> {
  // The delete path covers active and archived records alike, and the
  // sidecar moves with the record — check the active location first.
  let sidecarPath = service.getWorktreeSessionPath(sessionId);
  let sidecar = await readWorktreeSessionStrict(sidecarPath);
  if (sidecar.state === 'missing') {
    const archivedPath = service.getWorktreeSessionPathForArchiveState(
      sessionId,
      'archived',
    );
    if (archivedPath !== sidecarPath) {
      sidecarPath = archivedPath;
      sidecar = await readWorktreeSessionStrict(sidecarPath);
    }
  }
  if (sidecar.state === 'missing') return undefined;
  if (sidecar.state === 'invalid') {
    logWorktreeCleanupPreserve(
      sessionId,
      `unreadable sidecar (${sidecar.reason})`,
    );
    return undefined;
  }
  const session = sidecar.session;
  if (session.workspaceCwd === undefined) return undefined;
  if (session.supersededBy !== undefined) return undefined;
  return {
    sessionId,
    sidecar: session,
    sidecarPath,
    lockKey: canonicalPath(session.worktreePath),
  };
}

/** Serialize one session's delete + cleanup with restores and resets. */
export function acquireWorktreeCleanupLock(
  plan: WorktreeCleanupPlan,
): Promise<() => void> {
  return acquireWorktreeOwnershipOp(plan.lockKey);
}

async function worktreeAllowedRoots(
  workspaceCwd: string,
  originalCwd: string,
): Promise<string[]> {
  const roots = new Set<string>();
  for (const base of [workspaceCwd, originalCwd]) {
    roots.add(path.join(base, '.qwen', 'worktrees'));
    try {
      const repoTop = await new GitWorktreeService(base).getRepoTopLevel();
      if (repoTop) {
        roots.add(path.join(repoTop, '.qwen', 'worktrees'));
      }
    } catch {
      // Not a git repo from this base — its own root still counts.
    }
  }
  return [...roots];
}

/**
 * Full ownership verification, called under the cleanup lock before the
 * record is deleted. The sidecar is re-read because the pre-read was
 * advisory; the marker must name exactly this session; the checkout
 * must resolve under the workspace worktree roots; and no other
 * session's sidecar may name the same checkout (a freshly transferred
 * replacement satisfies the naive ownership bar during exactly the
 * window the superseded redirect exists to heal).
 */
export async function verifyWorktreeCleanupOwnership(
  plan: WorktreeCleanupPlan,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { sessionId, sidecar } = plan;
  const locked = await readWorktreeSessionStrict(plan.sidecarPath);
  if (locked.state !== 'valid') {
    return {
      ok: false,
      reason:
        locked.state === 'missing'
          ? 'sidecar disappeared before delete'
          : `unreadable sidecar (${locked.reason})`,
    };
  }
  const current = locked.session;
  if (
    current.workspaceCwd === undefined ||
    current.supersededBy !== undefined ||
    current.slug !== sidecar.slug ||
    current.worktreePath !== sidecar.worktreePath
  ) {
    // A `supersededBy` link appearing here means the session was
    // superseded between the advisory read and the lock — its checkout
    // ownership moved away mid-flight, so there is nothing to clean.
    return { ok: false, reason: 'sidecar changed before delete' };
  }
  const marker = await readWorktreeSessionMarkerStrict(plan.lockKey);
  if (marker.state !== 'valid' || marker.sessionId !== sessionId) {
    return {
      ok: false,
      reason:
        marker.state === 'valid'
          ? 'marker names another session'
          : `marker ${marker.state}`,
    };
  }
  const allowedRoots = await worktreeAllowedRoots(
    current.workspaceCwd,
    current.originalCwd,
  );
  const contained = allowedRoots.some((root) => {
    try {
      const realRoot = fs.realpathSync(root);
      return (
        plan.lockKey === realRoot ||
        plan.lockKey.startsWith(realRoot + path.sep)
      );
    } catch {
      return false;
    }
  });
  if (!contained) {
    return { ok: false, reason: 'checkout outside workspace worktree roots' };
  }
  const chatsDir = path.dirname(plan.sidecarPath);
  const ownFile = path.basename(plan.sidecarPath);
  let entries: string[];
  try {
    entries = await fsp.readdir(chatsDir);
  } catch (error) {
    return {
      ok: false,
      reason: `sidecar scan failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  for (const entry of entries) {
    if (!entry.endsWith('.worktree.json') || entry === ownFile) continue;
    const other = await readWorktreeSessionStrict(path.join(chatsDir, entry));
    if (other.state === 'missing') continue;
    if (other.state === 'invalid') {
      return { ok: false, reason: `unreadable sibling sidecar ${entry}` };
    }
    if (canonicalPath(other.session.worktreePath) === plan.lockKey) {
      // A tombstone predecessor (superseded by exactly this session)
      // legitimately names the same checkout; it is evidence of the
      // transfer, not sharing.
      if (other.session.supersededBy === sessionId) continue;
      return { ok: false, reason: `checkout shared with ${entry}` };
    }
  }
  return { ok: true };
}

/**
 * Execute a verified cleanup after the record deletion was confirmed
 * (`kind === 'removed'`), still under the cleanup lock. The marker is
 * re-verified (nothing may have flipped it since classification) and the
 * checkout must be clean; the branch is deleted safely (never forced)
 * and a preserved branch is logged so "checkout removed, branch kept"
 * stays distinguishable from "checkout kept, ownership doubtful".
 */
export async function executeWorktreeCleanup(
  plan: WorktreeCleanupPlan,
): Promise<void> {
  const { sessionId, sidecar } = plan;
  const marker = await readWorktreeSessionMarkerStrict(plan.lockKey);
  if (marker.state !== 'valid' || marker.sessionId !== sessionId) {
    logWorktreeCleanupPreserve(sessionId, 'marker changed after delete');
    return;
  }
  if (await hasTrackedChanges(plan.lockKey)) {
    logWorktreeCleanupPreserve(sessionId, 'checkout has tracked changes');
    return;
  }
  // originalCwd is the root the creating worktree service used; the
  // sidecar contract reserves it for exactly this resolution.
  const result = await new GitWorktreeService(
    sidecar.originalCwd,
  ).removeUserWorktree(sidecar.slug, { deleteBranch: true });
  if (!result.success) {
    logWorktreeCleanupPreserve(
      sessionId,
      `checkout removal failed: ${result.error ?? 'unknown error'}`,
    );
    return;
  }
  if (result.branchPreserved) {
    logWarning(
      `worktree cleanup removed checkout but kept branch action=delete session=${safeLogValue(
        sessionId,
      )} slug=${safeLogValue(sidecar.slug)} branch=${safeLogValue(
        sidecar.worktreeBranch,
      )} reason=unmerged commits`,
    );
  }
}
