/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  STATUS_SCHEMA_VERSION,
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

  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly bridge: LifecycleAcpSessionBridge,
  ) {}

  beginDrain(): void {
    this.draining = true;
  }

  cancelDrain(): void {
    if (!this.disposed) this.draining = false;
  }

  hasActiveWork(): boolean {
    return this.bridge.getWorkspaceRuntimeLifecycleSnapshot().activeWork;
  }

  dispose(): void {
    this.disposed = true;
    this.draining = true;
  }

  status(): ServeWorkspaceRuntimeStatus {
    const snapshot = this.bridge.getWorkspaceRuntimeLifecycleSnapshot();
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd: this.runtime.workspaceCwd,
      state: snapshot.state,
      runtimeLive: snapshot.runtimeLive,
      runtimeEpoch: snapshot.runtimeEpoch,
    };
  }

  async ensure(
    timeoutMs = DEFAULT_ENSURE_TIMEOUT_MS,
  ): Promise<ServeWorkspaceRuntimeStatus> {
    this.assertAcceptingWork();
    try {
      await withTimeout(
        this.bridge.preheat({ keepAliveMs: ENSURE_KEEP_ALIVE_MS }),
        timeoutMs,
      );
    } catch (error) {
      this.assertAcceptingWork();
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
    return status;
  }

  private assertAcceptingWork(): void {
    this.runtime.generationGuard?.assertOpen();
    if (this.disposed || this.draining) {
      throw new WorkspaceDrainingError(this.runtime.workspaceCwd);
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
