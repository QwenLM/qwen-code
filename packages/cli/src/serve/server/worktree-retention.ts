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
} from '@qwen-code/qwen-code-core/services/worktree-snapshot-service.js';
import {
  readWorktreeSessionStrict,
  writeWorktreeSession,
} from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { SessionOrganizationService } from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { readSettingsSnapshot } from '../../config/settings.js';
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
  limit: number;
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
  const value =
    settings.merged.worktree?.maxRetained ?? DEFAULT_RETENTION_COUNT;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      'worktree.maxRetained must be a nonnegative safe integer; retention is paused',
    );
  }
  return value;
}

async function retentionRoot(
  runtime: WorkspaceRuntime,
): Promise<string | undefined> {
  const service = new GitWorktreeService(runtime.workspaceCwd);
  const repoTop = await service.getRepoTopLevel();
  if (repoTop === null) return undefined;
  const managedRootService = new GitWorktreeService(
    canonicalPathForTesting(repoTop),
  );
  return canonicalPathForTesting(managedRootService.getUserWorktreesDir());
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
    scopes.push({
      runtime: candidate,
      root: await retentionRoot(candidate),
      limit: retentionLimit(candidate),
    });
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

async function collectEligible(
  scope: RetentionScope,
  service: ReturnType<typeof createWorkspaceRuntimeSessionService>,
): Promise<WorktreeCleanupPlan[]> {
  const candidates: Array<WorktreeCleanupPlan & { activityNs: bigint }> = [];
  const seen = new Set<string>();
  for (const directory of new Set([
    path.dirname(service.getWorktreeSessionPathForArchiveState('', 'active')),
    path.dirname(service.getWorktreeSessionPathForArchiveState('', 'archived')),
  ])) {
    let entries;
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.worktree.json')) continue;
      const sessionId = entry.slice(0, -'.worktree.json'.length);
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const plan = await preclassifyWorktreeCleanup(
        service,
        sessionId,
        scope.runtime.workspaceCwd,
      );
      if (!plan || plan.sidecar.worktreeRemoved !== undefined) continue;
      const planRoot = await retentionRoot(scope.runtime);
      if (planRoot !== scope.root) {
        throw new Error('management root is not attested to this runtime');
      }
      const organization = new SessionOrganizationService(
        scope.runtime.workspaceCwd,
      );
      if (await organization.isSessionPinnedStrict(sessionId)) continue;
      if (
        sessionLiveOnBridge(
          scope.runtime.bridge as Partial<
            Pick<AcpSessionBridge, 'getSessionSummary'>
          >,
          sessionId,
        )
      ) {
        continue;
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
  if (!(await assertCurrentRuntime(registry, runtime, canContinue))) {
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
  if (
    (await new SessionOrganizationService(
      runtime.workspaceCwd,
    ).isSessionPinnedStrict(plan.sessionId)) ||
    sessionLiveOnBridge(runtime.bridge, plan.sessionId)
  ) {
    return;
  }
  if (
    !(await assertCurrentRuntime(registry, runtime, canContinue)) ||
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

async function removeRetainedCheckout(
  runtime: WorkspaceRuntime,
  registry: WorkspaceRegistry,
  coordinator: SessionArchiveCoordinator,
  plan: WorktreeCleanupPlan,
  canContinue: () => boolean,
): Promise<boolean> {
  const release = await acquireWorktreeCleanupLock(plan);
  try {
    return await coordinator.runExclusiveMany([plan.sessionId], async () => {
      const ownership = await verifyWorktreeCleanupOwnership(plan, (id) =>
        sessionLiveOnBridge(runtime.bridge, id),
      );
      if (!ownership.ok) return false;
      const organization = new SessionOrganizationService(runtime.workspaceCwd);
      if (await organization.isSessionPinnedStrict(plan.sessionId)) {
        return false;
      }
      const outcome = await executeWorktreeCleanup(plan, {
        requireSnapshot: true,
        beforeRemoval: async () => {
          if (!assertCurrentRuntime(registry, runtime, canContinue)) {
            return false;
          }
          if (await organization.isSessionPinnedStrict(plan.sessionId)) {
            return false;
          }
          return !sessionLiveOnBridge(runtime.bridge, plan.sessionId);
        },
      });
      if (
        !outcome.removed &&
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
      if (!outcome.removed || !outcome.snapshot) return false;
      const archiveKey = path.basename(outcome.snapshot.snapshotPath);
      await writeWorktreeSession(plan.sidecarPath, {
        ...plan.sidecar,
        worktreeRemoved: { archiveKey },
      });
      const persisted = await readWorktreeSessionStrict(plan.sidecarPath);
      return (
        persisted.state === 'valid' &&
        persisted.session.worktreeRemoved?.archiveKey === archiveKey
      );
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
  const report: WorktreeRetentionReport = {
    removed: [],
    skipped: [],
    issues: [],
  };
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
  if (holders.length !== 1 || holders[0]?.runtime !== runtime) {
    report.skipped.push('management root is shared');
    return report;
  }
  const service = createWorkspaceRuntimeSessionService(runtime);
  let candidates: WorktreeCleanupPlan[];
  try {
    candidates = await collectEligible(scope, service);
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
