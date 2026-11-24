/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  GitWorktreeService,
  hasHiddenIndexBit,
  worktreeHasPendingGitOperation,
  worktreeHasPopulatedGitlink,
} from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import {
  selectWorktreeSnapshot,
  verifyRestoredWorktreeSnapshot,
  type WorktreeSnapshotPaths,
} from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import {
  inspectSessionRuntimeLiveness,
  readWorktreeSessionStrict,
  writeWorktreeSession,
} from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { SessionOrganizationService } from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import { readCronTasks } from '@qwen-code/qwen-code-core/services/cronTasksFile.js';
import { collectBoundSessionIds } from '../scheduled-task-keepalive.js';
import { readSettingsSnapshot } from '../../config/settings.js';
import { normalizeSessionIdForLookup } from '../../config/session-id.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import type { SessionArchiveCoordinator } from './session-archive.js';
import {
  canonicalPathForTesting,
  executeWorktreeCleanup,
  preclassifyWorktreeCleanup,
  verifyWorktreeCleanupOwnership,
  acquireWorktreeCleanupLock,
  type WorktreeCleanupPlan,
} from './worktree-orphan-cleanup.js';
import { sessionLiveOnBridge } from './session-archive.js';
import {
  reconcileUnrecordedRemovedWorktree,
  resolveManagedWorktreePath,
} from './worktree-snapshot-binding.js';
import {
  createWorkspaceRuntimeSessionService,
  runWithWorkspaceRuntimeStorage,
} from '../workspace-runtime-storage.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { safeLogValue } from './request-helpers.js';

const DEFAULT_RETENTION_COUNT = 15;
const RETENTION_INTERVAL_MS = 30_000;

export interface RetentionScope {
  runtime: WorkspaceRuntime;
  root: string | undefined;
  /**
   * Managed worktree directories belonging to this runtime: the repository
   * top-level root (shared-root collision key) plus the workspace cwd root
   * when registered at a monorepo subdirectory.
   */
  managedRoots: ReadonlySet<string>;
  limit: number;
  /** An attested root with unreadable settings blocks only that root. */
  settingsError?: string;
  /** A non-active, non-removed sibling workspace (transitioning/blocked/draining) shares this root. */
  sharedWithNonActive?: boolean;
}

export interface WorktreeRetentionReport {
  removed: string[];
  skipped: string[];
  issues: string[];
}

function retentionLimit(runtime: WorkspaceRuntime): number {
  const environment = runtime.env.effectiveEnv;
  if (!environment) {
    throw new Error(
      'workspace environment is unavailable; retention is paused',
    );
  }
  const settings = readSettingsSnapshot(runtime.workspaceCwd, {
    environment: runtime.env.effectiveEnv,
    workspaceTrusted: runtime.trusted,
  });
  const activeLayers = [
    settings.systemDefaults.settings,
    settings.user.settings,
    ...(runtime.trusted ? [settings.workspace.settings] : []),
    settings.system.settings,
    settings.merged,
  ];
  for (const layer of activeLayers) {
    const section: unknown = (layer as Record<string, unknown>)['worktree'];
    if (
      section !== undefined &&
      (section === null ||
        typeof section !== 'object' ||
        Array.isArray(section))
    ) {
      throw new Error(
        'worktree settings must be an object; retention is paused',
      );
    }
  }
  const configuredLimit = settings.merged.worktree?.maxRetained;
  const value =
    configuredLimit === undefined ? DEFAULT_RETENTION_COUNT : configuredLimit;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      'worktree.maxRetained must be a nonnegative safe integer; retention is paused',
    );
  }
  return value;
}

async function retentionRoot(
  workspaceCwd: string,
): Promise<string | undefined> {
  const service = new GitWorktreeService(workspaceCwd);
  const repoTop = await service.getRepoTopLevel();
  if (repoTop === null) {
    let directory = resolveManagedWorktreePath(workspaceCwd);
    for (;;) {
      try {
        await fs.lstat(path.join(directory, '.git'));
        throw new Error(
          `Git metadata exists but the repository root is unavailable: ${workspaceCwd}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
  const managedRootService = new GitWorktreeService(
    canonicalPathForTesting(repoTop),
  );
  return resolveManagedWorktreePath(managedRootService.getUserWorktreesDir());
}

/**
 * A live owner outside this daemon (for example a TUI that resumed the same
 * session) never appears on this runtime's bridge, but its runtime record
 * names the checkout it is working in. Search only the runtime bases (not the
 * arbitrary repository source tree, which would stall retention on large repos
 * or unreadable source subdirectories): `missing` is what daemon-created chats
 * return, while `active` or `unknown` (an unreadable, corrupt, newer-schema,
 * or foreign-host/namespace record) preserves the checkout.
 */
async function ownerProcessActive(
  sessionId: string,
  sidecar: { originalCwd: string; worktreePath: string; workspaceCwd?: string },
): Promise<boolean> {
  try {
    const roots = [
      sidecar.originalCwd,
      sidecar.worktreePath,
      ...(sidecar.workspaceCwd ? [sidecar.workspaceCwd] : []),
    ];
    const normalized = normalizeSessionIdForLookup(sessionId);
    const ids =
      normalized === sessionId ? [sessionId] : [sessionId, normalized];
    for (const candidateId of ids) {
      const inspected = await inspectSessionRuntimeLiveness(
        candidateId,
        roots,
        { scanProjectRoots: false },
      );
      if (inspected === 'active' || inspected === 'unknown') {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * A linked worktree (or a subdirectory inside it) can be registered as its own
 * daemon workspace. Its own `git rev-parse --show-toplevel` names the linked
 * worktree rather than the primary repository, so root equality does not detect
 * it. Never sweep a checkout that contains any registered workspace.
 */
function hasRegisteredWorkspaceInsideCheckout(
  registry: WorkspaceRegistry,
  checkoutPath: string,
): boolean {
  const foldsCase =
    process.platform === 'win32' || process.platform === 'darwin';
  const normalizePath = (value: string) =>
    foldsCase ? value.toLowerCase() : value;
  const realCheckout = normalizePath(resolveManagedWorktreePath(checkoutPath));
  for (const entry of registry.listEntries()) {
    const realWorkspace = normalizePath(
      resolveManagedWorktreePath(entry.workspaceCwd),
    );
    if (
      realWorkspace === realCheckout ||
      realWorkspace.startsWith(realCheckout + path.sep)
    ) {
      return true;
    }
  }
  return false;
}

function assertCurrentRuntime(
  registry: WorkspaceRegistry,
  runtime: WorkspaceRuntime,
  canContinue: () => boolean,
): boolean {
  if (!canContinue()) return false;
  const entry = registry.getManagedEntryByWorkspaceId(runtime.workspaceId);
  if (
    entry?.state !== 'active' ||
    entry.current?.runtime !== runtime ||
    entry.current.guard.closed
  ) {
    return false;
  }
  try {
    entry.current.guard.assertOpen();
    return true;
  } catch {
    return false;
  }
}

async function loadScopes(
  runtime: WorkspaceRuntime,
  registry: WorkspaceRegistry,
): Promise<RetentionScope[] | undefined> {
  if (retentionLimit(runtime) === 0) return undefined;
  const scopes: RetentionScope[] = [];
  for (const candidate of registry.list()) {
    // Root discovery also covers maxRetained=0: conflicts still block all
    // automatic reclamation shared by more than one runtime.
    const root = await retentionRoot(candidate.workspaceCwd);
    if (root === undefined) continue;
    // Untrusted scopes are never swept, but their roots still count in the
    // collision proof; their separately managed records must not be ignored.
    let limit = 0;
    let settingsError: string | undefined;
    try {
      limit = retentionLimit(candidate);
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
    const workspaceManagedRoot = resolveManagedWorktreePath(
      new GitWorktreeService(
        canonicalPathForTesting(candidate.workspaceCwd),
      ).getUserWorktreesDir(),
    );
    scopes.push({
      runtime: candidate,
      root,
      managedRoots: new Set([root, workspaceManagedRoot]),
      limit,
      ...(settingsError === undefined ? {} : { settingsError }),
    });
  }
  // Registered siblings in transitioning/blocked/draining states are omitted
  // from registry.list() but still claim their management root until removed.
  const nonActiveRoots = new Set<string>();
  for (const entry of registry.listEntries()) {
    if (entry.state === 'active') continue;
    const root = await retentionRoot(entry.workspaceCwd);
    if (root !== undefined) nonActiveRoots.add(root);
  }
  for (const scope of scopes) {
    if (scope.root !== undefined && nonActiveRoots.has(scope.root)) {
      scope.sharedWithNonActive = true;
    }
  }
  writeStderrLine(
    `qwen serve: retention scopes=${JSON.stringify(
      scopes.map((scope) => ({
        id: scope.runtime.workspaceId,
        primary: scope.runtime.primary,
        trusted: scope.runtime.trusted,
        root: scope.root,
        limit: scope.limit,
      })),
    )}`,
  );
  return scopes;
}

async function candidateActivityNs(
  service: ReturnType<typeof createWorkspaceRuntimeSessionService>,
  plan: WorktreeCleanupPlan,
): Promise<bigint> {
  const archiveState =
    plan.sidecarPath === service.getWorktreeSessionPath(plan.sessionId)
      ? 'active'
      : 'archived';
  const promptTime = await service.getLastUserPromptAt(
    plan.sessionId,
    archiveState,
  );
  if (promptTime !== undefined) {
    const milliseconds = Date.parse(promptTime);
    if (!Number.isFinite(milliseconds)) {
      throw new Error('invalid persisted session timestamp');
    }
    return BigInt(milliseconds) * 1_000_000n;
  }
  const transcriptPath = path.join(
    path.dirname(plan.sidecarPath),
    `${plan.sessionId}.jsonl`,
  );
  try {
    return (await fs.lstat(transcriptPath, { bigint: true })).mtimeNs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return (await fs.lstat(plan.sidecarPath, { bigint: true })).mtimeNs;
  }
}

async function isRetentionSessionPinned(
  organization: SessionOrganizationService,
  sessionId: string,
): Promise<boolean> {
  return organization.isSessionPinnedStrict(sessionId);
}

async function boundRetentionSessionIds(
  runtime: WorkspaceRuntime,
): Promise<ReadonlySet<string>> {
  const bound = new Set<string>();
  for (const id of collectBoundSessionIds(
    await readCronTasks(runtime.workspaceCwd),
  )) {
    bound.add(id);
    bound.add(normalizeSessionIdForLookup(id));
  }
  return bound;
}

function isSessionBound(
  boundSessions: ReadonlySet<string>,
  sessionId: string,
): boolean {
  return (
    boundSessions.has(sessionId) ||
    boundSessions.has(normalizeSessionIdForLookup(sessionId))
  );
}

async function collectEligible(
  scope: RetentionScope,
  registry: WorkspaceRegistry,
  service: ReturnType<typeof createWorkspaceRuntimeSessionService>,
  coordinator: SessionArchiveCoordinator,
  report: WorktreeRetentionReport,
): Promise<WorktreeCleanupPlan[]> {
  const boundSessions = await boundRetentionSessionIds(scope.runtime);
  const candidates: Array<WorktreeCleanupPlan & { activityNs: bigint }> = [];
  const seen = new Set<string>();
  const archiveStates = ['active', 'archived'] as const;
  const entriesByState = new Map<(typeof archiveStates)[number], string[]>();
  const locationsByLowerId = new Map<string, Set<string>>();
  for (const archiveState of archiveStates) {
    const directory = path.dirname(
      service.getWorktreeSessionPathForArchiveState('', archiveState),
    );
    let entries: string[];
    try {
      entries = (await fs.readdir(directory)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    entriesByState.set(archiveState, entries);
    for (const entry of entries) {
      let id: string | undefined;
      if (entry.endsWith('.worktree.json')) {
        id = entry.slice(0, -'.worktree.json'.length);
      } else if (entry.endsWith('.jsonl')) {
        id = entry.slice(0, -'.jsonl'.length);
      }
      if (!id) continue;
      const lower = id.toLowerCase();
      let set = locationsByLowerId.get(lower);
      if (!set) {
        set = new Set<string>();
        locationsByLowerId.set(lower, set);
      }
      set.add(`${archiveState}:${id}`);
    }
  }
  for (const archiveState of archiveStates) {
    const entries = entriesByState.get(archiveState);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.endsWith('.worktree.json')) continue;
      const sessionId = entry.slice(0, -'.worktree.json'.length);
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const caseVariants = locationsByLowerId.get(sessionId.toLowerCase());
      const location = await service.getMaintainableSessionLocation(sessionId);
      const otherState = archiveState === 'active' ? 'archived' : 'active';
      const otherSidecar = await fs
        .lstat(
          service.getWorktreeSessionPathForArchiveState(sessionId, otherState),
        )
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
      if (
        (caseVariants?.size ?? 0) > 1 ||
        location !== archiveState ||
        otherSidecar !== null
      ) {
        report.skipped.push(
          `session archive location is not unique: ${sessionId}`,
        );
        continue;
      }
      const plan = await preclassifyWorktreeCleanup(
        service,
        sessionId,
        scope.runtime.workspaceCwd,
      );
      if (!plan || plan.sidecar.worktreeRemoved !== undefined) continue;
      const planRoot = resolveManagedWorktreePath(
        new GitWorktreeService(plan.sidecar.originalCwd).getUserWorktreesDir(),
      );
      if (!scope.managedRoots.has(planRoot)) {
        throw new Error('management root is not attested to this runtime');
      }
      const organization = new SessionOrganizationService(
        scope.runtime.workspaceCwd,
      );
      if (sessionLiveOnBridge(scope.runtime.bridge, sessionId)) {
        continue;
      }
      if (hasRegisteredWorkspaceInsideCheckout(registry, plan.lockKey)) {
        continue;
      }
      if (await ownerProcessActive(sessionId, plan.sidecar)) continue;
      if (await isRetentionSessionPinned(organization, sessionId)) continue;
      const release = await acquireWorktreeCleanupLock(plan);
      try {
        const eligibility = await coordinator.runExclusiveMany(
          [sessionId],
          async () => {
            const ownership = await verifyWorktreeCleanupOwnership(plan, (id) =>
              sessionLiveOnBridge(scope.runtime.bridge, id),
            );
            const claimed =
              sessionLiveOnBridge(scope.runtime.bridge, sessionId) ||
              isSessionBound(boundSessions, sessionId);
            if (!claimed && ownership.ok) return 'eligible';
            if (claimed) return 'ineligible';
            return (await reconcileUnrecordedRemovedWorktree(
              service,
              plan.sessionId,
              plan.sidecarPath,
              plan.lockKey,
              planRoot,
              (id) => sessionLiveOnBridge(scope.runtime.bridge, id),
            ))
              ? 'reconciled'
              : 'ineligible';
          },
        );
        if (eligibility === 'ineligible') continue;
        if (eligibility === 'reconciled') {
          report.skipped.push(
            `worktree removal record reconciled from snapshot: ${sessionId}`,
          );
          continue;
        }
      } catch {
        // A moved sidecar or an archive transition only makes this advisory
        // candidate ineligible; the locked deletion check remains decisive.
        continue;
      } finally {
        release();
      }
      candidates.push({
        ...plan,
        activityNs: await candidateActivityNs(service, plan),
      });
    }
  }
  return candidates
    .sort(
      (a, b) =>
        (a.activityNs === b.activityNs
          ? 0
          : a.activityNs < b.activityNs
            ? 1
            : -1) ||
        (a.lockKey < b.lockKey ? -1 : a.lockKey > b.lockKey ? 1 : 0),
    )
    .slice(scope.limit)
    .reverse()
    .map(({ activityNs: _activityNs, ...plan }) => plan);
}

async function discardPreservedAttemptSnapshot(
  runtime: WorkspaceRuntime,
  registry: WorkspaceRegistry,
  plan: WorktreeCleanupPlan,
  snapshot: NonNullable<
    Awaited<ReturnType<typeof executeWorktreeCleanup>>['snapshot']
  >,
  canContinue: () => boolean,
): Promise<void> {
  const service = createWorkspaceRuntimeSessionService(runtime);
  const current = await preclassifyWorktreeCleanup(
    service,
    plan.sessionId,
    runtime.workspaceCwd,
  );
  if (!current || current.sidecar.worktreeRemoved !== undefined) return;
  const ownership = await verifyWorktreeCleanupOwnership(current, (id) =>
    sessionLiveOnBridge(runtime.bridge, id),
  );
  if (!ownership.ok) return;
  if (!assertCurrentRuntime(registry, runtime, canContinue)) {
    return;
  }
  // Restrict deletion to the pair created by this attempt. Pre-existing or
  // other-session archives are never promoted or pruned as orphans.
  const selected = await selectWorktreeSnapshot({
    directory: path.dirname(plan.sidecarPath),
    sessionId: plan.sessionId,
    slug: plan.sidecar.slug,
    archiveKey: path.basename(snapshot.snapshotPath),
  });
  if (
    !selected ||
    selected.snapshotPath !== snapshot.snapshotPath ||
    selected.metaPath !== snapshot.metaPath
  ) {
    return;
  }
  const [hiddenIndex, pending, populatedGitlink] = await Promise.all([
    hasHiddenIndexBit(current.lockKey),
    worktreeHasPendingGitOperation(current.lockKey),
    worktreeHasPopulatedGitlink(current.lockKey),
  ]);
  if (hiddenIndex || pending || populatedGitlink) return;
  if (
    !(await verifyRestoredWorktreeSnapshot({
      worktreePath: current.lockKey,
      snapshotPath: selected.snapshotPath,
      meta: selected.meta,
    }))
  ) {
    return;
  }
  // Pin/liveness vetoes checkout removal. It does not require keeping an
  // already redundant pair once ownership and the intact checkout are proven.
  if (
    !assertCurrentRuntime(registry, runtime, canContinue) ||
    !(
      await verifyWorktreeCleanupOwnership(current, (id) =>
        sessionLiveOnBridge(runtime.bridge, id),
      )
    ).ok
  ) {
    return;
  }
  await fs.unlink(selected.metaPath);
  await fs.unlink(selected.snapshotPath);
}

async function persistRetainedAttemptBinding(
  plan: WorktreeCleanupPlan,
  snapshot: WorktreeSnapshotPaths,
): Promise<void> {
  const archiveKey = path.basename(snapshot.snapshotPath);
  const selected = await selectWorktreeSnapshot({
    directory: path.dirname(plan.sidecarPath),
    sessionId: plan.sessionId,
    slug: plan.sidecar.slug,
    archiveKey,
  });
  if (
    !selected ||
    selected.snapshotPath !== snapshot.snapshotPath ||
    selected.metaPath !== snapshot.metaPath
  ) {
    throw new Error('The retained snapshot pair is incomplete');
  }
  if (
    !(await verifyRestoredWorktreeSnapshot({
      worktreePath: plan.lockKey,
      snapshotPath: selected.snapshotPath,
      meta: selected.meta,
    }))
  ) {
    throw new Error('The checkout no longer matches the retained snapshot');
  }
  const current = await readWorktreeSessionStrict(plan.sidecarPath);
  // This binding must be durable before the destructive operation. A failed
  // write therefore abandons the removal rather than losing recovery state.
  if (
    current.state !== 'valid' ||
    (current.session.worktreeRemoved !== undefined &&
      current.session.worktreeRemoved.archiveKey !== archiveKey)
  ) {
    throw new Error('The worktree record changed before retention binding');
  }
  await writeWorktreeSession(plan.sidecarPath, {
    ...current.session,
    worktreeRemoved: { archiveKey },
  });
  const persisted = await readWorktreeSessionStrict(plan.sidecarPath);
  if (
    persisted.state !== 'valid' ||
    persisted.session.worktreeRemoved?.archiveKey !== archiveKey
  ) {
    throw new Error('The retained snapshot binding could not be persisted');
  }
}

async function clearRejectedAttemptBinding(
  runtime: WorkspaceRuntime,
  plan: WorktreeCleanupPlan,
  snapshot: WorktreeSnapshotPaths,
  removalAttempted: boolean,
): Promise<boolean> {
  const archiveKey = path.basename(snapshot.snapshotPath);
  const current = await readWorktreeSessionStrict(plan.sidecarPath);
  if (
    current.state !== 'valid' ||
    current.session.worktreeRemoved?.archiveKey !== archiveKey ||
    !(
      await verifyWorktreeCleanupOwnership(plan, (id) =>
        sessionLiveOnBridge(runtime.bridge, id),
      )
    ).ok
  ) {
    return false;
  }
  // A late prune or branch cleanup might have partly removed the checkout.
  if (removalAttempted) {
    const selected = await selectWorktreeSnapshot({
      directory: path.dirname(plan.sidecarPath),
      sessionId: plan.sessionId,
      slug: plan.sidecar.slug,
      archiveKey,
    });
    if (
      !selected ||
      selected.snapshotPath !== snapshot.snapshotPath ||
      selected.metaPath !== snapshot.metaPath ||
      !(await verifyRestoredWorktreeSnapshot({
        worktreePath: plan.lockKey,
        snapshotPath: snapshot.snapshotPath,
        meta: selected.meta,
      }))
    ) {
      return false;
    }
  }
  const restored = { ...current.session };
  delete restored.worktreeRemoved;
  await writeWorktreeSession(plan.sidecarPath, restored);
  const persisted = await readWorktreeSessionStrict(plan.sidecarPath);
  return (
    persisted.state === 'valid' &&
    persisted.session.worktreeRemoved === undefined
  );
}

async function removeRetainedCheckout(
  runtime: WorkspaceRuntime,
  registry: WorkspaceRegistry,
  coordinator: SessionArchiveCoordinator,
  plan: WorktreeCleanupPlan,
  expectedRoot: RetentionScope['root'],
  canContinue: () => boolean,
): Promise<boolean> {
  const release = await acquireWorktreeCleanupLock(plan);
  try {
    return await coordinator.runExclusiveMany([plan.sessionId], async () => {
      const ownership = await verifyWorktreeCleanupOwnership(plan, (id) =>
        sessionLiveOnBridge(runtime.bridge, id),
      );
      if (!ownership.ok || plan.sidecar.worktreeRemoved !== undefined) {
        return false;
      }
      const organization = new SessionOrganizationService(runtime.workspaceCwd);
      if (await isRetentionSessionPinned(organization, plan.sessionId)) {
        return false;
      }
      let attemptSnapshot: WorktreeSnapshotPaths | undefined;
      let physicalRemovalEntered = false;
      let outcome: Awaited<ReturnType<typeof executeWorktreeCleanup>>;
      try {
        outcome = await executeWorktreeCleanup(plan, {
          requireSnapshot: true,
          beforeRemoval: async (snapshot) => {
            if (!assertCurrentRuntime(registry, runtime, canContinue)) {
              return false;
            }
            if (await isRetentionSessionPinned(organization, plan.sessionId)) {
              return false;
            }
            if (sessionLiveOnBridge(runtime.bridge, plan.sessionId))
              return false;
            if (hasRegisteredWorkspaceInsideCheckout(registry, plan.lockKey))
              return false;
            if (await ownerProcessActive(plan.sessionId, plan.sidecar))
              return false;
            if (
              isSessionBound(
                await boundRetentionSessionIds(runtime),
                plan.sessionId,
              )
            ) {
              return false;
            }
            if (snapshot) {
              attemptSnapshot = snapshot;
              await persistRetainedAttemptBinding(plan, snapshot);
            }
            return true;
          },
          beforePhysicalRemoval: async () => {
            if (
              !runtime.trusted ||
              expectedRoot === undefined ||
              !assertCurrentRuntime(registry, runtime, canContinue)
            ) {
              return false;
            }
            const scopes = await loadScopes(runtime, registry);
            if (!scopes) return false;
            const current = scopes.find(
              (candidate) => candidate.runtime === runtime,
            );
            if (current?.root !== expectedRoot || current.sharedWithNonActive) {
              return false;
            }
            const evaluated = new Set(
              scopes.map((candidate) => candidate.runtime.workspaceId),
            );
            for (const entry of registry.listEntries()) {
              if (
                entry.state === 'active' &&
                evaluated.has(entry.workspaceId)
              ) {
                continue;
              }
              if (entry.workspaceId === runtime.workspaceId) {
                if (entry.state !== 'active') return false;
                continue;
              }
              const root = await retentionRoot(entry.workspaceCwd);
              if (root === expectedRoot) return false;
              // Plain non-Git workspaces are excluded only after the full ancestor
              // probe proves that absence, never when Git discovery is unreadable.
              evaluated.add(entry.workspaceId);
            }
            const latestEntries = registry.listEntries();
            if (
              latestEntries.some((entry) => !evaluated.has(entry.workspaceId))
            ) {
              return false;
            }
            if (
              !registry.list().includes(runtime) ||
              !assertCurrentRuntime(registry, runtime, canContinue)
            ) {
              return false;
            }
            const holders = scopes.filter(
              (candidate) => candidate.root === expectedRoot,
            );
            if (
              holders.length !== 1 ||
              holders[0]?.runtime !== runtime ||
              holders.some(
                (candidate) =>
                  candidate.settingsError !== undefined ||
                  candidate.sharedWithNonActive,
              )
            ) {
              return false;
            }
            // These reads intentionally follow the current scope discovery, rather
            // than repeating the stale state seen before binding persistence.
            const organization = new SessionOrganizationService(
              runtime.workspaceCwd,
            );
            if (await isRetentionSessionPinned(organization, plan.sessionId)) {
              return false;
            }
            if (sessionLiveOnBridge(runtime.bridge, plan.sessionId))
              return false;
            if (hasRegisteredWorkspaceInsideCheckout(registry, plan.lockKey))
              return false;
            if (await ownerProcessActive(plan.sessionId, plan.sidecar))
              return false;
            if (
              isSessionBound(
                await boundRetentionSessionIds(runtime),
                plan.sessionId,
              )
            ) {
              return false;
            }
            const allowed = runtime.trusted && canContinue();
            // Only the post-binding pass (after beforeRemoval assigned
            // attemptSnapshot) precedes removeUserWorktree.
            if (allowed && attemptSnapshot !== undefined) {
              physicalRemovalEntered = true;
            }
            return allowed;
          },
        });
      } catch (error) {
        if (attemptSnapshot && !physicalRemovalEntered) {
          await clearRejectedAttemptBinding(
            runtime,
            plan,
            attemptSnapshot,
            false,
          ).catch(() => undefined);
        }
        throw error;
      }
      if (outcome.removed) return outcome.snapshot !== undefined;
      if (
        attemptSnapshot &&
        !(await clearRejectedAttemptBinding(
          runtime,
          plan,
          attemptSnapshot,
          outcome.removal !== undefined,
        ))
      ) {
        return false;
      }
      if (
        outcome.snapshot?.checkoutMatchesCapture &&
        assertCurrentRuntime(registry, runtime, canContinue)
      ) {
        await discardPreservedAttemptSnapshot(
          runtime,
          registry,
          plan,
          outcome.snapshot,
          canContinue,
        );
      }
      return false;
    });
  } finally {
    release();
  }
}

export async function sweepWorktreeRetentionOnce(
  runtime: WorkspaceRuntime,
  registry: WorkspaceRegistry,
  coordinator: SessionArchiveCoordinator,
  canContinue: () => boolean = () => true,
): Promise<WorktreeRetentionReport> {
  return runWithWorkspaceRuntimeStorage(runtime, () =>
    sweepWorktreeRetentionOnceInStorage(
      runtime,
      registry,
      coordinator,
      canContinue,
    ),
  );
}

async function sweepWorktreeRetentionOnceInStorage(
  runtime: WorkspaceRuntime,
  registry: WorkspaceRegistry,
  coordinator: SessionArchiveCoordinator,
  canContinue: () => boolean,
): Promise<WorktreeRetentionReport> {
  const report: WorktreeRetentionReport = {
    removed: [],
    skipped: [],
    issues: [],
  };
  if (!runtime.trusted) {
    report.skipped.push('runtime is not trusted');
    return report;
  }
  if (!assertCurrentRuntime(registry, runtime, canContinue)) {
    const entry = registry.getManagedEntryByWorkspaceId(runtime.workspaceId);
    writeStderrLine(
      `qwen serve: retention inactive workspace=${safeLogValue(runtime.workspaceCwd)} id=${safeLogValue(runtime.workspaceId)} state=${safeLogValue(entry?.state)} identityMatch=${safeLogValue(entry?.current?.runtime === runtime)} guardClosed=${safeLogValue(entry?.current?.guard.closed)}`,
    );
    report.skipped.push('runtime is not active');
    return report;
  }
  const scopes = await loadScopes(runtime, registry);
  if (!scopes) return report;
  const scope = scopes.find((candidate) => candidate.runtime === runtime);
  if (!scope?.root || scopes.some((candidate) => !candidate.root)) {
    report.skipped.push('management root cannot be uniquely attested');
    return report;
  }
  const holders = scopes.filter((candidate) => candidate.root === scope.root);
  if (holders.some((candidate) => candidate.settingsError !== undefined)) {
    report.skipped.push('retention settings cannot be read for this root');
    return report;
  }
  if (
    holders.length !== 1 ||
    holders[0]?.runtime !== runtime ||
    scope.sharedWithNonActive
  ) {
    report.skipped.push('management root is shared');
    return report;
  }
  const service = createWorkspaceRuntimeSessionService(runtime);
  let candidates: WorktreeCleanupPlan[];
  try {
    candidates = await collectEligible(
      scope,
      registry,
      service,
      coordinator,
      report,
    );
  } catch (error) {
    report.issues.push(error instanceof Error ? error.message : String(error));
    return report;
  }
  writeStderrLine(
    `qwen serve: retention candidates workspace=${safeLogValue(runtime.workspaceCwd)} count=${candidates.length}`,
  );
  for (const plan of candidates) {
    if (!assertCurrentRuntime(registry, runtime, canContinue)) {
      report.skipped.push(`${plan.sessionId}: runtime drained`);
      continue;
    }
    try {
      const removed = await removeRetainedCheckout(
        runtime,
        registry,
        coordinator,
        plan,
        scope.root,
        canContinue,
      );
      if (removed) report.removed.push(plan.sessionId);
      else report.skipped.push(plan.sessionId);
    } catch (error) {
      report.issues.push(
        `${plan.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return report;
}

export interface WorktreeRetentionController {
  stop: () => Promise<void>;
  readonly activeWork: boolean;
}

export function startWorktreeRetention(
  runtime: WorkspaceRuntime,
  registry: WorkspaceRegistry,
  coordinator: SessionArchiveCoordinator,
  intervalMs = RETENTION_INTERVAL_MS,
): WorktreeRetentionController {
  writeStderrLine(
    `qwen serve: worktree retention scheduler start workspace=${safeLogValue(runtime.workspaceCwd)}`,
  );
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = runWithWorkspaceRuntimeStorage(runtime, () =>
      sweepWorktreeRetentionOnce(
        runtime,
        registry,
        coordinator,
        () => !stopped,
      ),
    )
      .then((result) => {
        for (const reason of [...result.skipped, ...result.issues]) {
          writeStderrLine(
            `qwen serve: worktree retention preserved state workspace=${safeLogValue(runtime.workspaceCwd)} reason=${safeLogValue(reason)}`,
          );
        }
      })
      .catch((error: unknown) => {
        writeStderrLine(
          `qwen serve: worktree retention paused workspace=${safeLogValue(runtime.workspaceCwd)} reason=${safeLogValue(error instanceof Error ? error.message : String(error))}`,
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    get activeWork() {
      return inFlight !== undefined;
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
