/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SERVE_CONTROL_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  type ServeWorkspaceRuntimeCapability,
  type ServeWorkspaceRuntimeCapabilityStatus,
  type ServeWorkspaceRuntimeStatus,
  type ServeWorkspaceSkillsRefreshResult,
} from '@qwen-code/acp-bridge/status';
import {
  WorkspaceRuntimeMcpOperations,
  type WorkspaceRuntimeOperationStatus,
} from './workspace-runtime-mcp-operations.js';
import { WorkspaceDrainingError } from './acp-session-bridge.js';
import type { WorkspaceRuntime } from './workspace-registry.js';
import type { WorkspaceRequestContext } from './workspace-service/types.js';

const DEFAULT_PREPARE_TIMEOUT_MS = 60_000;
const MAX_PREPARE_TIMEOUT_MS = 120_000;
const MCP_POLL_INTERVAL_MS = 250;

const WORKSPACE_RUNTIME_CAPABILITIES = [
  'extensions',
  'mcp',
  'skills',
  'tools',
] as const satisfies readonly ServeWorkspaceRuntimeCapability[];

export interface ExtensionsReconciliationAttempt {
  generation: number;
  runtimeEpoch: number;
  revision: number;
}

interface InternalCapabilityStatus
  extends ServeWorkspaceRuntimeCapabilityStatus {
  runtimeLive: boolean;
}

export function normalizeWorkspaceRuntimeTimeout(
  value: unknown,
): number | undefined {
  if (value === undefined) return DEFAULT_PREPARE_TIMEOUT_MS;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_PREPARE_TIMEOUT_MS
  ) {
    return undefined;
  }
  return value;
}

function requestContext(
  runtime: WorkspaceRuntime,
  route: string,
): WorkspaceRequestContext {
  return { route, workspaceCwd: runtime.workspaceCwd };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class WorkspaceRuntimeStillStartingError extends Error {}
class WorkspaceRuntimeEpochChangedError extends WorkspaceRuntimeStillStartingError {}

export function isWorkspaceRuntimeDrainingError(error: unknown): boolean {
  return error instanceof WorkspaceDrainingError;
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

export class WorkspaceRuntimeCoordinator {
  private disposed = false;

  private draining = false;

  private readonly capabilityStatus = new Map<
    ServeWorkspaceRuntimeCapability,
    InternalCapabilityStatus
  >();

  private readonly inFlight = new Map<
    ServeWorkspaceRuntimeCapability,
    Promise<void>
  >();

  private readonly capabilityPhysicalTail = new Map<
    ServeWorkspaceRuntimeCapability,
    Promise<void>
  >();

  private readonly backgroundResume = new Map<
    ServeWorkspaceRuntimeCapability,
    number
  >();

  private readonly capabilityRevision = new Map<
    ServeWorkspaceRuntimeCapability,
    number
  >();

  private readonly deferredConfigurationReconciliation = new Set<
    'mcp' | 'skills'
  >();

  private readonly capabilityEpoch = new Map<
    ServeWorkspaceRuntimeCapability,
    number
  >();

  private preheatInFlight: Promise<void> | undefined;

  private extensionsDesiredGeneration: number | undefined;

  private extensionsAppliedGeneration: number | undefined;

  private extensionsAppliedEpoch: number | undefined;

  private extensionsReconciliationRevision = 0;

  private activeManagementOperations = 0;

  private readonly mcpOperations: WorkspaceRuntimeMcpOperations;

  constructor(private readonly runtime: WorkspaceRuntime) {
    this.mcpOperations = new WorkspaceRuntimeMcpOperations(runtime, {
      assertAcceptingWork: () => this.assertAcceptingWork(),
      runtimeEpoch: () => this.runtimeEpoch(),
      runInPhysicalLane: (run, bypassAuthenticationBarrier) =>
        this.runInCapabilityPhysicalLane(
          'mcp',
          run,
          bypassAuthenticationBarrier,
        ),
    });
  }

  beginDrain(): void {
    this.draining = true;
  }

  cancelDrain(): void {
    if (this.disposed || !this.draining) return;
    this.draining = false;
    const deferred = [...this.deferredConfigurationReconciliation];
    for (const capability of deferred) {
      if (capability === 'mcp') {
        this.reconcileMcpConfiguration();
      } else {
        this.reconcileSkillsConfiguration();
      }
    }
  }

  hasActiveWork(): boolean {
    return (
      this.activeManagementOperations > 0 ||
      this.preheatInFlight !== undefined ||
      this.inFlight.size > 0 ||
      this.backgroundResume.size > 0 ||
      this.capabilityPhysicalTail.size > 0 ||
      this.mcpOperations.hasActiveWork() ||
      (this.runtime.bridge.hasActiveWorkspaceWork?.() ?? false)
    );
  }

  acquireManagementOperation(): () => void {
    this.assertAcceptingWork();
    this.activeManagementOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeManagementOperations -= 1;
    };
  }

  async runManagementOperation<T>(run: () => Promise<T>): Promise<T> {
    const release = this.acquireManagementOperation();
    try {
      return await run();
    } finally {
      release();
    }
  }

  private assertAcceptingWork(): void {
    if (this.disposed) throw new Error('Workspace runtime was disposed');
    if (this.draining) {
      throw new WorkspaceDrainingError(this.runtime.workspaceCwd);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.draining = true;
    this.mcpOperations.dispose();
    this.deferredConfigurationReconciliation.clear();
  }

  private runtimeEpoch(): number {
    return (
      this.runtime.bridge.getRuntimeEpoch?.() ??
      (this.runtime.bridge.isChannelLive() ? 1 : 0)
    );
  }

  private assertCurrentRuntimeEpoch(
    responseEpoch: number | undefined,
    expectedEpoch: number,
  ): void {
    if (
      !this.runtime.bridge.isChannelLive() ||
      this.runtimeEpoch() !== expectedEpoch ||
      responseEpoch !== expectedEpoch
    ) {
      throw new WorkspaceRuntimeEpochChangedError();
    }
  }

  private currentCapabilityRevision(
    capability: ServeWorkspaceRuntimeCapability,
  ): number {
    return this.capabilityRevision.get(capability) ?? 0;
  }

  private advanceCapabilityRevision(
    capability: ServeWorkspaceRuntimeCapability,
  ): number {
    const revision = this.currentCapabilityRevision(capability) + 1;
    this.capabilityRevision.set(capability, revision);
    return revision;
  }

  private runInCapabilityPhysicalLane<T>(
    capability: ServeWorkspaceRuntimeCapability,
    run: () => Promise<T>,
    bypassMcpAuthenticationBarrier = false,
  ): Promise<T> {
    const previous =
      this.capabilityPhysicalTail.get(capability) ?? Promise.resolve();
    const authenticationBarrier =
      capability === 'mcp' && !bypassMcpAuthenticationBarrier
        ? this.mcpOperations.getAuthenticationBarrier()
        : undefined;
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        await authenticationBarrier;
        await this.runtime.bridge.waitForWorkspacePhysicalRequests?.(
          capability,
        );
        return await run();
      });
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.capabilityPhysicalTail.set(capability, tail);
    void tail.finally(() => {
      if (this.capabilityPhysicalTail.get(capability) === tail) {
        this.capabilityPhysicalTail.delete(capability);
      }
    });
    return execution;
  }

  private projectedCapabilityStatus(
    capability: ServeWorkspaceRuntimeCapability,
  ): ServeWorkspaceRuntimeCapabilityStatus {
    const runtimeLive = this.runtime.bridge.isChannelLive();
    const current = this.capabilityStatus.get(capability);
    const {
      runtimeLive: recordedRuntimeLive,
      ...currentStatus
    }: InternalCapabilityStatus = current ?? {
      state: 'not_started',
      runtimeLive: false,
    };
    const capabilityEpoch = this.capabilityEpoch.get(capability);
    const currentEpoch = this.runtimeEpoch();
    const staleTerminalState =
      (current?.state === 'ready' &&
        (!runtimeLive || capabilityEpoch !== currentEpoch)) ||
      (current?.state === 'starting' &&
        capabilityEpoch !== undefined &&
        (!runtimeLive || capabilityEpoch !== currentEpoch)) ||
      (current?.state === 'error' &&
        (capabilityEpoch !== currentEpoch ||
          (recordedRuntimeLive && !runtimeLive)));
    const state = staleTerminalState
      ? 'stale'
      : (current?.state ?? 'not_started');
    return {
      ...currentStatus,
      state,
      ...(capabilityEpoch !== undefined
        ? { runtimeEpoch: capabilityEpoch }
        : {}),
      ...(capability === 'extensions' &&
      current?.appliedGeneration !== undefined &&
      this.extensionsAppliedEpoch !== undefined
        ? { appliedEpoch: this.extensionsAppliedEpoch }
        : {}),
    };
  }

  private setCapabilityStatus(
    capability: ServeWorkspaceRuntimeCapability,
    status: InternalCapabilityStatus,
  ): void {
    if (
      status.state === 'ready' ||
      status.state === 'error' ||
      (status.state === 'starting' && status.runtimeLive)
    ) {
      this.capabilityEpoch.set(capability, this.runtimeEpoch());
    }
    this.capabilityStatus.set(capability, status);
  }

  private extensionsRuntimeIsCurrent(): boolean {
    const status = this.projectedCapabilityStatus('extensions');
    return (
      status.state === 'ready' &&
      this.extensionsDesiredGeneration === this.extensionsAppliedGeneration &&
      this.extensionsAppliedEpoch === this.runtimeEpoch()
    );
  }

  private extensionsPreparationIsActive(): boolean {
    return (
      this.inFlight.has('extensions') ||
      this.backgroundResume.has('extensions') ||
      this.capabilityPhysicalTail.has('extensions')
    );
  }

  private async waitForCurrentExtensions(deadline: number): Promise<boolean> {
    while (!this.extensionsRuntimeIsCurrent()) {
      if (!this.extensionsPreparationIsActive() || Date.now() >= deadline) {
        return false;
      }
      await wait(Math.min(MCP_POLL_INTERVAL_MS, deadline - Date.now()));
    }
    return true;
  }

  setExtensionsDesiredGeneration(generation: number): void {
    this.updateExtensionsDesiredGeneration(generation, true);
  }

  private updateExtensionsDesiredGeneration(
    generation: number,
    invalidateExtensionRevision: boolean,
  ): void {
    if (this.extensionsDesiredGeneration === generation) return;
    this.extensionsDesiredGeneration = generation;
    this.extensionsReconciliationRevision += 1;
    for (const capability of WORKSPACE_RUNTIME_CAPABILITIES) {
      if (capability === 'extensions' && !invalidateExtensionRevision) continue;
      this.advanceCapabilityRevision(capability);
      this.inFlight.delete(capability);
      this.backgroundResume.delete(capability);
      if (capability === 'extensions') continue;
      const current = this.capabilityStatus.get(capability);
      this.setCapabilityStatus(capability, {
        state:
          current?.state === 'ready' ||
          current?.state === 'stale' ||
          current?.state === 'error'
            ? 'stale'
            : 'not_started',
        runtimeLive: this.runtime.bridge.isChannelLive(),
      });
    }
    if (this.extensionsAppliedGeneration !== generation) {
      this.setCapabilityStatus('extensions', {
        state:
          this.extensionsAppliedGeneration === undefined
            ? 'not_started'
            : 'stale',
        runtimeLive: this.runtime.bridge.isChannelLive(),
        desiredGeneration: generation,
        ...(this.extensionsAppliedGeneration === undefined
          ? {}
          : { appliedGeneration: this.extensionsAppliedGeneration }),
      });
    }
  }

  beginExtensionsReconciliation(
    generation: number,
  ): ExtensionsReconciliationAttempt | undefined {
    if (
      generation !== this.extensionsDesiredGeneration ||
      this.draining ||
      !this.runtime.bridge.isChannelLive()
    ) {
      return undefined;
    }
    const runtimeLive = this.runtime.bridge.isChannelLive();
    const attempt = {
      generation,
      runtimeEpoch: this.runtimeEpoch(),
      revision: ++this.extensionsReconciliationRevision,
    };
    this.setCapabilityStatus('extensions', {
      state: 'starting',
      runtimeLive,
      desiredGeneration: generation,
      ...(this.extensionsAppliedGeneration === undefined
        ? {}
        : { appliedGeneration: this.extensionsAppliedGeneration }),
    });
    return attempt;
  }

  runExtensionsPhysicalReconciliation<T>(run: () => Promise<T>): Promise<T> {
    return this.runInCapabilityPhysicalLane('extensions', async () => {
      this.assertAcceptingWork();
      return await run();
    });
  }

  failExtensionsReconciliation(
    attempt: ExtensionsReconciliationAttempt | undefined,
    error: unknown,
  ): void {
    if (
      !attempt ||
      attempt.generation !== this.extensionsDesiredGeneration ||
      attempt.runtimeEpoch !== this.runtimeEpoch() ||
      attempt.revision !== this.extensionsReconciliationRevision
    ) {
      return;
    }
    const runtimeLive = this.runtime.bridge.isChannelLive();
    this.setCapabilityStatus('extensions', {
      state: runtimeLive ? 'error' : 'stale',
      runtimeLive,
      desiredGeneration: attempt.generation,
      ...(this.extensionsAppliedGeneration === undefined
        ? {}
        : { appliedGeneration: this.extensionsAppliedGeneration }),
      ...(runtimeLive
        ? {
            error: {
              code: 'extensions_reconcile_failed',
              message: message(error),
            },
          }
        : {}),
    });
  }

  setExtensionsAppliedGeneration(
    generation: number,
    attempt: ExtensionsReconciliationAttempt | undefined,
  ): void {
    if (
      !attempt ||
      attempt.generation !== generation ||
      attempt.generation !== this.extensionsDesiredGeneration ||
      attempt.runtimeEpoch !== this.runtimeEpoch() ||
      attempt.revision !== this.extensionsReconciliationRevision
    ) {
      return;
    }
    this.extensionsDesiredGeneration ??= generation;
    this.extensionsAppliedGeneration = generation;
    this.extensionsAppliedEpoch = attempt.runtimeEpoch;
    const runtimeLive = this.runtime.bridge.isChannelLive();
    const ready =
      runtimeLive && this.extensionsDesiredGeneration === generation;
    this.setCapabilityStatus('extensions', {
      state: ready ? 'ready' : runtimeLive ? 'starting' : 'stale',
      runtimeLive,
      desiredGeneration: this.extensionsDesiredGeneration,
      appliedGeneration: generation,
    });
    if (!ready) return;
    const initializedDerivedCapabilities =
      WORKSPACE_RUNTIME_CAPABILITIES.filter(
        (capability) =>
          capability !== 'extensions' && this.capabilityEpoch.has(capability),
      );
    if (initializedDerivedCapabilities.length === 0) return;
    void this.prepare(initializedDerivedCapabilities).catch(() => undefined);
  }

  reconcileMcpConfiguration(): 'deferred' | 'reconciling' {
    return this.reconcileCapability('mcp', () =>
      this.refreshMcpConfiguration(),
    );
  }

  async runMcpRuntimeMutation<T>(run: () => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    const revision = this.advanceCapabilityRevision('mcp');
    const previous = this.inFlight.get('mcp') ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => await this.executeMcpRuntimeMutation(run, revision));
    const tracked = execution.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set('mcp', tracked);
    try {
      return await execution;
    } finally {
      if (this.inFlight.get('mcp') === tracked) {
        this.inFlight.delete('mcp');
      }
    }
  }

  private executeMcpRuntimeMutation<T>(
    run: () => Promise<T>,
    revision: number,
  ): Promise<T> {
    return this.runInCapabilityPhysicalLane('mcp', () =>
      this.executeMcpRuntimeMutationInPhysicalLane(run, revision),
    );
  }

  private async executeMcpRuntimeMutationInPhysicalLane<T>(
    run: () => Promise<T>,
    revision: number,
  ): Promise<T> {
    this.assertAcceptingWork();
    this.setCapabilityStatus('mcp', {
      state: this.runtime.bridge.isChannelLive() ? 'starting' : 'not_started',
      runtimeLive: this.runtime.bridge.isChannelLive(),
    });
    let operationEpoch: number | undefined;
    const deadline = Date.now() + MAX_PREPARE_TIMEOUT_MS;
    try {
      return await this.withRuntimeControl(deadline, async () => {
        await this.ensureAcpRuntime(deadline);
        operationEpoch = this.runtimeEpoch();
        const result = await run();
        this.assertCurrentRuntimeEpoch(operationEpoch, operationEpoch);
        if (revision !== this.currentCapabilityRevision('mcp')) return result;
        const completed = await this.prepareCapabilityInPhysicalLane(
          'mcp',
          deadline,
          revision,
        );
        if (!completed) {
          await this.resumeCapabilityInBackground('mcp', revision, deadline);
        }
        return result;
      });
    } catch (error) {
      if (revision === this.currentCapabilityRevision('mcp')) {
        if (
          error instanceof WorkspaceRuntimeEpochChangedError ||
          (operationEpoch !== undefined &&
            operationEpoch !== this.runtimeEpoch())
        ) {
          throw error;
        }
        this.setCapabilityStatus('mcp', {
          state: 'error',
          runtimeLive: this.runtime.bridge.isChannelLive(),
          error: {
            code: 'mcp_runtime_mutation_failed',
            message: message(error),
          },
        });
      }
      throw error;
    }
  }

  reconcileSkillsConfiguration(): 'deferred' | 'reconciling' {
    return this.reconcileCapability('skills', () =>
      this.refreshSkillsConfiguration(),
    );
  }

  private async refreshMcpConfiguration(): Promise<void> {
    const result = await this.runtime.bridge.reloadWorkspaceMcp();
    if (!result.accepted) {
      throw new Error('MCP runtime reload was not accepted');
    }
  }

  private async refreshSkillsConfiguration(): Promise<void> {
    const result =
      await this.runtime.bridge.invokeWorkspaceCommand<ServeWorkspaceSkillsRefreshResult>(
        SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
        { cwd: this.runtime.workspaceCwd },
      );
    if (result.sessionsFailed > 0) {
      throw new Error(
        `${result.sessionsFailed} session skill refresh(es) failed`,
      );
    }
  }

  private reconcileCapability(
    capability: 'mcp' | 'skills',
    refresh: () => Promise<void>,
  ): 'deferred' | 'reconciling' {
    if (this.disposed) return 'deferred';
    const revision = this.advanceCapabilityRevision(capability);
    if (this.draining || !this.runtime.bridge.isChannelLive()) {
      if (this.draining && this.runtime.bridge.isChannelLive()) {
        this.deferredConfigurationReconciliation.add(capability);
      }
      this.setCapabilityStatus(capability, {
        state: this.capabilityEpoch.has(capability) ? 'stale' : 'not_started',
        runtimeLive: false,
      });
      return 'deferred';
    }
    const operationEpoch = this.runtimeEpoch();

    this.setCapabilityStatus(capability, {
      state: 'starting',
      runtimeLive: true,
    });
    const previous = this.inFlight.get(capability) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() =>
        this.runInCapabilityPhysicalLane(capability, async () => {
          if (this.disposed) return;
          // Configuration refresh is an ordered side effect: later runtime
          // work may supersede its status projection, but must not skip it.
          if (this.draining) {
            if (this.runtime.bridge.isChannelLive()) {
              this.deferredConfigurationReconciliation.add(capability);
            }
            this.setCapabilityStatus(capability, {
              state: this.capabilityEpoch.has(capability)
                ? 'stale'
                : 'not_started',
              runtimeLive: false,
            });
            return;
          }
          if (
            !this.runtime.bridge.isChannelLive() ||
            this.runtimeEpoch() !== operationEpoch
          ) {
            this.setCapabilityStatus(capability, {
              state: this.capabilityEpoch.has(capability)
                ? 'stale'
                : 'not_started',
              runtimeLive: this.runtime.bridge.isChannelLive(),
            });
            return;
          }
          const deadline = Date.now() + MAX_PREPARE_TIMEOUT_MS;
          await refresh();
          this.assertCurrentRuntimeEpoch(operationEpoch, operationEpoch);
          if (revision !== this.currentCapabilityRevision(capability)) return;
          this.deferredConfigurationReconciliation.delete(capability);
          const completed = await this.prepareCapabilityInPhysicalLane(
            capability,
            deadline,
            revision,
          );
          if (!completed) {
            await this.resumeCapabilityInBackground(
              capability,
              revision,
              deadline,
            );
          }
        }),
      )
      .catch((error) => {
        if (revision !== this.currentCapabilityRevision(capability)) return;
        if (
          error instanceof WorkspaceRuntimeEpochChangedError ||
          !this.runtime.bridge.isChannelLive() ||
          this.runtimeEpoch() !== operationEpoch
        ) {
          return;
        }
        this.setCapabilityStatus(capability, {
          state: 'error',
          runtimeLive: this.runtime.bridge.isChannelLive(),
          error: {
            code: `${capability}_reconcile_failed`,
            message: message(error),
          },
        });
      })
      .finally(() => {
        if (this.inFlight.get(capability) === operation) {
          this.inFlight.delete(capability);
        }
      });
    this.inFlight.set(capability, operation);
    return 'reconciling';
  }

  operationStatus(
    operationId: string,
  ): WorkspaceRuntimeOperationStatus | undefined {
    return this.mcpOperations.operationStatus(operationId);
  }

  activeOperations(): readonly WorkspaceRuntimeOperationStatus[] {
    return this.mcpOperations.activeOperations();
  }

  async runMcpOperation<T extends { pending?: boolean; authUrl?: string }>(
    serverName: string,
    action: string,
    run: (operationId: string, deadlineAt?: number) => Promise<T>,
  ): Promise<T & { operationId: string; deadlineAt?: string }> {
    return await this.mcpOperations.runMcpOperation(serverName, action, run);
  }

  status(): ServeWorkspaceRuntimeStatus {
    const runtimeLive = this.runtime.bridge.isChannelLive();
    const capabilities = Object.fromEntries(
      WORKSPACE_RUNTIME_CAPABILITIES.map((capability) => [
        capability,
        this.projectedCapabilityStatus(capability),
      ]),
    ) as ServeWorkspaceRuntimeStatus['capabilities'];
    const hasError = Object.values(capabilities).some(
      (capability) => capability?.state === 'error',
    );
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd: this.runtime.workspaceCwd,
      state: this.runtime.bridge.isChannelStopping?.()
        ? 'stopping'
        : !runtimeLive
          ? this.inFlight.size > 0 ||
            this.backgroundResume.size > 0 ||
            this.preheatInFlight !== undefined
            ? 'starting'
            : 'cold'
          : (this.runtime.bridge.hasActiveWorkspaceWork?.() ??
                this.runtime.bridge.sessionCount > 0) ||
              this.mcpOperations.hasActiveWork()
            ? 'active'
            : hasError
              ? 'error'
              : 'idle',
      runtimeLive,
      runtimeEpoch: this.runtimeEpoch(),
      capabilities,
    };
  }

  async ensure(
    timeoutMs = DEFAULT_PREPARE_TIMEOUT_MS,
  ): Promise<ServeWorkspaceRuntimeStatus> {
    this.assertAcceptingWork();
    const status = this.status();
    if (
      status.runtimeLive &&
      WORKSPACE_RUNTIME_CAPABILITIES.every(
        (capability) => status.capabilities[capability]?.state === 'ready',
      )
    ) {
      return status;
    }
    return await this.prepare(WORKSPACE_RUNTIME_CAPABILITIES, timeoutMs);
  }

  async prepare(
    requested: readonly ServeWorkspaceRuntimeCapability[],
    timeoutMs = DEFAULT_PREPARE_TIMEOUT_MS,
  ): Promise<ServeWorkspaceRuntimeStatus> {
    this.assertAcceptingWork();
    const startedAt = Date.now();
    const waitDeadline = startedAt + timeoutMs;
    const operationDeadline = startedAt + MAX_PREPARE_TIMEOUT_MS;
    const preparation = this.withRuntimeControl(operationDeadline, async () => {
      const prepareToCompletion = async (
        capability: ServeWorkspaceRuntimeCapability,
      ): Promise<void> => {
        const revision = this.currentCapabilityRevision(capability);
        let operation = this.inFlight.get(capability);
        if (!operation && this.backgroundResume.get(capability) === revision) {
          return;
        }
        if (!operation) {
          operation = this.prepareCapability(
            capability,
            operationDeadline,
            revision,
          )
            .then(async (completed) => {
              if (!completed && this.inFlight.get(capability) === operation) {
                await this.resumeCapabilityInBackground(
                  capability,
                  revision,
                  operationDeadline,
                );
              }
            })
            .finally(() => {
              if (this.inFlight.get(capability) === operation) {
                this.inFlight.delete(capability);
              }
            });
          this.inFlight.set(capability, operation);
        }
        await operation;
      };
      const capabilities = [...new Set(requested)];
      const derivedCapabilities = capabilities.filter(
        (capability) => capability !== 'extensions',
      );
      const shouldPrepareExtensions =
        capabilities.includes('extensions') ||
        (derivedCapabilities.length > 0 &&
          this.extensionsDesiredGeneration !== undefined &&
          !this.extensionsRuntimeIsCurrent());
      if (shouldPrepareExtensions) {
        await prepareToCompletion('extensions');
      }
      if (
        shouldPrepareExtensions &&
        derivedCapabilities.length > 0 &&
        !this.extensionsRuntimeIsCurrent() &&
        !this.extensionsPreparationIsActive()
      ) {
        const extensionError =
          this.capabilityStatus.get('extensions')?.error?.message ??
          'Extensions runtime did not converge';
        for (const capability of derivedCapabilities) {
          this.setCapabilityStatus(capability, {
            state: 'error',
            runtimeLive: this.runtime.bridge.isChannelLive(),
            error: {
              code: `${capability}_prepare_blocked_by_extensions`,
              message: `${capability} runtime preparation was blocked: ${extensionError}`,
            },
          });
        }
        return this.status();
      }
      await Promise.all(derivedCapabilities.map(prepareToCompletion));

      return this.status();
    });
    void preparation.catch(() => undefined);
    try {
      await waitUntilDeadline(preparation, waitDeadline);
      return this.status();
    } catch (error) {
      if (!(error instanceof WorkspaceRuntimeStillStartingError)) throw error;
      return this.status();
    }
  }

  private async withRuntimeControl<T>(
    deadline: number,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!this.runtime.bridge.withWorkspaceRuntimeControl) {
      return await run();
    }
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new WorkspaceRuntimeStillStartingError();
    return await waitUntilDeadline(
      this.runtime.bridge.withWorkspaceRuntimeControl(async (runtimeEpoch) => {
        if (
          !this.runtime.bridge.isChannelLive() ||
          this.runtimeEpoch() !== runtimeEpoch
        ) {
          throw new WorkspaceRuntimeEpochChangedError();
        }
        return await run();
      }, timeoutMs),
      deadline,
    );
  }

  private async ensureAcpRuntime(deadline: number): Promise<void> {
    if (this.runtime.bridge.isChannelLive()) return;
    if (!this.preheatInFlight) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new WorkspaceRuntimeStillStartingError();
      this.preheatInFlight = this.runtime.workspaceService
        .preheatAcpChild(
          requestContext(this.runtime, 'workspace runtime initialization'),
          { timeoutMs },
        )
        .then((result) => {
          if (!result.ready) {
            if (result.backgroundInProgress) {
              throw new WorkspaceRuntimeStillStartingError();
            }
            throw new Error(result.error ?? 'Workspace runtime is not ready');
          }
        })
        .finally(() => {
          this.preheatInFlight = undefined;
        });
    }
    await waitUntilDeadline(this.preheatInFlight, deadline);
  }

  private prepareCapability(
    capability: ServeWorkspaceRuntimeCapability,
    deadline: number,
    revision: number,
  ): Promise<boolean> {
    return this.runInCapabilityPhysicalLane(capability, async () => {
      this.assertAcceptingWork();
      if (
        capability !== 'extensions' &&
        this.extensionsDesiredGeneration !== undefined &&
        !this.extensionsRuntimeIsCurrent() &&
        !(await this.waitForCurrentExtensions(deadline))
      ) {
        return true;
      }
      return this.prepareCapabilityInPhysicalLane(
        capability,
        deadline,
        revision,
      );
    });
  }

  private async prepareCapabilityInPhysicalLane(
    capability: ServeWorkspaceRuntimeCapability,
    deadline: number,
    revision: number,
  ): Promise<boolean> {
    if (revision !== this.currentCapabilityRevision(capability)) return true;
    let extensionReconciliationRevision =
      capability === 'extensions'
        ? ++this.extensionsReconciliationRevision
        : undefined;
    const attemptIsCurrent = (): boolean =>
      revision === this.currentCapabilityRevision(capability) &&
      (extensionReconciliationRevision === undefined ||
        extensionReconciliationRevision ===
          this.extensionsReconciliationRevision);
    const extensionGenerations =
      capability === 'extensions'
        ? {
            desiredGeneration: this.extensionsDesiredGeneration,
            appliedGeneration: this.extensionsAppliedGeneration,
          }
        : {};
    let operationEpoch: number | undefined;
    this.setCapabilityStatus(capability, {
      state: 'starting',
      runtimeLive: this.runtime.bridge.isChannelLive(),
      ...extensionGenerations,
    });
    try {
      await this.ensureAcpRuntime(deadline);
      if (!attemptIsCurrent()) return true;
      operationEpoch = this.runtimeEpoch();
      this.setCapabilityStatus(capability, {
        state: 'starting',
        runtimeLive: true,
        ...extensionGenerations,
      });
      if (
        (capability === 'mcp' || capability === 'skills') &&
        this.deferredConfigurationReconciliation.has(capability)
      ) {
        if (capability === 'mcp') {
          await this.refreshMcpConfiguration();
        } else {
          await this.refreshSkillsConfiguration();
        }
        this.assertCurrentRuntimeEpoch(operationEpoch, operationEpoch);
        this.deferredConfigurationReconciliation.delete(capability);
      }
      if (capability === 'mcp') {
        await this.prepareMcp(deadline, operationEpoch);
      } else if (capability === 'skills') {
        const status = await waitUntilDeadline(
          this.runtime.workspaceService.getWorkspaceSkillsStatus(
            requestContext(
              this.runtime,
              'workspace runtime skills preparation',
            ),
          ),
          deadline,
        );
        if (
          !status.initialized ||
          status.source !== 'live' ||
          status.errors?.length
        ) {
          throw new Error(
            status.errors?.[0]?.error ??
              'Skills runtime did not return a live snapshot',
          );
        }
        this.assertCurrentRuntimeEpoch(status.runtimeEpoch, operationEpoch);
      } else if (capability === 'tools') {
        const status = await waitUntilDeadline(
          this.runtime.bridge.getWorkspaceToolsStatus(),
          deadline,
        );
        if (!status.initialized || status.errors?.length) {
          throw new Error(
            status.errors?.[0]?.error ?? 'Tools runtime is not initialized',
          );
        }
        this.assertCurrentRuntimeEpoch(status.runtimeEpoch, operationEpoch);
      } else {
        const refreshed = await waitUntilDeadline(
          Promise.resolve(this.runtime.bridge.refreshWorkspaceExtensions?.()),
          deadline,
        );
        if (!refreshed || refreshed.failed > 0) {
          throw new Error('Extensions runtime refresh failed');
        }
        const refreshedEpoch =
          'runtimeEpoch' in refreshed &&
          typeof refreshed.runtimeEpoch === 'number'
            ? refreshed.runtimeEpoch
            : undefined;
        this.assertCurrentRuntimeEpoch(refreshedEpoch, operationEpoch);
        const status = await waitUntilDeadline(
          this.runtime.bridge.getWorkspaceExtensionsStatus(),
          deadline,
        );
        if (!status.initialized || status.errors?.length) {
          throw new Error(
            status.errors?.[0]?.error ??
              'Extensions runtime is not initialized',
          );
        }
        this.assertCurrentRuntimeEpoch(status.runtimeEpoch, operationEpoch);
        const generation = refreshed.generation;
        if (generation === undefined) {
          throw new Error('Extensions runtime generation is unavailable');
        }
        if (
          this.extensionsDesiredGeneration !== undefined &&
          generation < this.extensionsDesiredGeneration
        ) {
          throw new Error(
            `Extensions runtime applied generation ${generation}, ` +
              `expected at least ${this.extensionsDesiredGeneration}`,
          );
        }
        if (
          this.extensionsDesiredGeneration === undefined ||
          generation > this.extensionsDesiredGeneration
        ) {
          if (!attemptIsCurrent()) return true;
          this.updateExtensionsDesiredGeneration(generation, false);
          extensionReconciliationRevision =
            this.extensionsReconciliationRevision;
        }
        if (!attemptIsCurrent()) return true;
        this.extensionsAppliedGeneration = generation;
        this.extensionsAppliedEpoch = operationEpoch;
      }
      if (!attemptIsCurrent()) return true;
      this.assertCurrentRuntimeEpoch(operationEpoch, operationEpoch);
      this.setCapabilityStatus(capability, {
        state: 'ready',
        runtimeLive: true,
        ...(capability === 'extensions'
          ? {
              desiredGeneration: this.extensionsDesiredGeneration,
              appliedGeneration: this.extensionsAppliedGeneration,
            }
          : {}),
      });
      return true;
    } catch (error) {
      if (!attemptIsCurrent()) return true;
      if (
        operationEpoch !== undefined &&
        (!this.runtime.bridge.isChannelLive() ||
          this.runtimeEpoch() !== operationEpoch)
      ) {
        this.setCapabilityStatus(capability, {
          state: 'starting',
          runtimeLive: this.runtime.bridge.isChannelLive(),
          ...extensionGenerations,
        });
        return false;
      }
      if (error instanceof WorkspaceRuntimeStillStartingError) {
        this.setCapabilityStatus(capability, {
          state: 'starting',
          runtimeLive: this.runtime.bridge.isChannelLive(),
          ...extensionGenerations,
        });
        return false;
      }
      this.setCapabilityStatus(capability, {
        state: 'error',
        runtimeLive: this.runtime.bridge.isChannelLive(),
        error: {
          code: `${capability}_prepare_failed`,
          message: message(error),
        },
        ...extensionGenerations,
      });
      return true;
    }
  }

  private async resumeCapabilityInBackground(
    capability: ServeWorkspaceRuntimeCapability,
    revision: number,
    deadline: number,
  ): Promise<void> {
    if (this.backgroundResume.get(capability) === revision) return;
    this.backgroundResume.set(capability, revision);
    try {
      while (
        !this.disposed &&
        revision === this.currentCapabilityRevision(capability) &&
        Date.now() < deadline &&
        !(await this.prepareCapability(capability, deadline, revision))
      ) {
        await wait(Math.min(MCP_POLL_INTERVAL_MS, deadline - Date.now()));
      }
      if (
        !this.disposed &&
        revision === this.currentCapabilityRevision(capability) &&
        Date.now() >= deadline &&
        this.capabilityStatus.get(capability)?.state === 'starting'
      ) {
        this.setCapabilityStatus(capability, {
          state: 'error',
          runtimeLive: this.runtime.bridge.isChannelLive(),
          error: {
            code: `${capability}_prepare_timed_out`,
            message: `${capability} runtime preparation timed out`,
          },
        });
      }
    } catch (error) {
      if (this.disposed) return;
      if (isWorkspaceRuntimeDrainingError(error)) {
        this.setCapabilityStatus(capability, {
          state: this.capabilityEpoch.has(capability) ? 'stale' : 'not_started',
          runtimeLive: false,
        });
        return;
      }
      this.setCapabilityStatus(capability, {
        state: 'error',
        runtimeLive: this.runtime.bridge.isChannelLive(),
        error: {
          code: `${capability}_prepare_failed`,
          message: message(error),
        },
      });
    } finally {
      if (this.backgroundResume.get(capability) === revision) {
        this.backgroundResume.delete(capability);
      }
    }
  }

  private async prepareMcp(
    deadline: number,
    operationEpoch: number,
  ): Promise<void> {
    let status = await waitUntilDeadline(
      this.runtime.workspaceService.getWorkspaceMcpStatus(
        requestContext(this.runtime, 'workspace runtime MCP preparation'),
      ),
      deadline,
    );
    this.assertCurrentRuntimeEpoch(status.runtimeEpoch, operationEpoch);
    if (status.discoveryState === 'not_started') {
      await waitUntilDeadline(
        this.runtime.bridge.initializeWorkspaceMcp(),
        deadline,
      );
    }
    while (status.discoveryState !== 'completed') {
      if (status.errors?.length) {
        throw new Error(
          status.errors[0]?.error ?? 'MCP discovery failed to initialize',
        );
      }
      if (Date.now() >= deadline) {
        throw new WorkspaceRuntimeStillStartingError();
      }
      await wait(Math.min(MCP_POLL_INTERVAL_MS, deadline - Date.now()));
      status = await waitUntilDeadline(
        this.runtime.workspaceService.getWorkspaceMcpStatus(
          requestContext(this.runtime, 'workspace runtime MCP preparation'),
        ),
        deadline,
      );
      this.assertCurrentRuntimeEpoch(status.runtimeEpoch, operationEpoch);
    }
    if (status.source !== 'live' || !this.runtime.bridge.isChannelLive()) {
      throw new WorkspaceRuntimeStillStartingError();
    }
  }
}

export function getWorkspaceRuntimeCoordinator(
  runtime: WorkspaceRuntime,
): WorkspaceRuntimeCoordinator {
  runtime.runtimeCoordinator ??= new WorkspaceRuntimeCoordinator(runtime);
  return runtime.runtimeCoordinator;
}
