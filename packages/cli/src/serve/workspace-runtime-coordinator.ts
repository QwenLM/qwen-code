/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SERVE_CONTROL_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  type ServeWorkspaceRuntimeCapabilityStatus,
  type ServeWorkspaceRuntimeStatus,
  type ServeWorkspaceSkillsRefreshResult,
} from '@qwen-code/acp-bridge/status';
import type {
  AcpSessionBridge,
  BridgeWorkspaceRuntimeLifecycleSnapshot,
} from './acp-session-bridge.js';
import { WorkspaceDrainingError } from './acp-session-bridge.js';
import type { WorkspaceRuntime } from './workspace-registry.js';

const DEFAULT_ENSURE_TIMEOUT_MS = 60_000;
const ENSURE_KEEP_ALIVE_MS = 10 * 60_000;

type LifecycleAcpSessionBridge = AcpSessionBridge & {
  getWorkspaceRuntimeLifecycleSnapshot(): BridgeWorkspaceRuntimeLifecycleSnapshot;
};

export class WorkspaceRuntimeStillStartingError extends Error {
  constructor() {
    super('Workspace runtime is still starting');
    this.name = 'WorkspaceRuntimeStillStartingError';
  }
}

export class WorkspaceRuntimeInitializationError extends Error {
  constructor(cause: unknown) {
    super('Workspace runtime failed to initialize', { cause });
    this.name = 'WorkspaceRuntimeInitializationError';
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new WorkspaceRuntimeStillStartingError()),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function supportsWorkspaceRuntimeLifecycle(
  bridge: AcpSessionBridge,
): bridge is LifecycleAcpSessionBridge {
  return typeof bridge.getWorkspaceRuntimeLifecycleSnapshot === 'function';
}

export class WorkspaceRuntimeCoordinator {
  private disposed = false;

  private draining = false;

  private activeManagementOperations = 0;

  private skillsRevision = 0;

  private skillsStatus: ServeWorkspaceRuntimeCapabilityStatus = {
    state: 'not_started',
    revision: 0,
  };

  private skillsReconcileDeferred = false;

  private skillsTail: Promise<void> = Promise.resolve();

  private skillsQueuedWork = 0;

  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly bridge: LifecycleAcpSessionBridge,
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  cancelDrain(): void {
    if (this.disposed) return;
    this.draining = false;
    if (this.skillsReconcileDeferred) {
      this.skillsReconcileDeferred = false;
      this.scheduleSkillsReconciliation();
    }
  }

  hasActiveWork(): boolean {
    return (
      this.activeManagementOperations > 0 ||
      this.skillsQueuedWork > 0 ||
      this.bridge.getWorkspaceRuntimeLifecycleSnapshot().activeWork
    );
  }

  dispose(): void {
    this.disposed = true;
    this.draining = true;
  }

  status(): ServeWorkspaceRuntimeStatus {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    const skillsStatus =
      this.skillsStatus.runtimeEpoch !== undefined &&
      (!snapshot.runtimeLive ||
        this.skillsStatus.runtimeEpoch !== snapshot.runtimeEpoch)
        ? {
            state: 'stale' as const,
            revision: this.skillsStatus.revision,
            runtimeEpoch: this.skillsStatus.runtimeEpoch,
          }
        : this.skillsStatus;
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd: this.runtime.workspaceCwd,
      state: snapshot.state,
      runtimeLive: snapshot.runtimeLive,
      runtimeEpoch: snapshot.runtimeEpoch,
      capabilities: { skills: skillsStatus },
    };
  }

  async ensure(
    timeoutMs = DEFAULT_ENSURE_TIMEOUT_MS,
  ): Promise<ServeWorkspaceRuntimeStatus> {
    this.assertAcceptingWork();
    const deadline = Date.now() + timeoutMs;
    try {
      await withTimeout(
        this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS }),
        timeoutMs,
      );
    } catch (error) {
      this.assertAcceptingWork(error);
      if (error instanceof WorkspaceRuntimeStillStartingError) throw error;
      throw new WorkspaceRuntimeInitializationError(error);
    }
    this.assertAcceptingWork();
    const status = this.status();
    if (!status.runtimeLive) {
      throw new WorkspaceRuntimeInitializationError(
        new Error('ACP preheat completed without a live runtime'),
      );
    }
    if (
      status.capabilities?.skills?.state === 'ready' &&
      status.capabilities.skills.runtimeEpoch === status.runtimeEpoch
    ) {
      return status;
    }
    try {
      await withTimeout(
        this.prepareSkills(),
        Math.max(0, deadline - Date.now()),
      );
    } catch (error) {
      this.assertAcceptingWork(error);
      if (!(error instanceof WorkspaceRuntimeStillStartingError)) throw error;
    }
    const finalStatus = this.status();
    if (!finalStatus.runtimeLive) {
      throw new WorkspaceRuntimeInitializationError(
        new Error('Workspace runtime stopped during Skills preparation'),
      );
    }
    return finalStatus;
  }

  async runManagementOperation<T>(run: () => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    this.activeManagementOperations += 1;
    try {
      return await run();
    } finally {
      this.activeManagementOperations -= 1;
    }
  }

  reconcileSkillsConfiguration(): 'deferred' | 'reconciling' {
    this.skillsRevision += 1;
    return this.scheduleSkillsReconciliation();
  }

  private scheduleSkillsReconciliation(): 'deferred' | 'reconciling' {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive || this.draining || this.disposed) {
      this.skillsReconcileDeferred ||= snapshot.runtimeLive && this.draining;
      this.skillsStatus = {
        state:
          this.skillsStatus.runtimeEpoch === undefined
            ? 'not_started'
            : 'stale',
        revision: this.skillsRevision,
        ...(this.skillsStatus.runtimeEpoch === undefined
          ? {}
          : { runtimeEpoch: this.skillsStatus.runtimeEpoch }),
      };
      return 'deferred';
    }
    const revision = this.skillsRevision;
    this.skillsStatus = {
      state: 'starting',
      revision,
      runtimeEpoch: snapshot.runtimeEpoch,
    };
    void this.queueSkillsWork(async () => {
      if (revision !== this.skillsRevision) return;
      const result =
        await this.bridge.invokeWorkspaceCommand<ServeWorkspaceSkillsRefreshResult>(
          SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
          { cwd: this.runtime.workspaceCwd, reason: 'all' },
        );
      if ((result.configsFailed ?? 0) > 0) {
        throw new Error('Skills runtime refresh failed');
      }
      await this.prepareSkillsRevision(revision);
    }).catch((error: unknown) => {
      if (this.draining && !this.disposed) this.skillsReconcileDeferred = true;
      this.recordSkillsError(revision, snapshot.runtimeEpoch, error);
    });
    return 'reconciling';
  }

  private prepareSkills(): Promise<void> {
    return this.queueSkillsWork(async () => {
      const status = this.status();
      if (
        status.capabilities?.skills?.state === 'ready' &&
        status.capabilities.skills.runtimeEpoch === status.runtimeEpoch
      ) {
        return;
      }
      await this.prepareSkillsRevision(this.skillsRevision);
    });
  }

  private queueSkillsWork<T>(run: () => Promise<T>): Promise<T> {
    this.skillsQueuedWork += 1;
    const operation = this.skillsTail
      .catch(() => undefined)
      .then(async () => {
        this.assertAcceptingWork();
        return await run();
      })
      .finally(() => {
        this.skillsQueuedWork -= 1;
      });
    this.skillsTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async prepareSkillsRevision(revision: number): Promise<void> {
    let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive) {
      await withTimeout(
        this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS }),
        DEFAULT_ENSURE_TIMEOUT_MS,
      );
      snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    }
    const runtimeEpoch = snapshot.runtimeEpoch;
    if (revision !== this.skillsRevision) return;
    this.skillsStatus = { state: 'starting', revision, runtimeEpoch };
    try {
      this.runtime.workspaceService.invalidateWorkspaceSkillsStatus();
      const status =
        await this.runtime.workspaceService.getWorkspaceSkillsRuntimeStatus({
          route: 'workspace runtime Skills preparation',
          workspaceCwd: this.runtime.workspaceCwd,
        });
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (revision !== this.skillsRevision) return;
      if (
        this.draining ||
        !current.runtimeLive ||
        current.runtimeEpoch !== runtimeEpoch ||
        status.runtimeEpoch !== runtimeEpoch
      ) {
        this.skillsStatus = { state: 'stale', revision, runtimeEpoch };
        return;
      }
      if (status.errors?.length) {
        throw new Error(
          status.errors?.[0]?.error ??
            'Skills runtime did not return a live snapshot',
        );
      }
      if (!status.initialized) {
        this.skillsStatus = { state: 'stale', revision, runtimeEpoch };
        return;
      }
      this.skillsStatus = { state: 'ready', revision, runtimeEpoch };
    } catch (error) {
      this.recordSkillsError(revision, runtimeEpoch, error);
    }
  }

  private recordSkillsError(
    revision: number,
    runtimeEpoch: number,
    error: unknown,
  ): void {
    const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (revision !== this.skillsRevision) return;
    if (
      this.draining ||
      !current.runtimeLive ||
      current.runtimeEpoch !== runtimeEpoch
    ) {
      this.skillsStatus = { state: 'stale', revision, runtimeEpoch };
      return;
    }
    this.skillsStatus = {
      state: 'error',
      revision,
      runtimeEpoch,
      error: {
        code: 'skills_prepare_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  private assertAcceptingWork(cause?: unknown): void {
    this.runtime.generationGuard?.assertOpen();
    if (this.disposed || this.draining) {
      throw new WorkspaceDrainingError(this.runtime.workspaceCwd, cause);
    }
  }
}

export function getWorkspaceRuntimeCoordinatorIfSupported(
  runtime: WorkspaceRuntime,
): WorkspaceRuntimeCoordinator | undefined {
  if (!supportsWorkspaceRuntimeLifecycle(runtime.bridge)) return undefined;
  runtime.runtimeCoordinator ??= new WorkspaceRuntimeCoordinator(
    runtime,
    runtime.bridge,
  );
  return runtime.runtimeCoordinator;
}

export function getWorkspaceRuntimeCoordinator(
  runtime: WorkspaceRuntime,
): WorkspaceRuntimeCoordinator {
  const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
  if (!coordinator) {
    throw new Error('Workspace runtime lifecycle is not supported');
  }
  return coordinator;
}
