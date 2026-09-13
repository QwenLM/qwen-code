/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitWorktreeService,
  gitEnv,
  NO_EXEC_CONFIG,
  readWorktreeSessionMarkerStrict,
  readWorktreeSessionStrict,
  WORKTREE_SESSION_FILE,
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

const execFileAsync = promisify(execFile);

/**
 * Ignored top-level directories whose contents are regenerable build or
 * dependency output. They are exempt from the ignored-content check so a
 * checkout where the agent ran `npm install` or a build stays cleanable;
 * every other ignored entry (agent artifacts like `.qwen/pr-drafts/`)
 * still counts as work.
 */
const DISPOSABLE_IGNORED_ROOTS = new Set(['node_modules', 'dist', 'coverage']);

/**
 * Full `git status --porcelain` — untracked files included — so an
 * agent-written file that was never committed counts as work and
 * preserves the checkout. The untracked mode is pinned and the
 * environment scrubbed (`gitEnv`) so an ambient
 * `status.showUntrackedFiles=no` or an inherited `GIT_DIR` cannot make a
 * dirty checkout read clean, and `--ignored=matching` keeps content
 * under git-ignored paths visible (minus disposable build output). The
 * daemon's own marker file is the one exemption (it is git-excluded in
 * production but may not be in hand-built fixtures). Fails closed to
 * "has work" on any read error.
 */
async function checkoutHasWork(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        ...NO_EXEC_CONFIG,
        '--no-optional-locks',
        'status',
        '--porcelain',
        '--untracked-files=normal',
        '--ignored=matching',
      ],
      { cwd: worktreePath, env: gitEnv() },
    );
    return stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .some((line) => {
        const entry = line.slice(3);
        if (entry === WORKTREE_SESSION_FILE) return false;
        if (line.startsWith('!!')) {
          return !DISPOSABLE_IGNORED_ROOTS.has(entry.split('/')[0]!);
        }
        return true;
      });
  } catch {
    return true;
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
 *
 * The sidecar is an untrusted input class (crash-truncated or
 * hand-edited), so the two fields that later derive the containment
 * allow-list and select the removal target are validated here, before
 * either one is trusted: both must be absolute, and when the runtime's
 * own workspace cwd is supplied they must belong to that workspace —
 * `workspaceCwd` must realpath to it exactly and `originalCwd` must be
 * the workspace or its repo top-level, the same pair the sibling
 * routes accept. Any doubt preserves the checkout with a named log
 * line; the session record deletion itself is never blocked.
 */
export async function preclassifyWorktreeCleanup(
  service: SessionService,
  sessionId: string,
  runtimeWorkspaceCwd?: string,
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
  if (
    !path.isAbsolute(session.workspaceCwd) ||
    !path.isAbsolute(session.originalCwd)
  ) {
    logWorktreeCleanupPreserve(
      sessionId,
      'sidecar base is not an absolute path',
    );
    return undefined;
  }
  if (runtimeWorkspaceCwd !== undefined) {
    if (
      canonicalPath(session.workspaceCwd) !== canonicalPath(runtimeWorkspaceCwd)
    ) {
      logWorktreeCleanupPreserve(
        sessionId,
        'sidecar belongs to another workspace',
      );
      return undefined;
    }
    const workspaceRoots = [canonicalPath(runtimeWorkspaceCwd)];
    try {
      const repoTop = await new GitWorktreeService(
        runtimeWorkspaceCwd,
      ).getRepoTopLevel();
      if (repoTop && canonicalPath(repoTop) !== workspaceRoots[0]) {
        workspaceRoots.push(canonicalPath(repoTop));
      }
    } catch {
      // Not a git repo — the workspace root alone bounds originalCwd.
    }
    if (!workspaceRoots.includes(canonicalPath(session.originalCwd))) {
      logWorktreeCleanupPreserve(
        sessionId,
        'sidecar original cwd is outside the accepted roots',
      );
      return undefined;
    }
  }
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
    // A relative or empty base would resolve against the daemon's own
    // cwd — never let it derive a root. preclassify already rejects
    // such sidecars; this is the defense in depth underneath it.
    if (!path.isAbsolute(base)) continue;
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
    current.worktreePath !== sidecar.worktreePath ||
    current.originalCwd !== sidecar.originalCwd ||
    current.workspaceCwd !== sidecar.workspaceCwd
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
  // Every guard above verified plan.lockKey, but the removal call
  // re-derives its own target from originalCwd + slug. Assert the two
  // denote the same directory before the destructive phase may run —
  // both sides canonicalized, because the sidecar stores the realpath'd
  // path while the service joins against a merely resolved root.
  const removalTarget = canonicalPath(
    new GitWorktreeService(current.originalCwd).getUserWorktreePath(
      current.slug,
    ),
  );
  if (removalTarget !== plan.lockKey) {
    return {
      ok: false,
      reason: 'slug does not resolve to the verified checkout',
    };
  }
  // Verification passed against the locked re-read — the destructive
  // phase must consume those values, not the advisory snapshot.
  plan.sidecar = current;
  return { ok: true };
}

/**
 * Whether the checkout still holds any entries. `removeWorktree` can
 * delete the contents and fail only the final `rmdir` (its fallback
 * `fs.rm(recursive, force)` removes children first, and git itself
 * unlinks files before a failing `rmdir`), so a `success: false`
 * result does not mean the checkout survived intact — the log line
 * must re-observe the filesystem instead of certifying preservation.
 * Unreadable or missing counts as not populated: when we cannot see
 * the contents we do not claim they survived.
 */
async function checkoutStillPopulated(worktreePath: string): Promise<boolean> {
  try {
    return (await fsp.readdir(worktreePath)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Execute a verified cleanup after the record deletion was confirmed
 * (`kind === 'removed'`), still under the cleanup lock. The marker is
 * re-verified (nothing may have flipped it since classification) and the
 * checkout must hold no uncommitted work; the branch is deleted safely
 * (never forced) and a preserved branch is logged so "checkout removed,
 * branch kept" stays distinguishable from "checkout kept, ownership
 * doubtful".
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
  if (await checkoutHasWork(plan.lockKey)) {
    logWorktreeCleanupPreserve(sessionId, 'checkout has uncommitted work');
    return;
  }
  // originalCwd is the root the creating worktree service used; the
  // sidecar contract reserves it for exactly this resolution, and the
  // locked verification asserted this derived target is the verified
  // checkout.
  const result = await new GitWorktreeService(
    sidecar.originalCwd,
  ).removeUserWorktree(sidecar.slug, { deleteBranch: true });
  if (!result.success) {
    const errorText = result.error ?? 'unknown error';
    if (await checkoutStillPopulated(plan.lockKey)) {
      logWorktreeCleanupPreserve(
        sessionId,
        `checkout removal failed: ${errorText}`,
      );
    } else {
      logWarning(
        `worktree cleanup removal failed, checkout may be partially deleted action=delete session=${safeLogValue(
          sessionId,
        )} reason=${safeLogValue(errorText)}`,
      );
    }
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
