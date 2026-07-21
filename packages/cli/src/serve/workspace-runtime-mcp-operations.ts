/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import type { WorkspaceRuntime } from './workspace-registry.js';
import { getErrorMessage as message } from '../utils/errors.js';
import type { WorkspaceRequestContext } from './workspace-service/types.js';

const MCP_POLL_INTERVAL_MS = 250;
const MCP_AUTH_OPERATION_TIMEOUT_MS = 10 * 60_000;
const MAX_RETAINED_OPERATIONS = 100;

export interface WorkspaceRuntimeOperationStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  operationId: string;
  workspaceCwd: string;
  kind: 'mcp';
  action: string;
  target: string;
  state: 'running' | 'waiting_for_input' | 'succeeded' | 'failed';
  deadlineAt?: string;
  authUrl?: string;
  error?: { code: string; message: string };
}

type RunInMcpPhysicalLane = <T>(
  run: () => Promise<T>,
  bypassAuthenticationBarrier?: boolean,
) => Promise<T>;

interface WorkspaceRuntimeMcpOperationsDependencies {
  assertAcceptingWork: () => void;
  runtimeEpoch: () => number;
  runInPhysicalLane: RunInMcpPhysicalLane;
}

function requestContext(
  runtime: WorkspaceRuntime,
  route: string,
): WorkspaceRequestContext {
  return { route, workspaceCwd: runtime.workspaceCwd };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class WorkspaceRuntimeStillStartingError extends Error {
  constructor() {
    super('Workspace runtime is still starting');
  }
}

async function waitUntilDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new WorkspaceRuntimeStillStartingError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new WorkspaceRuntimeStillStartingError()),
          remainingMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ACP OAuth uses a process-global callback listener, so authentication must be
// serialized across every workspace runtime in the daemon.
let activeMcpAuthentication:
  | {
      owner: object;
      operationId: string;
    }
  | undefined;

export class WorkspaceRuntimeMcpOperationConflictError extends Error {
  constructor(
    readonly code: 'mcp_operation_conflict' | 'mcp_authentication_lane_busy',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRuntimeMcpOperationConflictError';
  }
}

export class WorkspaceRuntimeMcpOperations {
  private disposed = false;

  private readonly operations = new Map<
    string,
    WorkspaceRuntimeOperationStatus
  >();

  private readonly activeOperationByTarget = new Map<string, string>();

  private readonly authenticationLaneOwner = {};

  private authenticationBarrier:
    | {
        operationId: string;
        promise: Promise<void>;
        release: () => void;
      }
    | undefined;

  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly dependencies: WorkspaceRuntimeMcpOperationsDependencies,
  ) {}

  getAuthenticationBarrier(): Promise<void> | undefined {
    return this.authenticationBarrier?.promise;
  }

  hasActiveWork(): boolean {
    return Array.from(this.operations.values()).some(
      (operation) =>
        operation.state === 'running' ||
        operation.state === 'waiting_for_input',
    );
  }

  operationStatus(
    operationId: string,
  ): WorkspaceRuntimeOperationStatus | undefined {
    return this.operations.get(operationId);
  }

  activeOperations(): readonly WorkspaceRuntimeOperationStatus[] {
    return Array.from(this.operations.values()).filter(
      (operation) =>
        operation.state === 'running' ||
        operation.state === 'waiting_for_input',
    );
  }

  async runMcpOperation<T extends { pending?: boolean; authUrl?: string }>(
    serverName: string,
    action: string,
    run: (operationId: string, deadlineAt?: number) => Promise<T>,
  ): Promise<T & { operationId: string; deadlineAt?: string }> {
    this.dependencies.assertAcceptingWork();
    this.pruneOperations();
    const activeOperationId = this.activeOperationByTarget.get(serverName);
    if (activeOperationId) {
      throw new WorkspaceRuntimeMcpOperationConflictError(
        'mcp_operation_conflict',
        `MCP server "${serverName}" already has active operation "${activeOperationId}"`,
      );
    }
    if (action === 'authenticate' && activeMcpAuthentication) {
      throw new WorkspaceRuntimeMcpOperationConflictError(
        'mcp_authentication_lane_busy',
        'Another MCP authentication is already in progress in this daemon',
      );
    }
    const operationId = crypto.randomUUID();
    this.activeOperationByTarget.set(serverName, operationId);
    if (action === 'authenticate') {
      activeMcpAuthentication = {
        owner: this.authenticationLaneOwner,
        operationId,
      };
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      this.authenticationBarrier = {
        operationId,
        promise: barrier,
        release: releaseBarrier,
      };
    }
    const deadline =
      action === 'authenticate'
        ? Date.now() + MCP_AUTH_OPERATION_TIMEOUT_MS
        : undefined;
    this.operations.set(operationId, {
      v: STATUS_SCHEMA_VERSION,
      operationId,
      workspaceCwd: this.runtime.workspaceCwd,
      kind: 'mcp',
      action,
      target: serverName,
      state: 'running',
      ...(deadline === undefined
        ? {}
        : { deadlineAt: new Date(deadline).toISOString() }),
    });
    let physicalOperation: Promise<T> | undefined;
    try {
      physicalOperation = this.dependencies.runInPhysicalLane(() => {
        this.dependencies.assertAcceptingWork();
        return run(operationId, deadline);
      }, action === 'authenticate');
      const result =
        deadline === undefined
          ? await physicalOperation
          : await waitUntilDeadline(physicalOperation, deadline);
      if (action === 'authenticate' && result.pending) {
        this.updateOperation(operationId, {
          state: 'waiting_for_input',
          ...(result.authUrl === undefined ? {} : { authUrl: result.authUrl }),
        });
        const responseEpoch =
          'runtimeEpoch' in result && typeof result.runtimeEpoch === 'number'
            ? result.runtimeEpoch
            : this.dependencies.runtimeEpoch();
        void this.monitorAuthentication(
          operationId,
          serverName,
          responseEpoch,
          deadline!,
        );
      } else {
        this.updateOperation(operationId, { state: 'succeeded' });
        this.releaseOperation(serverName, operationId);
      }
      const operation = this.operations.get(operationId);
      return {
        ...result,
        operationId,
        ...(operation?.deadlineAt === undefined
          ? {}
          : { deadlineAt: operation.deadlineAt }),
      };
    } catch (error) {
      if (action === 'authenticate') {
        const timedOut = deadline !== undefined && Date.now() >= deadline;
        const operationError = timedOut
          ? Object.assign(new Error('MCP authentication timed out'), {
              code: 'mcp_authentication_timeout',
            })
          : error;
        if (timedOut) {
          this.updateOperation(operationId, { state: 'waiting_for_input' });
        }
        void this.failAuthenticationWhenSafe(
          serverName,
          operationId,
          {
            code: timedOut
              ? 'mcp_authentication_timeout'
              : 'mcp_operation_failed',
            message: message(operationError),
          },
          physicalOperation,
        );
        throw operationError;
      }
      this.updateOperation(operationId, {
        state: 'failed',
        error: { code: 'mcp_operation_failed', message: message(error) },
      });
      this.releaseOperation(serverName, operationId);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [operationId, operation] of this.operations) {
      if (
        operation.state === 'running' ||
        operation.state === 'waiting_for_input'
      ) {
        this.updateOperation(operationId, {
          state: 'failed',
          error: {
            code: 'workspace_runtime_disposed',
            message: 'Workspace runtime was disposed',
          },
        });
      }
    }
    this.activeOperationByTarget.clear();
    if (
      activeMcpAuthentication?.owner === this.authenticationLaneOwner &&
      !this.runtime.bridge.isChannelLive()
    ) {
      activeMcpAuthentication = undefined;
    }
    if (this.authenticationBarrier) {
      const barrier = this.authenticationBarrier;
      this.authenticationBarrier = undefined;
      barrier.release();
    }
  }

  completeDisposeAfterBridgeShutdown(): void {
    if (
      this.disposed &&
      activeMcpAuthentication?.owner === this.authenticationLaneOwner
    ) {
      activeMcpAuthentication = undefined;
    }
  }

  private pruneOperations(): void {
    if (this.operations.size < MAX_RETAINED_OPERATIONS) return;
    for (const [operationId, operation] of this.operations) {
      if (
        operation.state !== 'running' &&
        operation.state !== 'waiting_for_input'
      ) {
        this.operations.delete(operationId);
        if (this.operations.size < MAX_RETAINED_OPERATIONS) return;
      }
    }
  }

  private updateOperation(
    operationId: string,
    patch: Pick<WorkspaceRuntimeOperationStatus, 'state'> &
      Partial<Pick<WorkspaceRuntimeOperationStatus, 'authUrl' | 'error'>>,
  ): void {
    const current = this.operations.get(operationId);
    if (!current) return;
    if (
      current.error?.code === 'workspace_runtime_disposed' &&
      patch.error?.code !== 'workspace_runtime_disposed'
    ) {
      return;
    }
    this.operations.set(operationId, {
      ...current,
      ...patch,
    });
  }

  private releaseOperationTarget(
    serverName: string,
    operationId: string,
  ): void {
    if (this.activeOperationByTarget.get(serverName) === operationId) {
      this.activeOperationByTarget.delete(serverName);
    }
  }

  private releaseOperation(serverName: string, operationId: string): void {
    this.releaseOperationTarget(serverName, operationId);
    if (this.authenticationBarrier?.operationId === operationId) {
      const barrier = this.authenticationBarrier;
      this.authenticationBarrier = undefined;
      barrier.release();
    }
    if (
      activeMcpAuthentication?.owner === this.authenticationLaneOwner &&
      activeMcpAuthentication.operationId === operationId &&
      (!this.disposed || !this.runtime.bridge.isChannelLive())
    ) {
      activeMcpAuthentication = undefined;
    }
  }

  private async monitorAuthentication(
    operationId: string,
    serverName: string,
    operationEpoch: number,
    deadline: number,
  ): Promise<void> {
    let terminalError: { code: string; message: string } | undefined;
    let succeeded = false;
    let timedOut = false;
    try {
      while (!this.disposed) {
        await wait(MCP_POLL_INTERVAL_MS);
        if (
          !this.runtime.bridge.isChannelLive() ||
          this.dependencies.runtimeEpoch() !== operationEpoch
        ) {
          terminalError = {
            code: 'mcp_authentication_runtime_unavailable',
            message: 'Workspace runtime exited during MCP authentication',
          };
          break;
        }
        try {
          const status = timedOut
            ? await this.runtime.workspaceService.getWorkspaceMcpStatus(
                requestContext(
                  this.runtime,
                  'GET /workspace/runtime/operations/:operationId cleanup',
                ),
              )
            : await waitUntilDeadline(
                this.runtime.workspaceService.getWorkspaceMcpStatus(
                  requestContext(
                    this.runtime,
                    'GET /workspace/runtime/operations/:operationId',
                  ),
                ),
                deadline,
              );
          if (
            status.runtimeEpoch !== operationEpoch ||
            this.dependencies.runtimeEpoch() !== operationEpoch
          ) {
            terminalError = {
              code: 'mcp_authentication_runtime_unavailable',
              message: 'Workspace runtime exited during MCP authentication',
            };
            break;
          }
          const server = status.servers.find(
            (candidate) => candidate.name === serverName,
          );
          if (!server) {
            if (status.discoveryState !== 'completed') continue;
            terminalError = timedOut
              ? {
                  code: 'mcp_authentication_timeout',
                  message: 'MCP authentication timed out',
                }
              : {
                  code: 'mcp_server_not_found',
                  message: `MCP server "${serverName}" was not found`,
                };
            break;
          }
          if (server.authenticationState === 'pending') {
            if (Date.now() >= deadline) timedOut = true;
            continue;
          }
          if (timedOut) {
            terminalError = {
              code: 'mcp_authentication_timeout',
              message: 'MCP authentication timed out',
            };
          } else if (server.authenticationError) {
            terminalError = {
              code: 'mcp_authentication_failed',
              message: server.authenticationError,
            };
          } else {
            succeeded = true;
          }
          break;
        } catch (error) {
          if (
            error instanceof WorkspaceRuntimeStillStartingError ||
            Date.now() >= deadline
          ) {
            timedOut = true;
          }
          // Status transport errors are transient. The operation and its
          // authentication lane stay non-terminal until ACP confirms that the
          // provider is no longer pending or the owning runtime epoch exits.
          continue;
        }
      }
    } finally {
      await this.releaseAuthenticationWhenSafe(
        serverName,
        operationId,
        operationEpoch,
      );
      if (!this.disposed) {
        if (succeeded) {
          this.updateOperation(operationId, { state: 'succeeded' });
        } else {
          this.updateOperation(operationId, {
            state: 'failed',
            error:
              terminalError ??
              (timedOut
                ? {
                    code: 'mcp_authentication_timeout',
                    message: 'MCP authentication timed out',
                  }
                : {
                    code: 'mcp_authentication_runtime_unavailable',
                    message:
                      'Workspace runtime exited during MCP authentication',
                  }),
          });
        }
      }
    }
  }

  private async failAuthenticationWhenSafe(
    serverName: string,
    operationId: string,
    error: { code: string; message: string },
    physicalOperation?: Promise<unknown>,
  ): Promise<void> {
    let responseEpoch: number | undefined;
    if (physicalOperation) {
      try {
        const result = await physicalOperation;
        if (
          typeof result === 'object' &&
          result !== null &&
          'runtimeEpoch' in result &&
          typeof result.runtimeEpoch === 'number'
        ) {
          responseEpoch = result.runtimeEpoch;
        }
      } catch {
        // The physical request is settled. Status below determines whether an
        // OAuth callback still owns the process-global listener.
      }
    }
    const operationEpoch =
      responseEpoch ??
      (this.runtime.bridge.isChannelLive()
        ? this.dependencies.runtimeEpoch()
        : undefined);
    await this.releaseAuthenticationWhenSafe(
      serverName,
      operationId,
      operationEpoch,
    );
    this.updateOperation(operationId, { state: 'failed', error });
  }

  private async releaseAuthenticationWhenSafe(
    serverName: string,
    operationId: string,
    operationEpoch?: number,
  ): Promise<void> {
    while (
      !this.disposed &&
      this.runtime.bridge.isChannelLive() &&
      (operationEpoch === undefined ||
        this.dependencies.runtimeEpoch() === operationEpoch)
    ) {
      const physicalPending =
        this.runtime.bridge.isWorkspaceMcpAuthenticationPending?.(operationId);
      if (physicalPending === false) break;
      if (physicalPending === true) {
        await wait(MCP_POLL_INTERVAL_MS);
        continue;
      }
      try {
        const status =
          await this.runtime.workspaceService.getWorkspaceMcpStatus(
            requestContext(
              this.runtime,
              'GET /workspace/runtime/operations/:operationId cleanup',
            ),
          );
        if (
          operationEpoch !== undefined &&
          status.runtimeEpoch !== operationEpoch
        ) {
          break;
        }
        const server = status.servers.find(
          (candidate) => candidate.name === serverName,
        );
        if (server?.authenticationState !== 'pending') break;
      } catch {
        if (!this.runtime.bridge.isChannelLive()) break;
      }
      await wait(MCP_POLL_INTERVAL_MS);
    }
    this.releaseOperation(serverName, operationId);
  }
}
