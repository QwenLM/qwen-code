/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {
  buildWorktreeSnapshotMeta,
  captureWorktreeSnapshot,
  carriedOverlayStillHeldBySource,
  computeCarriedIdentities,
  GitWorktreeService,
  isDisposableIgnoredEntry,
  readWorktreeSessionMarkerStrict,
  readWorktreeSessionStrict,
  WORKTREE_SESSION_FILE,
  worktreeBranchForSlug,
  hasHiddenIndexBit,
  worktreeHasPendingGitOperation,
  worktreeHasPopulatedGitlink,
  worktreeHasWork,
  type SessionService,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import { runGit } from '@qwen-code/qwen-code-core/utils/git-branches.js';
import { NO_EXEC_CONFIG } from '@qwen-code/qwen-code-core/utils/gitUtils.js';
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
  /**
   * The sidecar dir of the other archive state, when it differs from the
   * one `sidecarPath` lives in.
   */
  otherStateSidecarDir?: string;
}

/**
 * Also derives the ownership lock key, so it must keep the rule stated in
 * `worktree-ownership-op.ts`, which the restore and the reset route follow
 * too.
 */
function canonicalPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export const canonicalPathForTesting = canonicalPath;

function logWarning(message: string): void {
  writeStderrLine(`qwen serve: ${message}`);
}

function logInfo(message: string): void {
  // An explicit level marker so a successful capture is distinguishable from
  // the preserve/failure warnings on the same stderr channel (F4-1).
  writeStderrLine(`qwen serve: level=info ${message}`);
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

export function logWorktreeCleanupSnapshot(
  sessionId: string,
  snapshotPath: string,
): void {
  // A successful capture is normal operation, not an alert: keep it out of
  // the warning channel so log scanners do not treat it as a preserve/failure.
  // The archive path is the only durable pointer until U5 lands, so it must be
  // a usable full path — do NOT run it through safeLogValue's 82-char budget
  // (R4-4). It is daemon-generated; JSON.stringify still escapes control chars.
  logInfo(
    `worktree cleanup snapshotted checkout action=delete session=${safeLogValue(
      sessionId,
    )} snapshot=${JSON.stringify(snapshotPath)}`,
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
 * the sharing scan discounts tombstones (sibling sidecars carrying
 * `supersededBy`) instead: its direct predecessor alone always, older
 * ones once no superseded session naming the checkout is still live.
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
  const activeDir = path.dirname(service.getWorktreeSessionPath(sessionId));
  const archivedDir = path.dirname(
    service.getWorktreeSessionPathForArchiveState(sessionId, 'archived'),
  );
  const ownDir = path.dirname(sidecarPath);
  const otherStateSidecarDir = ownDir === activeDir ? archivedDir : activeDir;
  return {
    sessionId,
    sidecar: session,
    sidecarPath,
    lockKey: canonicalPath(session.worktreePath),
    ...(otherStateSidecarDir !== ownDir ? { otherStateSidecarDir } : {}),
  };
}

/** Serialize one session's record mutation + cleanup with restores and resets. */
export function acquireWorktreeCleanupLock(
  plan: WorktreeCleanupPlan,
): Promise<() => void> {
  return acquireWorktreeOwnershipOp(plan.lockKey);
}

export async function withWorktreeArchiveMove<T>(
  service: SessionService,
  sessionId: string,
  sourceState: 'active' | 'archived',
  move: () => Promise<T>,
): Promise<T> {
  const sidecarPath = service.getWorktreeSessionPathForArchiveState(
    sessionId,
    sourceState,
  );
  if (!fs.existsSync(sidecarPath)) return move();
  const sidecar = await readWorktreeSessionStrict(sidecarPath);
  if (sidecar.state !== 'valid') return move();
  const release = await acquireWorktreeOwnershipOp(
    canonicalPath(sidecar.session.worktreePath),
  );
  try {
    return await move();
  } finally {
    release();
  }
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

const SIDECAR_SUFFIX = '.worktree.json';

/**
 * Full ownership verification, called under the cleanup lock before the
 * record is deleted or archived. The sidecar is re-read because the pre-read was
 * advisory; the marker must name exactly this session; the checkout
 * must resolve under the workspace worktree roots; and no other
 * session's sidecar may name the same checkout (a freshly transferred
 * replacement satisfies the naive ownership bar during exactly the
 * window the superseded redirect exists to heal). The exception is a
 * tombstone, a sidecar carrying `supersededBy`: the direct predecessor
 * alone always, older ones once `isSessionLive` reports every session
 * naming the checkout gone.
 */
export async function verifyWorktreeCleanupOwnership(
  plan: WorktreeCleanupPlan,
  isSessionLive: (sessionId: string) => boolean,
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
  const tombstoneIds = new Set<string>();
  let olderTombstone = false;
  for (const dir of [chatsDir, plan.otherStateSidecarDir]) {
    if (dir === undefined) continue;
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch (error) {
      if (
        dir !== chatsDir &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        continue;
      }
      return {
        ok: false,
        reason: `sidecar scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    for (const entry of entries) {
      if (!entry.endsWith(SIDECAR_SUFFIX) || entry === ownFile) continue;
      const other = await readWorktreeSessionStrict(path.join(dir, entry));
      if (other.state === 'missing') continue;
      if (other.state === 'invalid') {
        return { ok: false, reason: `unreadable sibling sidecar ${entry}` };
      }
      if (canonicalPath(other.session.worktreePath) !== plan.lockKey) continue;
      // Tombstones record a transfer. Each reset updates only the pair
      // involved, so older tombstones may point to deleted sessions.
      if (other.session.supersededBy === undefined) {
        return { ok: false, reason: `checkout shared with ${entry}` };
      }
      tombstoneIds.add(entry.slice(0, -SIDECAR_SUFFIX.length));
      if (other.session.supersededBy !== sessionId) olderTombstone = true;
    }
  }
  // With only the direct predecessor, the one-reset rule discounts it
  // regardless: the bridge may have reopened it at the workspace root since
  // (scheduled-task keepalive, ACP load), and refusing then would leak the
  // checkout for good. Older tombstones are discounted only once no
  // superseded session naming the checkout is still on the bridge, in
  // either archive state's dir: a reset whose sever did not finish leaves
  // its superseded session running, possibly with background work in the
  // checkout.
  if (olderTombstone) {
    for (const otherId of tombstoneIds) {
      if (isSessionLive(otherId)) {
        return {
          ok: false,
          reason: `superseded session ${otherId} is still live`,
        };
      }
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
 * Identity of everything the archive can lose: a per-path record of its status
 * and raw-byte content identity — the same collapsed `status --ignored=matching
 * -z` listing the has-work gate and the capture exclusion consult (R6-1), with
 * `git hash-object --no-filters` identities for each non-disposable file record.
 * The earlier status+`diff HEAD` digest saw only untracked NAMES and tracked
 * content, so an autosave rewriting an untracked or ignored file mid-tar went
 * unnoticed (R8-1); it also executed any configured textconv driver (R8-2).
 * Disposable ignored output and daemon bookkeeping never count as drift —
 * otherwise a build writing node_modules during the tar would strand every
 * checkout. Returns null on read failure so the caller preserves (fail-closed).
 */
async function checkoutChangeDigest(
  worktreePath: string,
): Promise<string | null> {
  try {
    const status = await runGit(
      worktreePath,
      [
        ...NO_EXEC_CONFIG,
        '--no-optional-locks',
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching',
        '-z',
      ],
      undefined,
      64 * 1024 * 1024,
    );
    const records = status.split('\0');
    const paths: string[] = [];
    const types = new Map<string, string>();
    const symlinkTargets = new Map<string, string>();
    const pending: Array<{ xy: string; rel: string }> = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.length === 0) continue;
      const xy = record.slice(0, 2);
      pending.push({ xy, rel: record.slice(3) });
      // Rename/copy entries have a second BARE source-path record: it has no
      // status prefix or path kind. Consuming it here avoids lstat-ing a
      // truncated source and making every rename look unreadable (audit).
      if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
        i += 1;
      }
    }
    const originalStatusCount = pending.length;
    for (let i = 0; i < pending.length; i++) {
      const { xy, rel } = pending[i];
      // Disposable ignored output and daemon bookkeeping are waived by the
      // same gate geometry; they are not work and never count as drift.
      if (
        rel === WORKTREE_SESSION_FILE ||
        (rel.startsWith(`${WORKTREE_SESSION_FILE}.`) &&
          !rel.slice(WORKTREE_SESSION_FILE.length + 1).includes('/') &&
          rel.endsWith('.tmp'))
      ) {
        continue;
      }
      // Only the ORIGINAL collapsed ignored entry can authorize a disposable
      // waiver. A non-disposable parent makes the tar include every child,
      // including a nested node_modules subtree, so the digest must see it.
      if (
        i < originalStatusCount &&
        xy === '!!' &&
        isDisposableIgnoredEntry(rel)
      ) {
        continue;
      }
      // Enumerate collapsed directories without following links so a rewrite
      // inside an ignored directory or an untracked nested repository has a
      // raw identity just like an ordinary file. The archive walks both too.
      if ((xy === '!!' || xy === '??') && rel.endsWith('/')) {
        const entries = await fsp.readdir(path.join(worktreePath, rel), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          const child = `${rel}${entry.name}${entry.isDirectory() ? '/' : ''}`;
          pending.push({ xy, rel: child });
        }
        continue;
      }
      const stat = await fsp
        .lstat(path.join(worktreePath, rel))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
      if (stat === null) {
        // A tracked deletion is a real, archivable state, not a digest read
        // failure. computeCarriedIdentities records it as a null identity.
        types.set(rel, xy);
        paths.push(rel);
        continue;
      }
      paths.push(rel);
      types.set(rel, xy);
      if (stat.isSymbolicLink()) {
        symlinkTargets.set(
          rel,
          await fsp.readlink(path.join(worktreePath, rel)),
        );
      }
    }
    const identities = new Map(
      (await computeCarriedIdentities(worktreePath, paths)).map((e) => [
        e.path,
        e,
      ]),
    );
    const lines = paths.sort().map((rel) => {
      const id = identities.get(rel);
      return `${rel}\0${types.get(rel)}\0${id?.hash ?? ''}\0${
        id?.executable ? '1' : '0'
      }\0${
        id?.hash === null
          ? 'absent'
          : id
            ? 'regular'
            : symlinkTargets.has(rel)
              ? `symlink:${JSON.stringify(symlinkTargets.get(rel))}`
              : 'nonregular'
      }`;
    });
    return lines.join('\0');
  } catch {
    return null;
  }
}

export const checkoutChangeDigestForTesting = checkoutChangeDigest;

/**
 * Execute a verified cleanup after the record deletion or archive move was
 * confirmed, still under the cleanup lock. Archive keeps its sidecar in the
 * archived location; delete has already removed its ownership record. The marker is
 * re-verified (nothing may have flipped it since classification). A checkout
 * with work is snapshotted then deleted (P6 U3); a pristine one is deleted
 * bare only while the carry source still holds the overlay; a state the
 * snapshot cannot represent faithfully is preserved. The branch is deleted
 * safely (never forced) and a preserved branch is logged so "checkout
 * removed, branch kept" stays distinguishable from "checkout kept,
 * ownership doubtful".
 */
export async function executeWorktreeCleanup(
  plan: WorktreeCleanupPlan,
): Promise<void> {
  const { sessionId, sidecar } = plan;
  const marker = await readWorktreeSessionMarkerStrict(plan.lockKey);
  if (marker.state !== 'valid' || marker.sessionId !== sessionId) {
    logWorktreeCleanupPreserve(
      sessionId,
      'marker changed after session mutation',
    );
    return;
  }
  // An initialized submodule holds its own object database (possibly unpushed
  // commits) that neither the worktree tar nor the removal preserves, so the
  // checkout must be kept whole — before either the snapshot or the clean
  // deletion path (P1 submodule). The probe is fail-closed: an unreadable
  // checkout also reads as populated, so the reason names both arms (R5-7).
  if (await worktreeHasPopulatedGitlink(plan.lockKey)) {
    logWorktreeCleanupPreserve(
      sessionId,
      'initialized submodule present (or gitlink probe unreadable)',
    );
    return;
  }
  // Exempt the recorded carried overlay only while its content still matches
  // the carry-time identities, so a checkout whose only content is the
  // pristine carried copy is collected rather than preserved forever, while
  // a session change to a carried path reads as work and is snapshotted
  // (R9-6). Absent carriedEntries (legacy sidecars, no-carry creations) keeps
  // the gate behaving exactly as before. Fingerprint the checkout BEFORE
  // this classification: source verification may read a large carried file,
  // and a new session file saved meanwhile must differ from this baseline.
  const beforeDigest = await checkoutChangeDigest(plan.lockKey);
  let needsSnapshot = await worktreeHasWork(
    plan.lockKey,
    sidecar.carriedEntries,
  );
  // A pristine carried-only checkout reads clean, but collecting it WITHOUT an
  // archive is safe only while the source checkout still holds the overlay —
  // the overlay is a copy of the source's dirty state, and the source may have
  // moved on (R5-2). Verify the source side; if it no longer holds the overlay
  // (or cannot be read), snapshot instead of deleting bare. The source is the
  // checkout the carry came FROM (carriedFrom), which a /cd into a sibling
  // checkout makes differ from originalCwd — verifying originalCwd there
  // could authorize deleting the overlay's last copy (R5-14).
  if (
    !needsSnapshot &&
    sidecar.carriedEntries &&
    sidecar.carriedEntries.length > 0 &&
    !(await carriedOverlayStillHeldBySource(
      sidecar.carriedFrom ?? sidecar.originalCwd,
      sidecar.carriedEntries,
      plan.lockKey,
    ))
  ) {
    needsSnapshot = true;
  }
  // A bare carried-only path has no archive; its checked source gate applies.
  let checkoutMatchesCapture = true;
  if (needsSnapshot) {
    // P6 U3: a managed session worktree with genuine work is snapshotted then
    // deleted instead of preserved forever — the archive preserves the work
    // and reopening the chat offers restore (D7). A capture failure falls
    // back to the conservative preserve: never delete without a durable
    // snapshot. Tool/agent worktrees are not cleaned here, so their refusal
    // semantics are unchanged.
    try {
      const meta = await buildWorktreeSnapshotMeta(plan.lockKey, {
        sessionId,
        slug: sidecar.slug,
        baseCommit: sidecar.worktreeBase ?? sidecar.originalHeadCommit,
      });
      const snapshot = await captureWorktreeSnapshot({
        worktreePath: plan.lockKey,
        snapshotDir: path.dirname(plan.sidecarPath),
        meta,
      });
      checkoutMatchesCapture = snapshot.checkoutMatchesCapture;
      // Name the archive so the snapshot is discoverable after the record and
      // sidecar are gone. It is keyed by sessionId in the chats dir; the
      // reopen-restore affordance (P6 U5) reads it back by that key, and the
      // retention sweep (P6 U4) prunes it.
      logWorktreeCleanupSnapshot(sessionId, snapshot.snapshotPath);
    } catch (error) {
      logWorktreeCleanupPreserve(
        sessionId,
        `snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  }
  // An editor autosave can land between the has-work gate and the end of the
  // tar stream (P1 edits during capture). Removal is conditional on the
  // checkout still matching the captured contents: any drift — a late file,
  // a new edit, a staged change — preserves rather than deleting what the
  // archive could not cover (fail-closed on a read failure too).
  const afterDigest = await checkoutChangeDigest(plan.lockKey);
  if (
    beforeDigest === null ||
    afterDigest === null ||
    beforeDigest !== afterDigest
  ) {
    logWorktreeCleanupPreserve(
      sessionId,
      'checkout changed during cleanup (or its change digest is unreadable)',
    );
    return;
  }
  // An index bit set during capture can hide a tracked edit from every
  // content digest. The shared probe keeps the clean-sparse carve-out.
  if (await hasHiddenIndexBit(plan.lockKey)) {
    logWorktreeCleanupPreserve(
      sessionId,
      'hidden index bit appeared during cleanup',
    );
    return;
  }
  // A bisect/rebase/revert can start AFTER the pre-capture check without
  // changing file bytes or HEAD. Its private administrative state is not in
  // the archive or content digest, so re-observe it immediately before removal.
  if (await worktreeHasPendingGitOperation(plan.lockKey)) {
    logWorktreeCleanupPreserve(
      sessionId,
      'git operation became pending during cleanup',
    );
    return;
  }
  if (
    !needsSnapshot &&
    sidecar.carriedEntries &&
    sidecar.carriedEntries.length > 0 &&
    !(await carriedOverlayStillHeldBySource(
      sidecar.carriedFrom ?? sidecar.originalCwd,
      sidecar.carriedEntries,
      plan.lockKey,
    ))
  ) {
    logWorktreeCleanupPreserve(
      sessionId,
      'carried source changed during cleanup',
    );
    return;
  }
  // A submodule initialized during capture keeps its object store outside
  // the checkout root: neither the archive nor removal preserves that store.
  if (await worktreeHasPopulatedGitlink(plan.lockKey)) {
    logWorktreeCleanupPreserve(
      sessionId,
      'initialized submodule appeared during cleanup',
    );
    return;
  }
  if (!checkoutMatchesCapture) {
    logWorktreeCleanupPreserve(sessionId, 'checkout changed during capture');
    return;
  }
  // originalCwd is the root the creating worktree service used; the
  // sidecar contract reserves it for exactly this resolution, and the
  // locked verification asserted this derived target is the verified
  // checkout.
  const result = await new GitWorktreeService(
    sidecar.originalCwd,
  ).removeUserWorktree(sidecar.slug, {
    deleteBranch: true,
    // A sidecar recording the slug-derived branch names a named creation
    // (which owns its ref); '' or a user branch means detached/in-place,
    // which never created the slug ref. The recorded base lets the guard
    // tell agent commits from an unreachable creation base.
    branchOwned:
      sidecar.worktreeBranch !== '' &&
      sidecar.worktreeBranch === worktreeBranchForSlug(sidecar.slug),
    baseCommit: sidecar.worktreeBase ?? sidecar.originalHeadCommit,
  });
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
  if (result.branchPreserved || result.keptBranch) {
    logWarning(
      `worktree cleanup removed checkout but kept branch action=delete session=${safeLogValue(
        sessionId,
      )} slug=${safeLogValue(sidecar.slug)} branch=${safeLogValue(
        result.keptBranch ?? sidecar.worktreeBranch,
      )} reason=${result.branchPreserved ? 'unmerged commits' : 'branch kept'}`,
    );
  }
}
