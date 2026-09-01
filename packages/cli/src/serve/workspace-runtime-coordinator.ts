/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  STATUS_SCHEMA_VERSION,
  type ServeWorkspaceRuntimeCapabilityStatus,
  type ServeWorkspaceRuntimeStatus,
} from '@qwen-code/acp-bridge/status';
import type {
  AcpSessionBridge,
  BridgeWorkspaceRuntimeLifecycleSnapshot,
} from './acp-session-bridge.js';
import { WorkspaceDrainingError } from './acp-session-bridge.js';
import type { WorkspaceRuntime } from './workspace-registry.js';

const DEFAULT_ENSURE_TIMEOUT_MS = 60_000;
const ENSURE_KEEP_ALIVE_MS = 10 * 60_000;
const MCP_PREPARE_TIMEOUT_MS = 2 * 60_000;
const MCP_POLL_INTERVAL_MS = 250;

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

  private mcpRevision = 0;

  private mcpConfigRevision = 0;

  private mcpStatus: ServeWorkspaceRuntimeCapabilityStatus = {
    state: 'not_started',
    revision: 0,
  };

  private mcpReconcileDeferred = false;

  private mcpPhysicalTail: Promise<void> = Promise.resolve();

  private mcpQueuedWork = 0;

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
    if (this.mcpReconcileDeferred) {
      this.mcpReconcileDeferred = false;
      this.scheduleMcpReconciliation();
    }
  }

  hasActiveWork(): boolean {
    return (
      this.activeManagementOperations > 0 ||
      this.mcpQueuedWork > 0 ||
      this.bridge.getWorkspaceRuntimeLifecycleSnapshot().activeWork
    );
  }

  dispose(): void {
    this.disposed = true;
    this.draining = true;
  }

  status(): ServeWorkspaceRuntimeStatus {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    const mcpStatus =
      this.mcpStatus.runtimeEpoch !== undefined &&
      (!snapshot.runtimeLive ||
        this.mcpStatus.runtimeEpoch !== snapshot.runtimeEpoch)
        ? {
            state: 'stale' as const,
            revision: this.mcpStatus.revision,
            runtimeEpoch: this.mcpStatus.runtimeEpoch,
          }
        : this.mcpStatus;
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd: this.runtime.workspaceCwd,
      state: snapshot.state,
      runtimeLive: snapshot.runtimeLive,
      runtimeEpoch: snapshot.runtimeEpoch,
      capabilities: { mcp: mcpStatus },
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
    const revision = this.mcpRevision;
    const preparation = this.prepareMcp();
    void preparation.catch((error: unknown) => {
      this.recordMcpError(revision, status.runtimeEpoch, error);
    });
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      try {
        await withTimeout(preparation, remainingMs);
      } catch (error) {
        if (!(error instanceof WorkspaceRuntimeStillStartingError)) throw error;
      }
    }
    return this.status();
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

  reconcileMcpConfiguration(): 'deferred' | 'reconciling' {
    this.mcpRevision += 1;
    this.mcpConfigRevision += 1;
    return this.scheduleMcpReconciliation();
  }

  private scheduleMcpReconciliation(): 'deferred' | 'reconciling' {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive || this.draining || this.disposed) {
      this.mcpReconcileDeferred ||= snapshot.runtimeLive && this.draining;
      this.mcpStatus = {
        state:
          this.mcpStatus.runtimeEpoch === undefined ? 'not_started' : 'stale',
        revision: this.mcpRevision,
        ...(this.mcpStatus.runtimeEpoch === undefined
          ? {}
          : { runtimeEpoch: this.mcpStatus.runtimeEpoch }),
      };
      return 'deferred';
    }
    this.mcpStatus = {
      state: 'starting',
      revision: this.mcpRevision,
      runtimeEpoch: snapshot.runtimeEpoch,
    };
    const revision = this.mcpRevision;
    const configRevision = this.mcpConfigRevision;
    void this.queueMcpWork(async () => {
      if (configRevision !== this.mcpConfigRevision) return;
      await this.bridge.reloadWorkspaceMcp();
      await this.prepareMcpRevision(revision);
    }).catch((error: unknown) => {
      if (this.draining && !this.disposed) this.mcpReconcileDeferred = true;
      this.recordMcpError(revision, snapshot.runtimeEpoch, error);
    });
    return 'reconciling';
  }

  async runMcpRuntimeMutation<T>(run: () => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    const revision = ++this.mcpRevision;
    const initial = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    this.mcpStatus = {
      state: initial.runtimeLive ? 'starting' : 'not_started',
      revision,
      ...(initial.runtimeLive ? { runtimeEpoch: initial.runtimeEpoch } : {}),
    };
    return await this.queueMcpWork(async () => {
      let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      let mutationRejected = false;
      try {
        if (!snapshot.runtimeLive) {
          await this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS });
          snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
          if (!snapshot.runtimeLive) {
            throw new WorkspaceRuntimeInitializationError(
              new Error('ACP preheat completed without a live runtime'),
            );
          }
        }
        if (revision === this.mcpRevision) {
          this.mcpStatus = {
            state: 'starting',
            revision,
            runtimeEpoch: snapshot.runtimeEpoch,
          };
        }
        let result: T;
        try {
          result = await run();
        } catch (error) {
          mutationRejected = true;
          void this.queueMcpWork(() => this.prepareMcpRevision(revision)).catch(
            (prepareError: unknown) => {
              this.recordMcpError(
                revision,
                snapshot.runtimeEpoch,
                prepareError,
              );
            },
          );
          throw error;
        }
        await this.prepareMcpRevision(revision);
        return result;
      } catch (error) {
        if (!mutationRejected) {
          this.recordMcpError(revision, snapshot.runtimeEpoch, error);
        }
        throw error;
      }
    });
  }

  private prepareMcp(): Promise<void> {
    const revision = this.mcpRevision;
    return this.queueMcpWork(() => this.prepareMcpRevision(revision));
  }

  private queueMcpWork<T>(run: () => Promise<T>): Promise<T> {
    this.mcpQueuedWork += 1;
    const operation = this.mcpPhysicalTail
      .catch(() => undefined)
      .then(async () => {
        this.assertAcceptingWork();
        return await run();
      })
      .finally(() => {
        this.mcpQueuedWork -= 1;
      });
    this.mcpPhysicalTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async prepareMcpRevision(revision: number): Promise<void> {
    const deadline = Date.now() + MCP_PREPARE_TIMEOUT_MS;
    let snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (!snapshot.runtimeLive) {
      await this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS });
      snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    }
    const epoch = snapshot.runtimeEpoch;
    if (revision !== this.mcpRevision) return;
    this.mcpStatus = { state: 'starting', revision, runtimeEpoch: epoch };
    try {
      let status = await this.runtime.workspaceService.getWorkspaceMcpStatus({
        route: 'workspace runtime MCP preparation',
        workspaceCwd: this.runtime.workspaceCwd,
      });
      let initializationRequested = false;
      while (true) {
        if (revision !== this.mcpRevision) return;
        const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
        if (
          this.draining ||
          this.disposed ||
          !current.runtimeLive ||
          current.runtimeEpoch !== epoch
        ) {
          if (
            this.draining &&
            !this.disposed &&
            current.runtimeLive &&
            current.runtimeEpoch === epoch
          ) {
            this.mcpReconcileDeferred = true;
          }
          this.mcpStatus = { state: 'stale', revision, runtimeEpoch: epoch };
          return;
        }
        const currentEpochStatus =
          status.runtimeEpoch === epoch && status.source === 'live';
        if (
          currentEpochStatus &&
          status.discoveryState === 'not_started' &&
          !initializationRequested
        ) {
          initializationRequested = true;
          await this.bridge.initializeWorkspaceMcp();
        }
        if (currentEpochStatus && status.errors?.length) {
          throw new Error(
            status.errors[0]?.error ?? 'MCP discovery failed to initialize',
          );
        }
        if (currentEpochStatus && status.discoveryState === 'completed') break;
        if (Date.now() >= deadline) {
          throw new WorkspaceRuntimeStillStartingError();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, MCP_POLL_INTERVAL_MS);
          timer.unref?.();
        });
        status = await this.runtime.workspaceService.getWorkspaceMcpStatus({
          route: 'workspace runtime MCP preparation',
          workspaceCwd: this.runtime.workspaceCwd,
        });
      }
      const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
      if (revision !== this.mcpRevision) return;
      if (!current.runtimeLive || current.runtimeEpoch !== epoch) {
        this.mcpStatus = { state: 'stale', revision, runtimeEpoch: epoch };
        return;
      }
      this.mcpStatus = { state: 'ready', revision, runtimeEpoch: epoch };
    } catch (error) {
      this.recordMcpError(revision, epoch, error);
    }
  }

  private recordMcpError(
    revision: number,
    runtimeEpoch: number,
    error: unknown,
  ): void {
    const current = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    if (revision !== this.mcpRevision) return;
    if (
      this.draining ||
      !current.runtimeLive ||
      current.runtimeEpoch !== runtimeEpoch
    ) {
      this.mcpStatus = { state: 'stale', revision, runtimeEpoch };
      return;
    }
    this.mcpStatus = {
      state: 'error',
      revision,
      runtimeEpoch,
      error: {
        code:
          error instanceof WorkspaceRuntimeStillStartingError
            ? 'mcp_prepare_timed_out'
            : 'mcp_prepare_failed',
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
