/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import {
  GitWorktreeService,
  readWorktreeSessionMarkerStrict,
} from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { readWorktreeSessionStrict } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import {
  isReservedStandaloneSessionSource,
  readLoadableLiveConversationMetadata,
} from '../../runtime/live-session-source.js';
import { AGENT_SESSION_SOURCE_TYPE } from '../../runtime/agent-session-source.js';
import {
  SessionNotFoundError,
  type BridgeRestoredSession,
} from '../acp-session-bridge.js';
import type { DaemonLogger } from '../daemon-logger.js';
import {
  assertSessionRestorable,
  resolveSessionIdForRestore,
  type SessionArchiveCoordinator,
} from './session-archive.js';
import { acquireWorktreeOwnershipOp } from './worktree-ownership-op.js';
import {
  WorktreeMarkerMissingError,
  WorktreeResetInterruptedError,
  WorktreeSessionSupersededError,
} from './worktree-reset-errors.js';
import {
  readRecentPromptTerminals,
  reconcileDanglingPromptTerminals,
  withPromptTerminals,
} from '../prompt-terminal-ledger.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { isInternalWorkspaceRuntime } from '../workspace-runtime-visibility.js';
import {
  createWorkspaceRuntimeSessionService,
  runWithWorkspaceRuntimeStorage,
} from '../workspace-runtime-storage.js';
import type {
  RequestedSessionIdAdmission,
  RequestedSessionIdReservation,
} from '../session-id-admission.js';

/**
 * Key for the worktree ownership lock (`acquireWorktreeOwnershipOp`) of a
 * sidecar's recorded checkout, by the rule stated in
 * `server/worktree-ownership-op.ts`: for a checkout that resolves, it gives
 * the same key as the reset route's `realTarget` and the orphan cleanup's
 * `canonicalPath`, and the restore compares it with its own `realTarget`. A
 * path that does not resolve falls back to the raw sidecar path, and the
 * restore never attests it.
 */
function ownershipLockKeyForWorktree(recordedPath: string): string {
  try {
    return fs.realpathSync(recordedPath);
  } catch {
    return recordedPath;
  }
}

export const ownershipLockKeyForWorktreeForTesting =
  ownershipLockKeyForWorktree;

/**
 * Refuses a restore whose worktree checks would act on a checkout this
 * request does not hold the ownership lock for: a reset of that checkout
 * could move its ownership, or roll back its supersede link, while the
 * restore reads it. A plain error, so the restore fails closed (500) like
 * the untyped integrity failures there; a later restore re-reads the sidecar
 * and takes the right lock.
 */
function assertWorktreeOwnershipLockHeld(
  heldKey: string | undefined,
  checkoutKey: string,
): void {
  if (heldKey !== checkoutKey) {
    throw new Error(
      'Worktree ownership lock does not cover the restored checkout',
    );
  }
}

interface ReconcileRestoredSessionWorktreeInput {
  runtime: WorkspaceRuntime;
  workspaceCwd: string;
  /** Canonical id the bridge registered the restored entry under. */
  sessionId: string;
  /**
   * Persisted spelling of the id: the sidecar is keyed by it and any
   * worktree marker present must name it.
   */
  restoredStorageSessionId: string;
  /**
   * The bridge's restore result; `currentCwd`, `worktree` and
   * `worktreeState` are updated in place.
   */
  session: BridgeRestoredSession;
  /** Must match whether the bridge restore was asked to defer its question. */
  deferRestoreAskUserQuestionPrompt: boolean;
  /**
   * Key of the ownership lock the caller holds, or `undefined` when it took
   * none. The non-legacy checks refuse a checkout this key does not cover.
   */
  heldWorktreeOwnershipLockKey: string | undefined;
  /** Checked just before the session is marked `persisted-v1`. */
  assertRuntimeGenerationOpen: (() => void) | undefined;
  /**
   * Releases the restored session, discarding a deferred question first;
   * awaited before any failure is rethrown.
   */
  cleanupRestoredSession: () => Promise<void>;
  daemonLog: DaemonLogger | undefined;
}

/**
 * Re-attaches a restored session to the worktree its sidecar records,
 * after the bridge restore and before the response.
 *
 * A legacy sidecar (no recorded workspace) is best-effort and never earns
 * `persisted-v1`: a sidecar that fails validation, or a relocation that
 * throws, is logged and leaves the worktree unattached, but a checkout
 * marker that names another session or reads `invalid` fails the restore.
 * Any other sidecar must prove ownership: one that reads `invalid` always
 * fails, every failure releases the session and rethrows, and success
 * marks the session `persisted-v1` except in the one shape explained at
 * `hasUnlocatedRestoredPrompt`. Without a sidecar the session is untouched.
 *
 * The caller owns three things, as `restoreSessionHandler` does:
 * - The worktree ownership lock (`acquireWorktreeOwnershipOp`), taken when
 *   its own read before the bridge restore finds a sidecar that records
 *   its workspace, and held across the bridge restore and this call. Its
 *   key is passed in as `heldWorktreeOwnershipLockKey`: a sidecar that was
 *   missing, legacy or `invalid` at that earlier read, or that now names a
 *   different checkout, reaches the non-legacy checks without this
 *   checkout's lock and is refused there.
 * - A deferred restore question: fired only after this call returns, and
 *   discarded by `cleanupRestoredSession`.
 * - Live-conversation runtimes: they skip this call, and the caller places
 *   the restored entry in its isolated conversation directory instead.
 */
async function reconcileRestoredSessionWorktree({
  runtime,
  workspaceCwd,
  sessionId,
  restoredStorageSessionId,
  session,
  deferRestoreAskUserQuestionPrompt,
  heldWorktreeOwnershipLockKey,
  assertRuntimeGenerationOpen,
  cleanupRestoredSession,
  daemonLog,
}: ReconcileRestoredSessionWorktreeInput): Promise<void> {
  const sidecarPath = createWorkspaceRuntimeSessionService(
    runtime,
  ).getWorktreeSessionPath(restoredStorageSessionId);
  const sidecarResult = await readWorktreeSessionStrict(sidecarPath);
  if (
    sidecarResult.state === 'valid' &&
    sidecarResult.session.workspaceCwd === undefined
  ) {
    const sidecar = sidecarResult.session;
    let realTarget: string | undefined;
    let candidateRoots: string[] = [];
    let validationError: unknown;
    try {
      const workspaceRoots = [fs.realpathSync(workspaceCwd)];
      let repoTop: string | null = null;
      try {
        repoTop = await new GitWorktreeService(workspaceCwd).getRepoTopLevel();
      } catch {
        // Not a git repo or getRepoTopLevel unavailable.
      }
      if (repoTop) {
        const realRepoTop = fs.realpathSync(repoTop);
        if (!workspaceRoots.includes(realRepoTop)) {
          workspaceRoots.push(realRepoTop);
        }
      }
      const realOriginalCwd = fs.realpathSync(sidecar.originalCwd);
      if (!workspaceRoots.includes(realOriginalCwd)) {
        throw new Error('legacy sidecar belongs to another workspace');
      }
      candidateRoots = workspaceRoots.map((root) =>
        path.join(root, '.qwen', 'worktrees'),
      );
      realTarget = fs.realpathSync(sidecar.worktreePath);
      const contained = candidateRoots.some((root) => {
        try {
          const realRoot = fs.realpathSync(root);
          const relative = path.relative(realRoot, realTarget!);
          return (
            relative.length > 0 &&
            !relative.startsWith('..') &&
            !path.isAbsolute(relative)
          );
        } catch {
          return false;
        }
      });
      if (!contained) {
        throw new Error('worktree sidecar path failed containment');
      }
    } catch (error) {
      validationError = error;
      realTarget = undefined;
    }
    if (realTarget) {
      try {
        const marker = await readWorktreeSessionMarkerStrict(realTarget);
        if (
          marker.state !== 'missing' &&
          (marker.state !== 'valid' ||
            marker.sessionId !== restoredStorageSessionId)
        ) {
          throw new Error('Worktree marker ownership is invalid');
        }
      } catch (error) {
        await cleanupRestoredSession();
        throw error;
      }
    }
    if (!realTarget) {
      daemonLog?.warn('worktree sidecar path failed containment', {
        sessionId,
        path: sidecar.worktreePath,
        error:
          validationError instanceof Error
            ? validationError.message
            : String(validationError),
      });
    } else {
      const worktree = {
        slug: sidecar.slug,
        path: realTarget,
        branch: sidecar.worktreeBranch,
      };
      try {
        if (!session.hasActivePrompt) {
          await runtime.bridge.changeSessionCwd(sessionId, {
            path: worktree.path,
            allowedRoots: candidateRoots,
          });
          session.currentCwd = worktree.path;
        }
        runtime.bridge.setSessionWorktree(sessionId, worktree);
        session.worktree = worktree;
      } catch (restoreErr) {
        daemonLog?.warn('worktree restore failed on load/resume', {
          sessionId,
          worktreePath: worktree.path,
          error:
            restoreErr instanceof Error
              ? restoreErr.message
              : String(restoreErr),
        });
      }
    }
  } else if (sidecarResult.state !== 'missing') {
    try {
      if (sidecarResult.state !== 'valid') {
        throw new Error('Worktree sidecar is missing or invalid');
      }
      const sidecar = sidecarResult.session;
      // The ownership lock was keyed by the read before the bridge
      // restore. A sidecar that was missing, legacy or invalid then,
      // or that now names another checkout, reaches here without
      // this checkout's lock.
      assertWorktreeOwnershipLockHeld(
        heldWorktreeOwnershipLockKey,
        ownershipLockKeyForWorktree(sidecar.worktreePath),
      );
      // For a Channel restore whose earlier read found a sidecar that
      // records its workspace, restoreSessionHandler already refused a
      // superseded sidecar under the ownership lock; every other restore
      // relies on this check. A superseded session is released and never
      // handed back, whatever path raced us here.
      if (sidecar.supersededBy !== undefined) {
        throw new WorktreeSessionSupersededError(
          restoredStorageSessionId,
          sidecar.supersededBy,
        );
      }
      const realWorkspace = fs.realpathSync(workspaceCwd);
      if (sidecar.workspaceCwd !== undefined) {
        let realSidecarWorkspace: string;
        try {
          realSidecarWorkspace = fs.realpathSync(sidecar.workspaceCwd);
        } catch {
          throw new Error(
            'Worktree sidecar workspace is missing or inaccessible',
          );
        }
        if (realSidecarWorkspace !== realWorkspace) {
          throw new Error('Worktree sidecar belongs to another workspace');
        }
      }
      const workspaceRoots = [realWorkspace];
      let repoTop: string | null = null;
      try {
        repoTop = await new GitWorktreeService(realWorkspace).getRepoTopLevel();
      } catch {
        // A missing repository makes containment validation fail below.
      }
      if (repoTop && repoTop !== realWorkspace) {
        workspaceRoots.push(fs.realpathSync(repoTop));
      }
      let realOriginalCwd: string;
      try {
        realOriginalCwd = fs.realpathSync(sidecar.originalCwd);
      } catch {
        throw new Error(
          'Worktree sidecar workspace is missing or inaccessible',
        );
      }
      if (!workspaceRoots.includes(realOriginalCwd)) {
        throw new Error('Worktree sidecar belongs to another workspace');
      }
      const candidateRoots = workspaceRoots.map((root) =>
        path.join(root, '.qwen', 'worktrees'),
      );
      // Compared with the ownership lock key below, so it must keep the
      // rule stated in `server/worktree-ownership-op.ts`.
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(sidecar.worktreePath);
      } catch {
        throw new Error('Worktree checkout is missing or inaccessible');
      }
      // Again on the path the checks below act on, in case the
      // checkout appeared since the key was derived from the raw path.
      assertWorktreeOwnershipLockHeld(heldWorktreeOwnershipLockKey, realTarget);
      const contained = candidateRoots.some((root) => {
        try {
          const realRoot = fs.realpathSync(root);
          const relative = path.relative(realRoot, realTarget);
          return (
            relative.length > 0 &&
            !relative.startsWith('..') &&
            !path.isAbsolute(relative)
          );
        } catch {
          return false;
        }
      });
      if (!contained) {
        throw new Error('Worktree sidecar path failed containment');
      }
      const marker = await readWorktreeSessionMarkerStrict(realTarget);
      if (
        marker.state !== 'valid' ||
        marker.sessionId !== restoredStorageSessionId
      ) {
        // Interrupted-transfer classification: this session's sidecar
        // names the session it supersedes, the old session's sidecar
        // agrees, and the marker never moved (or was cleaned). The
        // transfer crashed between the sidecar rewrite and the
        // flip; the repair is retrying the reset.
        if (
          sidecar.supersedes !== undefined &&
          (marker.state === 'missing' ||
            (marker.state === 'valid' &&
              marker.sessionId === sidecar.supersedes))
        ) {
          const oldSidecar = await readWorktreeSessionStrict(
            createWorkspaceRuntimeSessionService(
              runtime,
            ).getWorktreeSessionPath(sidecar.supersedes),
          );
          if (
            oldSidecar.state === 'valid' &&
            oldSidecar.session.supersededBy === restoredStorageSessionId
          ) {
            // The other side of this handoff is the SUPERSEDED
            // session, so it must not ride the wire as
            // `replacementSessionId`: that key tells a caller to load
            // the id it carries, and the session being restored here
            // already is the replacement. The old id is diagnostic.
            daemonLog?.warn('worktree restore found an interrupted reset', {
              sessionId: restoredStorageSessionId,
              supersedesSessionId: sidecar.supersedes,
            });
            throw new WorktreeResetInterruptedError(restoredStorageSessionId);
          }
        }
        if (marker.state === 'missing') {
          throw new WorktreeMarkerMissingError(restoredStorageSessionId);
        }
        throw new Error('Worktree marker ownership is invalid');
      }
      const worktree = {
        slug: sidecar.slug,
        path: realTarget,
        branch: sidecar.worktreeBranch,
      };
      // A parked deferred restore prompt reads inactive here by
      // design (the bridge's restore response excludes it), so the
      // deferred shape still reaches the relocating branch and earns
      // its attestation. A genuinely active session refuses the
      // relocation instead of being moved under its prompt.
      //
      // A restore that never asked for the deferral still reports an
      // active prompt when `restoreAskUserQuestion` is on: the bridge
      // fires the re-hung question during the cold restore, and that
      // response carries no `currentCwd`. Relocating it is impossible
      // (`changeSessionCwd` chains onto the prompt queue and refuses
      // while a prompt is live), and failing closed would kill the
      // session the caller just recovered — inside a checkout a
      // non-suppressed restore lets the child place itself in. Keep
      // the pre-4B outcome for that one shape: worktree metadata
      // without the attestation this restore cannot earn.
      const hasUnlocatedRestoredPrompt =
        session.hasActivePrompt &&
        !session.attached &&
        session.currentCwd === undefined &&
        !deferRestoreAskUserQuestionPrompt;
      if (hasUnlocatedRestoredPrompt) {
        runtime.bridge.setSessionWorktree(sessionId, worktree);
        session.worktree = worktree;
      } else {
        if (session.hasActivePrompt) {
          if (session.currentCwd !== realTarget) {
            throw new Error('Active session is outside its worktree');
          }
        } else {
          const changed = await runtime.bridge.changeSessionCwd(sessionId, {
            path: realTarget,
            allowedRoots: candidateRoots,
          });
          if (changed.newCwd !== realTarget) {
            throw new Error('Worktree relocation was rejected');
          }
          session.currentCwd = changed.newCwd;
        }
        runtime.bridge.setSessionWorktree(sessionId, worktree);
        assertRuntimeGenerationOpen?.();
        session.worktree = worktree;
        session.worktreeState = 'persisted-v1';
      }
    } catch (restoreErr) {
      daemonLog?.warn('worktree integrity validation failed', {
        sessionId: session.sessionId,
        error:
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      });
      await cleanupRestoredSession();
      throw restoreErr;
    }
  }
}

export type SessionRestoreResult =
  | { kind: 'restored'; session: BridgeRestoredSession }
  | { kind: 'cancelled' };

/**
 * The restore half of `POST /session/:id/load` and `/resume`, from the
 * restore admission through the worktree reconcile, the deferred question
 * and the response payload — with no `req`/`res` in sight, so an in-process
 * caller can restore a session too. The route keeps parsing, the
 * virtual-subagent and legacy standalone branches, redaction and error
 * mapping; typed errors propagate unchanged so both callers classify them
 * the same way.
 *
 * The reservation and the worktree ownership lock are taken and released
 * here, and every read that depends on them stays inside that window.
 */
export async function restoreSessionCore(options: {
  action: 'load' | 'resume';
  runtime: WorkspaceRuntime;
  workspaceCwd: string;
  sessionId: string;
  archiveCoordinator: SessionArchiveCoordinator;
  requestedSessionIdAdmission: RequestedSessionIdAdmission;
  assertRuntimeGenerationOpen: (() => void) | undefined;
  daemonLog: DaemonLogger | undefined;
  materializeLiveConversationDirectory:
    | ((sessionId: string) => Promise<string>)
    | undefined;
  historyPageSize: number | undefined;
  liveReplayMode: 'full' | 'summary' | undefined;
  compactedReplayMode: 'full' | 'summary' | undefined;
  clientId: string | undefined;
  approvalMode: ApprovalMode | undefined;
  restoreSource: { sourceType?: string; sourceId?: string };
  /** True once the caller no longer wants the result (HTTP: `!res.writable`). */
  isCancelled: () => boolean;
  /** HTTP telemetry sink; an in-process caller has none. */
  onWorkspaceResolved?: (workspaceCwd: string) => void;
}): Promise<SessionRestoreResult> {
  const {
    action,
    runtime,
    workspaceCwd,
    sessionId,
    archiveCoordinator,
    requestedSessionIdAdmission,
    assertRuntimeGenerationOpen,
    daemonLog,
    materializeLiveConversationDirectory,
    historyPageSize,
    liveReplayMode,
    compactedReplayMode,
    clientId,
    approvalMode,
    restoreSource,
    isCancelled,
    onWorkspaceResolved,
  } = options;
  let sessionIdReservation: RequestedSessionIdReservation | undefined;
  if (!isInternalWorkspaceRuntime(runtime)) {
    sessionIdReservation = requestedSessionIdAdmission.reserveRestore(
      sessionId,
      {
        bridge: runtime.bridge,
        workspaceCwd,
        workspaceId: runtime.workspaceId,
      },
    );
  }
  let restoredStorageSessionId = sessionId;
  let suppressWorktreeContextRestore = false;
  let deferRestoreAskUserQuestionPrompt = false;
  let releaseWorktreeRestore: (() => void) | undefined;
  let heldWorktreeOwnershipLockKey: string | undefined;
  try {
    // The coordinator canonicalizes lock keys (every case variant of a
    // caller id contends on one key), so the request spelling alone
    // covers the raw-spelled batch delete/archive/unarchive locks.
    const session = await runWithWorkspaceRuntimeStorage(runtime, () =>
      archiveCoordinator.runSharedMany([sessionId], async () => {
        const sessionService = createWorkspaceRuntimeSessionService(runtime);
        const persistedSessionId = await resolveSessionIdForRestore(
          sessionService,
          sessionId,
        );
        if (persistedSessionId) {
          restoredStorageSessionId = persistedSessionId;
        } else if (isInternalWorkspaceRuntime(runtime)) {
          throw new SessionNotFoundError(sessionId);
        }
        const location = await assertSessionRestorable(
          workspaceCwd,
          restoredStorageSessionId,
          sessionId,
          runtime.sessionRuntimeBaseDir,
        );
        if (location === undefined && isInternalWorkspaceRuntime(runtime)) {
          throw new SessionNotFoundError(sessionId);
        }
        // Recover the persisted parent lineage so the restored live entry
        // reports it (the bridge otherwise creates the entry without it, and
        // status calls would show a restored sub-session as top-level).
        const metadata =
          runtime.provenance === 'live-conversation'
            ? await readLoadableLiveConversationMetadata(
                restoredStorageSessionId,
                sessionService,
              )
            : await sessionService.readCreationMetadata(
                restoredStorageSessionId,
              );
        // The reserved standalone source is hidden only on the internal
        // Conversations runtime. Ordinary workspace restores keep
        // loading legacy transcripts that happen to carry the reserved
        // source string — create-side admission already blocks new ones,
        // so every such transcript on an ordinary store predates the
        // gate and must not become unreachable.
        if (
          metadata === undefined ||
          (isInternalWorkspaceRuntime(runtime) &&
            isReservedStandaloneSessionSource(metadata))
        ) {
          throw new SessionNotFoundError(sessionId);
        }
        const {
          sourceType: _reservedSourceType,
          sourceId: _reservedSourceId,
          ...metadataWithoutSource
        } = metadata;
        // Agent-source sessions strip their source on restore as well:
        // the restore is a person reading history, and the admission gate
        // in acpAgent refuses `sourceType: 'agent'` materialisation with
        // no live run behind it — keeping the source would make a finished
        // agent's transcript unopenable while it stays listed.
        const restoreMetadata =
          (!isInternalWorkspaceRuntime(runtime) &&
            isReservedStandaloneSessionSource(metadata)) ||
          metadata.sourceType === AGENT_SESSION_SOURCE_TYPE
            ? metadataWithoutSource
            : metadata;
        const hasPersistedSource =
          'sourceType' in restoreMetadata &&
          restoreMetadata.sourceType !== undefined;
        const restoreRequestMetadata = {
          ...restoreMetadata,
          ...(hasPersistedSource || isInternalWorkspaceRuntime(runtime)
            ? {}
            : restoreSource),
        };
        const isChannelRestore =
          restoreRequestMetadata.sourceType === 'channel';
        let isPart4AWorktreeRestore = false;
        let part4AWorktreeKey: string | undefined;
        if (runtime.provenance !== 'live-conversation') {
          const sidecarBeforeRestore = await readWorktreeSessionStrict(
            sessionService.getWorktreeSessionPath(restoredStorageSessionId),
          );
          if (isChannelRestore) {
            // The superseded decision is deliberately NOT taken here:
            // this pre-read only supplies the ownership lock's key, and a
            // transfer that rolls back between the two would make this
            // route redirect the caller to a replacement the same daemon
            // is about to delete. It is re-read under the lock below.
            suppressWorktreeContextRestore = !(
              sidecarBeforeRestore.state === 'valid' &&
              sidecarBeforeRestore.session.workspaceCwd === undefined
            );
          }
          // The ownership validation in reconcileRestoredSessionWorktree
          // runs for every non-live restore, and the reset route is
          // public, so the lock cannot be Channel-only: a source-less
          // restore would otherwise attest exclusive ownership while a
          // transfer moves it. Legacy sidecars (no recorded workspace)
          // validate on the legacy path and stay lock-free.
          isPart4AWorktreeRestore =
            sidecarBeforeRestore.state === 'valid' &&
            sidecarBeforeRestore.session.workspaceCwd !== undefined;
          if (
            isPart4AWorktreeRestore &&
            sidecarBeforeRestore.state === 'valid'
          ) {
            part4AWorktreeKey = ownershipLockKeyForWorktree(
              sidecarBeforeRestore.session.worktreePath,
            );
          }
        } else {
          suppressWorktreeContextRestore = isChannelRestore;
        }
        deferRestoreAskUserQuestionPrompt =
          suppressWorktreeContextRestore &&
          runtime.bridge.fireDeferredRestoreAskUserQuestionPrompt !==
            undefined &&
          runtime.bridge.discardDeferredRestoreAskUserQuestionPrompt !==
            undefined;
        if (isPart4AWorktreeRestore && part4AWorktreeKey !== undefined) {
          releaseWorktreeRestore =
            await acquireWorktreeOwnershipOp(part4AWorktreeKey);
          heldWorktreeOwnershipLockKey = part4AWorktreeKey;
          if (isChannelRestore) {
            // A reset moved this session's worktree ownership to a
            // replacement: never restore the superseded session — tell
            // the caller where the ownership went so it can redirect (and
            // self-heal its registry). Decided on the locked read, so a
            // transfer that rolled back while this request waited cannot
            // make it redirect to a replacement that no longer exists.
            const sidecarUnderLock = await readWorktreeSessionStrict(
              sessionService.getWorktreeSessionPath(restoredStorageSessionId),
            );
            if (
              sidecarUnderLock.state === 'valid' &&
              sidecarUnderLock.session.workspaceCwd !== undefined
            ) {
              assertWorktreeOwnershipLockHeld(
                heldWorktreeOwnershipLockKey,
                ownershipLockKeyForWorktree(
                  sidecarUnderLock.session.worktreePath,
                ),
              );
            }
            if (
              sidecarUnderLock.state === 'valid' &&
              sidecarUnderLock.session.supersededBy !== undefined
            ) {
              throw new WorktreeSessionSupersededError(
                restoredStorageSessionId,
                sidecarUnderLock.session.supersededBy,
              );
            }
          }
        }
        assertRuntimeGenerationOpen?.();
        if (isInternalWorkspaceRuntime(runtime)) {
          sessionIdReservation = requestedSessionIdAdmission.reserveRestore(
            sessionId,
            {
              bridge: runtime.bridge,
              workspaceCwd,
              workspaceId: runtime.workspaceId,
            },
          );
          onWorkspaceResolved?.(runtime.workspaceCwd);
        }
        let liveConversationCwd: string | undefined;
        if (runtime.provenance === 'live-conversation') {
          const materialize = materializeLiveConversationDirectory;
          if (!materialize) {
            throw new Error('Live conversation workspace is unavailable.');
          }
          // Keyed on the canonical id, not the persisted spelling: the
          // bridge registers the live entry under the canonical id, and
          // every later materialize/discard call derives the directory
          // from that same id.
          liveConversationCwd = await materialize(sessionId);
        }
        assertRuntimeGenerationOpen?.();
        const restored =
          action === 'load'
            ? await runtime.bridge.loadSession({
                sessionId,
                workspaceCwd,
                ...(suppressWorktreeContextRestore
                  ? {
                      suppressWorktreeContextRestore: true,
                      ...(deferRestoreAskUserQuestionPrompt
                        ? { deferRestoreAskUserQuestionPrompt: true }
                        : {}),
                    }
                  : {}),
                historyReplay: 'response',
                ...(historyPageSize !== undefined ? { historyPageSize } : {}),
                ...(liveReplayMode !== undefined ? { liveReplayMode } : {}),
                ...(compactedReplayMode !== undefined
                  ? { compactedReplayMode }
                  : {}),
                ...(clientId !== undefined ? { clientId } : {}),
                ...(approvalMode !== undefined ? { approvalMode } : {}),
                ...restoreRequestMetadata,
              })
            : await runtime.bridge.resumeSession({
                sessionId,
                workspaceCwd,
                ...(suppressWorktreeContextRestore
                  ? {
                      suppressWorktreeContextRestore: true,
                      ...(deferRestoreAskUserQuestionPrompt
                        ? { deferRestoreAskUserQuestionPrompt: true }
                        : {}),
                    }
                  : {}),
                ...(clientId !== undefined ? { clientId } : {}),
                ...(approvalMode !== undefined ? { approvalMode } : {}),
                ...restoreRequestMetadata,
              });
        // Every path that can register a Live entry relocates it before a
        // prompt can start. Re-queuing cd for an active entry would block
        // this load behind the prompt it is meant to observe.
        if (liveConversationCwd !== undefined) {
          if (restored.hasActivePrompt) {
            if (restored.currentCwd === liveConversationCwd) {
              return restored;
            }
            try {
              if (restored.clientId) {
                await runtime.bridge.detachClient(
                  restored.sessionId,
                  restored.clientId,
                );
              }
            } catch {
              // Preserve the isolation error. Never kill an active owner.
            }
            throw new Error(
              'Active Live session is outside its isolated conversation directory.',
            );
          }
          try {
            const changed = await runtime.bridge.changeSessionCwd(sessionId, {
              path: liveConversationCwd,
              allowedRoots: [runtime.workspaceCwd],
              managedRelocation: 'live-conversation',
            });
            if (changed.newCwd !== liveConversationCwd) {
              throw new Error(
                'Live conversation directory relocation was rejected.',
              );
            }
            restored.currentCwd = changed.newCwd;
          } catch (error) {
            try {
              if (restored.attached) {
                if (restored.clientId) {
                  await runtime.bridge.detachClient(
                    restored.sessionId,
                    restored.clientId,
                  );
                }
              } else {
                await runtime.bridge.killSession(restored.sessionId, {
                  requireZeroAttaches: true,
                });
              }
            } catch {
              // Preserve the relocation error.
            }
            throw error;
          }
        }
        // Prompt terminal ledger: reconcile prompts left in_flight by
        // a dead previous daemon before responding. Only the cold path
        // (no live entry attached and no active prompt on a live entry)
        // is eligible — an attached load has a live owner that will
        // publish the real terminal itself, and live-conversation
        // workspaces store transcripts outside the runtime layout this
        // reconciliation reads. Gated on `action === 'load'` to match
        // the load-mediation contract (resume keeps its exact
        // pre-existing response shape).
        if (
          action === 'load' &&
          !restored.attached &&
          !restored.hasActivePrompt &&
          !deferRestoreAskUserQuestionPrompt &&
          runtime.provenance !== 'live-conversation'
        ) {
          try {
            await reconcileDanglingPromptTerminals(sessionService, sessionId);
          } catch {
            // Best-effort: a failure leaves dangling prompts unknown
            // (fail-closed) and must never fail the load itself.
          }
        }
        return restored;
      }),
    );
    const cleanupRestoredSession = async (): Promise<void> => {
      if (deferRestoreAskUserQuestionPrompt) {
        runtime.bridge.discardDeferredRestoreAskUserQuestionPrompt?.(
          session.sessionId,
          session.clientId,
        );
      }
      if (session.attached) {
        await runtime.bridge
          .detachClient(session.sessionId, session.clientId)
          .catch(() => {});
      } else {
        await runtime.bridge
          .killSession(session.sessionId, { requireZeroAttaches: true })
          .catch(() => {});
      }
    };
    try {
      assertRuntimeGenerationOpen?.();
    } catch (error) {
      await cleanupRestoredSession();
      throw error;
    }
    // Mirror the `POST /session` disconnect-cleanup path (see the
    // long comment above the matching `if (!res.writable)` there
    // for the rationale around `res.writable` vs `req.aborted` /
    // `req.destroyed`, plus the `requireZeroAttaches` race
    // and the attach-rollback case). Restore needs the
    // same cleanup because a client that disconnects during a
    // multi-second `session/load` would otherwise leave a freshly
    // restored session in `byId` with no client holding its id.
    if (isCancelled()) {
      void cleanupRestoredSession();
      return { kind: 'cancelled' };
    }
    if (runtime.provenance !== 'live-conversation') {
      await reconcileRestoredSessionWorktree({
        runtime,
        workspaceCwd,
        sessionId,
        restoredStorageSessionId,
        session,
        deferRestoreAskUserQuestionPrompt,
        heldWorktreeOwnershipLockKey,
        assertRuntimeGenerationOpen,
        cleanupRestoredSession,
        daemonLog,
      });
    }
    if (isCancelled()) {
      await cleanupRestoredSession();
      return { kind: 'cancelled' };
    }
    try {
      assertRuntimeGenerationOpen?.();
    } catch (error) {
      await cleanupRestoredSession();
      throw error;
    }
    const deferredRestorePromptAdmitted =
      deferRestoreAskUserQuestionPrompt &&
      (runtime.bridge.fireDeferredRestoreAskUserQuestionPrompt?.(
        session.sessionId,
        session.clientId,
      ) ??
        false);
    if (deferredRestorePromptAdmitted) {
      session.hasActivePrompt = true;
    } else if (
      deferRestoreAskUserQuestionPrompt &&
      action === 'load' &&
      !session.attached &&
      !session.hasActivePrompt &&
      runtime.provenance !== 'live-conversation'
    ) {
      try {
        await reconcileDanglingPromptTerminals(
          createWorkspaceRuntimeSessionService(runtime),
          sessionId,
        );
      } catch {
        // Best-effort: a failure leaves dangling prompts unknown
        // (fail-closed) and must never fail the load itself.
      }
    }
    try {
      assertRuntimeGenerationOpen?.();
    } catch (error) {
      await cleanupRestoredSession();
      throw error;
    }
    daemonLog?.info(
      `session ${action}${session.attached ? ' (attached)' : ''}`,
      { sessionId: session.sessionId, clientId: session.clientId },
    );
    // The load response embeds the replay snapshot inline; redact the
    // skill bodies there just like the SSE egress does (#9234).
    const responseSession = withPromptTerminals(
      session,
      action === 'load'
        ? readRecentPromptTerminals(
            createWorkspaceRuntimeSessionService(runtime),
            sessionId,
          )
        : undefined,
    );
    return { kind: 'restored', session: responseSession };
  } finally {
    sessionIdReservation?.release();
    releaseWorktreeRestore?.();
  }
}
