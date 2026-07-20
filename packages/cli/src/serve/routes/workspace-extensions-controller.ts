/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import {
  ExtensionManager,
  redactUrlCredentials,
  stripAnsiAndControl,
  type ClaudeMarketplaceConfig,
  type ExtensionSetting,
} from '@qwen-code/qwen-code-core';
import type { Request, Response } from 'express';
import { loadSettings } from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';
import {
  STATUS_SCHEMA_VERSION,
  type ServeExtensionCapabilities,
  type ServeExtensionEntry,
  type ServeWorkspaceExtensionsStatus,
} from '@qwen-code/acp-bridge/status';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  getWorkspaceRuntimeCoordinator,
  isWorkspaceRuntimeDrainingError,
  type ExtensionsReconciliationAttempt,
} from '../workspace-runtime-coordinator.js';
import {
  createFifoTaskQueue,
  type FifoTaskQueue,
} from '../extension-operation-scheduler.js';

const MAX_UNFINISHED_EXTENSION_OPERATIONS = 10;

const sanitizeDaemonMessage = (message: string): string =>
  redactUrlCredentials(stripAnsiAndControl(message));

export const redactExtensionDisplaySource = (source: string): string => {
  const redacted = redactUrlCredentials(source);
  if (/^[A-Za-z]:[\\/]/.test(redacted)) return redacted;
  try {
    const url = new URL(redacted);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return redacted;
  }
};

const EXTENSION_PREPARATION_CONCURRENCY = 2;
const EXTENSION_REFRESH_TIMEOUT_MS = 30_000;
const RECONCILE_SLOW_MS = 30_000;

/**
 * Thrown by the per-workspace install queue when it is saturated, and matched
 * by the route layer to emit a 429. Shared so the throw site and the match
 * site (a separate module) can never silently drift apart.
 */
export const EXTENSION_QUEUE_FULL_MESSAGE = 'Extension operation queue is full';

export type ExtensionMutationEvent = {
  status:
    | 'installed'
    | 'enabled'
    | 'disabled'
    | 'updated'
    | 'uninstalled'
    | 'checked'
    | 'refreshed';
  source?: string;
  name?: string;
  version?: string;
  updated?: boolean;
  reason?: string;
  states?: Record<string, string>;
};

export type ExtensionPendingInteraction =
  | {
      id: string;
      kind: 'marketplace_plugin';
      marketplace: { name: string };
      plugins: Array<{
        name: string;
        description?: string;
        source: string;
        category?: string;
        tags?: string[];
      }>;
    }
  | {
      id: string;
      kind: 'setting';
      setting: {
        name: string;
        description: string;
        sensitive: boolean;
      };
    };

export interface ExtensionInteractionHandlers {
  requestSetting(setting: ExtensionSetting): Promise<string>;
  requestChoicePlugin(marketplace: ClaudeMarketplaceConfig): Promise<string>;
}

export type ExtensionOperationStatus = {
  v: 1;
  operationId: string;
  operation: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_for_input'
    | 'succeeded'
    | 'succeeded_with_warnings'
    | 'failed';
  phase?: 'preparing' | 'committing' | 'reconciling';
  createdAt: number;
  updatedAt: number;
  deadlineAt?: number;
  source?: string;
  name?: string;
  result?: ExtensionMutationEvent & {
    refreshed?: number;
    failed?: number;
    error?: string;
    activation?: 'applied' | 'deferred' | 'partial';
  };
  interaction?: ExtensionPendingInteraction;
  error?: string;
  code?: string;
  warnings?: Array<{
    workspaceId?: string;
    workspaceCwd: string;
    code?: string;
    error: string;
  }>;
};

export interface ExtensionOperationContext {
  prepare<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  commit<
    T extends {
      generation: number;
      warnings?: ReadonlyArray<{ code: string; error: string }>;
    },
  >(
    task: (onCommitted: (generation: number) => void) => Promise<T>,
  ): Promise<T>;
}

export interface RuntimeReconciliationReservation {
  run<T>(task: () => Promise<T>): Promise<T>;
  release(): void;
}

export type ReserveRuntimeReconciliation =
  () => RuntimeReconciliationReservation;

export interface CreateExtensionsControllerDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspace: DaemonWorkspaceService;
  acquireManagementOperation?: () => () => void;
  isWorkspaceTrusted?: boolean;
  maxExtensionOperationHistory?: number;
  coordination?: ExtensionsControllerCoordination;
}

export interface ExtensionsControllerCoordination {
  preparationQueue: FifoTaskQueue;
  commitQueue: FifoTaskQueue;
  extensionOperations: Map<string, ExtensionOperationStatus>;
  operationAdmission: { unfinishedCount: number };
}

export function createExtensionsControllerCoordination(): ExtensionsControllerCoordination {
  return {
    preparationQueue: createFifoTaskQueue(EXTENSION_PREPARATION_CONCURRENCY),
    commitQueue: createFifoTaskQueue(1),
    extensionOperations: new Map(),
    operationAdmission: { unfinishedCount: 0 },
  };
}

/** Owner-scoped controller with injectable scheduler and admission state. */
export interface ExtensionsController {
  readonly boundWorkspace: string;
  readonly workspace: DaemonWorkspaceService;
  createExtensionManager(
    workspaceDir?: string,
    isWorkspaceTrusted?: boolean,
    interactions?: ExtensionInteractionHandlers,
  ): ExtensionManager;
  buildLocalExtensionsStatus(): Promise<ServeWorkspaceExtensionsStatus>;
  refreshExtensionsForAllSessions(): Promise<{
    refreshed: number;
    failed: number;
  }>;
  refreshWorkspaceExtensions(): Promise<{
    refreshed: number;
    failed: number;
  }>;
  getOperation(operationId: string): ExtensionOperationStatus | undefined;
  getActiveOperations(): ExtensionOperationStatus[];
  updateOperation(
    operationId: string,
    patch: Partial<Omit<ExtensionOperationStatus, 'operationId' | 'createdAt'>>,
  ): void;
  preparationQueue: FifoTaskQueue;
  acquireOperationSlot(res: Response): (() => void) | undefined;
  validateExtensionMutationClient(
    req: Request,
    res: Response,
    opts?: {
      requireClientId?: boolean;
      bridges?: readonly AcpSessionBridge[];
    },
  ): boolean;
  runQueuedExtensionMutation(
    operation: string,
    failureContext: { source?: string; name?: string },
    res: Response,
    run: (
      extensionManager: ExtensionManager,
      signal?: AbortSignal,
      context?: ExtensionOperationContext,
      operationId?: string,
    ) => Promise<ExtensionMutationEvent>,
    options?: {
      manager?: ExtensionManager;
      createManager?: (operationId: string) => ExtensionManager;
      acquireManagementOperation?: () => () => void;
      onSettled?: (operationId: string) => void;
      refreshRuntimes?:
        | readonly WorkspaceRuntime[]
        | (() => readonly WorkspaceRuntime[]);
      reserveRuntimeReconciliation?: ReserveRuntimeReconciliation;
      operationBasePath?: string;
      skipRefresh?: boolean;
      refreshWorkspaceRuntime?: boolean;
      deadlineMs?: number;
      onRuntimeReconciled?: (
        runtime: WorkspaceRuntime,
        generation: number,
        attempt: ExtensionsReconciliationAttempt | undefined,
      ) => void;
      onRuntimeReconciliationStarted?: (
        runtime: WorkspaceRuntime,
        generation: number,
      ) => ExtensionsReconciliationAttempt | undefined;
      onRuntimeReconciliationFailed?: (
        runtime: WorkspaceRuntime,
        generation: number,
        attempt: ExtensionsReconciliationAttempt | undefined,
        error: unknown,
      ) => void;
      onGenerationCommitted?: (generation: number) => void;
    },
  ): void;
}

export function createExtensionsController(
  deps: CreateExtensionsControllerDeps,
): ExtensionsController {
  const { boundWorkspace, bridge, workspace } = deps;
  const maxExtensionOperationHistory = deps.maxExtensionOperationHistory ?? 100;

  const coordination =
    deps.coordination ?? createExtensionsControllerCoordination();
  const { preparationQueue, commitQueue, extensionOperations } = coordination;

  const acquireOperationSlot = (res: Response): (() => void) | undefined => {
    if (
      coordination.operationAdmission.unfinishedCount >=
      MAX_UNFINISHED_EXTENSION_OPERATIONS
    ) {
      res.status(429).json({
        error: EXTENSION_QUEUE_FULL_MESSAGE,
        code: 'extension_queue_full',
      });
      return undefined;
    }
    coordination.operationAdmission.unfinishedCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      coordination.operationAdmission.unfinishedCount -= 1;
    };
  };

  const createExtensionManager = (
    workspaceDir = boundWorkspace,
    trustedOverride?: boolean,
    interactions?: ExtensionInteractionHandlers,
  ) =>
    new ExtensionManager({
      workspaceDir,
      isWorkspaceTrusted:
        trustedOverride ??
        deps.isWorkspaceTrusted ??
        getWorkspaceTrustStatus(loadSettings(workspaceDir).merged, workspaceDir)
          .effective.state === 'trusted',
      requestConsent: () => Promise.resolve(),
      networkPolicy: 'public',
      requestSetting:
        interactions?.requestSetting ??
        (async (setting: ExtensionSetting) => {
          throw new Error(
            `Extension setting "${setting.envVar}" requires interactive configuration and is not supported over the daemon install endpoint.`,
          );
        }),
      requestChoicePlugin:
        interactions?.requestChoicePlugin ??
        (async () => {
          throw new Error(
            'Marketplace plugin selection is not supported over the daemon install endpoint. Specify a plugin name in the source.',
          );
        }),
    });

  const validateExtensionMutationClient = (
    req: Request,
    res: Response,
    opts: {
      requireClientId?: boolean;
      bridges?: readonly AcpSessionBridge[];
    } = {},
  ): boolean => {
    const clientId = parseAndValidateWorkspaceClientId(
      req,
      res,
      opts.bridges ?? bridge,
    );
    if (clientId === null) return false;
    if (clientId === undefined && opts.requireClientId !== false) {
      res.status(400).json({
        error: 'Missing X-Qwen-Client-Id header',
        code: 'missing_client_id',
      });
      return false;
    }
    return true;
  };

  const isTerminalExtensionOperation = (
    operation: ExtensionOperationStatus,
  ): boolean =>
    operation.status !== 'queued' &&
    operation.status !== 'running' &&
    operation.status !== 'waiting_for_input';
  const redactExtensionOperationResult = (
    event: ExtensionMutationEvent,
  ): ExtensionMutationEvent => ({
    ...event,
    ...(event.source
      ? { source: redactExtensionDisplaySource(event.source) }
      : {}),
  });
  const bridgeMutationEvent = (event: ExtensionMutationEvent) => {
    const redacted = redactExtensionOperationResult(event);
    if (event.status === 'checked' || event.status === 'refreshed') {
      const { status: _status, states: _states, ...bridgeEvent } = redacted;
      return bridgeEvent;
    }
    return redacted;
  };
  const pruneExtensionOperations = (): void => {
    const terminalCount = () =>
      [...extensionOperations.values()].filter(isTerminalExtensionOperation)
        .length;
    while (terminalCount() > maxExtensionOperationHistory) {
      let evicted = false;
      for (const [id, storedOperation] of extensionOperations) {
        if (!isTerminalExtensionOperation(storedOperation)) continue;
        extensionOperations.delete(id);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  };
  const rememberExtensionOperation = (
    operation: ExtensionOperationStatus,
  ): void => {
    extensionOperations.set(operation.operationId, operation);
    pruneExtensionOperations();
  };
  const updateExtensionOperation = (
    operationId: string,
    patch: Partial<Omit<ExtensionOperationStatus, 'operationId' | 'createdAt'>>,
  ): void => {
    const current = extensionOperations.get(operationId);
    if (!current) return;
    extensionOperations.set(operationId, {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    });
    pruneExtensionOperations();
  };

  let extensionsStatusCache:
    | { expiresAt: number; value: ServeWorkspaceExtensionsStatus }
    | undefined;

  const refreshExtensions = async (
    run: () => Promise<{ refreshed: number; failed: number }>,
  ): Promise<{
    refreshed: number;
    failed: number;
  }> => {
    const releaseManagementOperation =
      deps.acquireManagementOperation?.() ?? (() => undefined);
    const queueAbort = new AbortController();
    let releaseCommitLane: (() => void) | undefined;
    const refresh = commitQueue
      .runUntilReleased(
        async (release) => {
          releaseCommitLane = release;
          extensionsStatusCache = undefined;
          return await run();
        },
        { signal: queueAbort.signal },
      )
      .finally(releaseManagementOperation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        refresh,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `extension refresh timed out after ${EXTENSION_REFRESH_TIMEOUT_MS}ms`,
            );
            releaseCommitLane?.();
            queueAbort.abort(error);
            reject(error);
          }, EXTENSION_REFRESH_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const refreshExtensionsForAllSessions = () =>
    refreshExtensions(
      async () => await workspace.refreshExtensionsForAllSessions(),
    );
  const refreshWorkspaceExtensions = () =>
    refreshExtensions(async () =>
      bridge.refreshWorkspaceExtensions
        ? await bridge.refreshWorkspaceExtensions()
        : await bridge.refreshExtensionsForAllSessions(),
    );

  const runQueuedExtensionMutation = (
    operation: string,
    failureContext: { source?: string; name?: string },
    res: Response,
    run: (
      extensionManager: ExtensionManager,
      signal?: AbortSignal,
      context?: ExtensionOperationContext,
      operationId?: string,
    ) => Promise<ExtensionMutationEvent>,
    options: {
      manager?: ExtensionManager;
      createManager?: (operationId: string) => ExtensionManager;
      acquireManagementOperation?: () => () => void;
      onSettled?: (operationId: string) => void;
      refreshRuntimes?:
        | readonly WorkspaceRuntime[]
        | (() => readonly WorkspaceRuntime[]);
      reserveRuntimeReconciliation?: ReserveRuntimeReconciliation;
      operationBasePath?: string;
      skipRefresh?: boolean;
      refreshWorkspaceRuntime?: boolean;
      deadlineMs?: number;
      onRuntimeReconciled?: (
        runtime: WorkspaceRuntime,
        generation: number,
        attempt: ExtensionsReconciliationAttempt | undefined,
      ) => void;
      onRuntimeReconciliationStarted?: (
        runtime: WorkspaceRuntime,
        generation: number,
      ) => ExtensionsReconciliationAttempt | undefined;
      onRuntimeReconciliationFailed?: (
        runtime: WorkspaceRuntime,
        generation: number,
        attempt: ExtensionsReconciliationAttempt | undefined,
        error: unknown,
      ) => void;
      onGenerationCommitted?: (generation: number) => void;
    } = {},
  ): void => {
    const releaseOperationSlot = acquireOperationSlot(res);
    if (!releaseOperationSlot) return;
    let releaseManagementOperation: (() => void) | undefined;
    try {
      releaseManagementOperation =
        options.acquireManagementOperation?.() ??
        deps.acquireManagementOperation?.();
    } catch (error) {
      releaseOperationSlot();
      throw error;
    }
    const operationId = crypto.randomUUID();
    const now = Date.now();
    const deadlineAt = options.deadlineMs
      ? now + options.deadlineMs
      : undefined;
    rememberExtensionOperation({
      v: 1,
      operationId,
      operation,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(failureContext.source
        ? { source: redactExtensionDisplaySource(failureContext.source) }
        : {}),
      ...(failureContext.name ? { name: failureContext.name } : {}),
    });
    const operationBasePath =
      options.operationBasePath ?? '/workspace/extensions/operations';
    try {
      res
        .status(202)
        .location(`${operationBasePath}/${operationId}`)
        .set('Retry-After', '1')
        .json({
          accepted: true,
          operationId,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
        });
    } catch {
      extensionOperations.delete(operationId);
      releaseManagementOperation?.();
      releaseOperationSlot();
      return;
    }
    void (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let committedGeneration: number | undefined;
      let reconciliationReservation:
        | RuntimeReconciliationReservation
        | undefined;
      let mutationEvent: ExtensionMutationEvent | undefined;
      const commitWarnings: NonNullable<ExtensionOperationStatus['warnings']> =
        [];
      const runReconciliation = async <T>(
        task: () => Promise<T>,
      ): Promise<T> => {
        const reservation = reconciliationReservation;
        reconciliationReservation = undefined;
        return reservation ? await reservation.run(task) : await task();
      };
      try {
        updateExtensionOperation(operationId, {
          status: 'running',
          phase: 'preparing',
        });
        const extensionManager =
          options.manager ??
          options.createManager?.(operationId) ??
          createExtensionManager();
        const deadlineController = new AbortController();
        const abortForDeadline = () => {
          const error = new Error(
            `Extension ${operation} exceeded its ${options.deadlineMs}ms operation deadline.`,
          ) as Error & { code: string };
          error.code = 'extension_prepare_timeout';
          deadlineController.abort(error);
        };
        if (deadlineAt !== undefined) {
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs <= 0) {
            abortForDeadline();
          } else {
            deadline = setTimeout(abortForDeadline, remainingMs);
            deadline.unref?.();
          }
        }
        let pendingPreparations = 0;
        let activePreparations = 0;
        const updatePreparationState = () => {
          if (activePreparations > 0) {
            updateExtensionOperation(operationId, {
              status: 'running',
              phase: 'preparing',
            });
          } else if (pendingPreparations > 0) {
            updateExtensionOperation(operationId, {
              status: 'queued',
              phase: undefined,
            });
          }
        };
        const context: ExtensionOperationContext = {
          prepare: async <T>(
            task: (signal: AbortSignal) => Promise<T>,
          ): Promise<T> => {
            pendingPreparations += 1;
            let started = false;
            updatePreparationState();
            try {
              const prepared = await preparationQueue.run(
                async () => {
                  try {
                    return await task(deadlineController.signal);
                  } finally {
                    activePreparations -= 1;
                    updatePreparationState();
                  }
                },
                {
                  signal: deadlineController.signal,
                  onStart: () => {
                    started = true;
                    pendingPreparations -= 1;
                    activePreparations += 1;
                    updatePreparationState();
                  },
                },
              );
              deadlineController.signal.throwIfAborted();
              return prepared;
            } catch (error) {
              if (!started) {
                pendingPreparations -= 1;
                updatePreparationState();
              }
              if (deadlineController.signal.aborted) {
                throw deadlineController.signal.reason;
              }
              throw error;
            }
          },
          commit: async <
            T extends {
              generation: number;
              warnings?: ReadonlyArray<{ code: string; error: string }>;
            },
          >(
            task: (onCommitted: (generation: number) => void) => Promise<T>,
          ): Promise<T> => {
            updateExtensionOperation(operationId, {
              status: 'running',
              phase: 'committing',
            });
            const result = await commitQueue.runUntilReleased(
              async (release) =>
                await task((generation) => {
                  reconciliationReservation ??=
                    options.reserveRuntimeReconciliation?.();
                  committedGeneration = generation;
                  options.onGenerationCommitted?.(generation);
                  release();
                }),
            );
            if (committedGeneration === undefined) {
              reconciliationReservation ??=
                options.reserveRuntimeReconciliation?.();
              committedGeneration = result.generation;
              options.onGenerationCommitted?.(result.generation);
            }
            for (const warning of result.warnings ?? []) {
              commitWarnings.push({
                workspaceCwd: boundWorkspace,
                code: warning.code,
                error: sanitizeDaemonMessage(warning.error).slice(0, 500),
              });
            }
            return result;
          },
        };
        await extensionManager.refreshCache();
        const event = await run(
          extensionManager,
          deadlineController.signal,
          context,
          operationId,
        );
        mutationEvent = event;
        extensionsStatusCache = undefined;
        if (options.skipRefresh || event.updated === false) {
          reconciliationReservation?.release();
          reconciliationReservation = undefined;
          updateExtensionOperation(operationId, {
            status:
              commitWarnings.length > 0
                ? 'succeeded_with_warnings'
                : 'succeeded',
            phase: undefined,
            result: redactExtensionOperationResult(event),
            ...(commitWarnings.length > 0 ? { warnings: commitWarnings } : {}),
          });
          return;
        }
        if (committedGeneration === undefined) {
          committedGeneration = (
            await extensionManager.getExtensionStoreSnapshot()
          ).generation;
          options.onGenerationCommitted?.(committedGeneration);
          reconciliationReservation ??=
            options.reserveRuntimeReconciliation?.();
        }
        updateExtensionOperation(operationId, {
          status: 'running',
          phase: 'reconciling',
        });
        const refreshTargets =
          typeof options.refreshRuntimes === 'function'
            ? options.refreshRuntimes()
            : options.refreshRuntimes;
        if (refreshTargets) {
          const generation = committedGeneration;
          const results = await runReconciliation(
            async () =>
              await Promise.all(
                refreshTargets.map(async (runtime) => {
                  const startedAt = Date.now();
                  let attempt: ExtensionsReconciliationAttempt | undefined;
                  try {
                    return await getWorkspaceRuntimeCoordinator(
                      runtime,
                    ).runExtensionsPhysicalReconciliation(async () => {
                      attempt = options.onRuntimeReconciliationStarted?.(
                        runtime,
                        generation,
                      );
                      if (options.onRuntimeReconciliationStarted && !attempt) {
                        return {
                          status: 'superseded' as const,
                          attempt,
                          elapsedMs: Date.now() - startedAt,
                        };
                      }
                      try {
                        runtime.workspaceService.invalidateWorkspaceSkillsStatus();
                        const refresh = options.refreshWorkspaceRuntime
                          ? (runtime.bridge.refreshWorkspaceExtensions?.bind(
                              runtime.bridge,
                            ) ??
                            runtime.bridge.refreshExtensionsForAllSessions.bind(
                              runtime.bridge,
                            ))
                          : runtime.bridge.refreshExtensionsForAllSessions.bind(
                              runtime.bridge,
                            );
                        return {
                          status: 'fulfilled' as const,
                          result: await refresh(bridgeMutationEvent(event)),
                          attempt,
                          elapsedMs: Date.now() - startedAt,
                        };
                      } catch (reason) {
                        return {
                          status: 'rejected' as const,
                          reason,
                          attempt,
                          elapsedMs: Date.now() - startedAt,
                        };
                      }
                    });
                  } catch (reason) {
                    return isWorkspaceRuntimeDrainingError(reason)
                      ? {
                          status: 'superseded' as const,
                          attempt,
                          elapsedMs: Date.now() - startedAt,
                        }
                      : {
                          status: 'rejected' as const,
                          reason,
                          attempt,
                          elapsedMs: Date.now() - startedAt,
                        };
                  }
                }),
              ),
          );
          let refreshed = 0;
          let failed = 0;
          let superseded = 0;
          const warnings: NonNullable<ExtensionOperationStatus['warnings']> = [
            ...commitWarnings,
          ];
          for (let index = 0; index < results.length; index += 1) {
            const settled = results[index]!;
            const runtime = refreshTargets[index]!;
            if (settled.status === 'superseded') {
              superseded += 1;
            } else if (settled.status === 'fulfilled') {
              const runtimeGeneration =
                'generation' in settled.result &&
                typeof settled.result.generation === 'number'
                  ? settled.result.generation
                  : undefined;
              const runtimeEpoch =
                'runtimeEpoch' in settled.result &&
                typeof settled.result.runtimeEpoch === 'number'
                  ? settled.result.runtimeEpoch
                  : undefined;
              if (
                options.refreshWorkspaceRuntime &&
                settled.attempt &&
                runtimeEpoch !== settled.attempt.runtimeEpoch
              ) {
                failed += 1;
                const error = new Error(
                  `Workspace runtime epoch changed during extension reconciliation (expected ${settled.attempt.runtimeEpoch}, received ${runtimeEpoch ?? 'none'}).`,
                );
                options.onRuntimeReconciliationFailed?.(
                  runtime,
                  generation,
                  settled.attempt,
                  error,
                );
                warnings.push({
                  workspaceId: runtime.workspaceId,
                  workspaceCwd: runtime.workspaceCwd,
                  code: 'runtime_epoch_changed',
                  error: error.message,
                });
              } else if (settled.result.failed > 0) {
                refreshed += settled.result.refreshed;
                failed += settled.result.failed;
                const error = new Error(
                  `${settled.result.failed} extension runtime refresh(es) failed`,
                );
                options.onRuntimeReconciliationFailed?.(
                  runtime,
                  generation,
                  settled.attempt,
                  error,
                );
                warnings.push({
                  workspaceId: runtime.workspaceId,
                  workspaceCwd: runtime.workspaceCwd,
                  error: `${settled.result.failed} session refresh(es) failed`,
                });
              } else if (
                options.refreshWorkspaceRuntime &&
                runtimeGeneration === undefined
              ) {
                failed += 1;
                const error = new Error(
                  'Runtime refresh succeeded without an applied extension generation.',
                );
                options.onRuntimeReconciliationFailed?.(
                  runtime,
                  generation,
                  settled.attempt,
                  error,
                );
                warnings.push({
                  workspaceId: runtime.workspaceId,
                  workspaceCwd: runtime.workspaceCwd,
                  code: 'runtime_generation_missing',
                  error:
                    'Runtime refresh succeeded without an applied extension generation.',
                });
              } else if (
                runtimeGeneration !== undefined &&
                runtimeGeneration < generation
              ) {
                failed += 1;
                const error = new Error(
                  `Runtime applied extension generation ${runtimeGeneration}, expected at least ${generation}.`,
                );
                options.onRuntimeReconciliationFailed?.(
                  runtime,
                  generation,
                  settled.attempt,
                  error,
                );
                warnings.push({
                  workspaceId: runtime.workspaceId,
                  workspaceCwd: runtime.workspaceCwd,
                  code: 'runtime_generation_stale',
                  error: `Runtime applied extension generation ${runtimeGeneration}, expected at least ${generation}.`,
                });
              } else {
                refreshed += settled.result.refreshed;
                options.onRuntimeReconciled?.(
                  runtime,
                  runtimeGeneration ?? generation,
                  settled.attempt,
                );
              }
            } else {
              failed += 1;
              options.onRuntimeReconciliationFailed?.(
                runtime,
                generation,
                settled.attempt,
                settled.reason,
              );
              const message = sanitizeDaemonMessage(
                settled.reason instanceof Error
                  ? settled.reason.message
                  : String(settled.reason),
              );
              warnings.push({
                workspaceId: runtime.workspaceId,
                workspaceCwd: runtime.workspaceCwd,
                error: message.slice(0, 500),
              });
              try {
                runtime.bridge.broadcastExtensionsChanged({
                  ...bridgeMutationEvent(event),
                  refreshed: 0,
                  failed: 1,
                  error: message.slice(0, 500),
                });
              } catch {
                // The warning already records the refresh failure; a failed
                // notification must not turn a committed mutation into a
                // failed operation.
              }
            }
            if (settled.elapsedMs > RECONCILE_SLOW_MS) {
              warnings.push({
                workspaceId: runtime.workspaceId,
                workspaceCwd: runtime.workspaceCwd,
                code: 'reconcile_slow',
                error: `Runtime reconciliation took ${settled.elapsedMs}ms.`,
              });
            }
          }
          updateExtensionOperation(operationId, {
            status:
              warnings.length > 0 ? 'succeeded_with_warnings' : 'succeeded',
            phase: undefined,
            result: {
              ...redactExtensionOperationResult(event),
              refreshed,
              failed,
              activation:
                refreshTargets.length === 0 ||
                superseded === refreshTargets.length
                  ? 'deferred'
                  : failed > 0 || superseded > 0
                    ? 'partial'
                    : 'applied',
            },
            ...(warnings.length > 0 ? { warnings } : {}),
          });
        } else {
          try {
            const { result, elapsedMs } = await runReconciliation(async () => {
              workspace.invalidateWorkspaceSkillsStatus();
              const startedAt = Date.now();
              const refresh = options.refreshWorkspaceRuntime
                ? (bridge.refreshWorkspaceExtensions?.bind(bridge) ??
                  bridge.refreshExtensionsForAllSessions.bind(bridge))
                : bridge.refreshExtensionsForAllSessions.bind(bridge);
              const result = await refresh(bridgeMutationEvent(event));
              return { result, elapsedMs: Date.now() - startedAt };
            });
            const warnings: NonNullable<ExtensionOperationStatus['warnings']> =
              [...commitWarnings];
            if (result.failed > 0) {
              warnings.push({
                workspaceCwd: boundWorkspace,
                error: `${result.failed} session refresh(es) failed`,
              });
            }
            if (elapsedMs > RECONCILE_SLOW_MS) {
              warnings.push({
                workspaceCwd: boundWorkspace,
                code: 'reconcile_slow',
                error: `Runtime reconciliation took ${elapsedMs}ms.`,
              });
            }
            updateExtensionOperation(operationId, {
              status:
                warnings.length > 0 ? 'succeeded_with_warnings' : 'succeeded',
              phase: undefined,
              result: {
                ...redactExtensionOperationResult(event),
                refreshed: result.refreshed,
                failed: result.failed,
                activation: result.failed > 0 ? 'partial' : 'applied',
              },
              ...(warnings.length > 0 ? { warnings } : {}),
            });
            writeStderrLine(
              `qwen serve: [${boundWorkspace}] extensions ${operation}: refreshed ${result.refreshed} session(s), ${result.failed} failed`,
            );
          } catch (refreshErr) {
            const message = sanitizeDaemonMessage(
              refreshErr instanceof Error
                ? refreshErr.message
                : String(refreshErr),
            );
            updateExtensionOperation(operationId, {
              status: 'succeeded_with_warnings',
              phase: undefined,
              result: {
                ...redactExtensionOperationResult(event),
                refreshed: 0,
                failed: 1,
                error: message.slice(0, 500),
              },
              warnings: [
                ...commitWarnings,
                {
                  workspaceCwd: boundWorkspace,
                  error: message.slice(0, 500),
                },
              ],
            });
            try {
              bridge.broadcastExtensionsChanged({
                ...bridgeMutationEvent(event),
                refreshed: 0,
                failed: 1,
                error: message.slice(0, 500),
              });
            } catch (broadcastErr) {
              writeStderrLine(
                `qwen serve: [${boundWorkspace}] extensions ${operation}: failed to broadcast refresh failure: ${sanitizeDaemonMessage(
                  broadcastErr instanceof Error
                    ? broadcastErr.message
                    : String(broadcastErr),
                )}`,
              );
            }
            writeStderrLine(
              `qwen serve: [${boundWorkspace}] extensions ${operation}: mutation succeeded but refresh failed: ${message}`,
            );
          }
        }
      } catch (err) {
        const message = sanitizeDaemonMessage(
          err instanceof Error ? err.message : String(err),
        );
        const code =
          err &&
          typeof err === 'object' &&
          typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : undefined;
        if (committedGeneration !== undefined) {
          extensionsStatusCache = undefined;
          const error =
            `Commit succeeded but post-commit work failed: ${message}`.slice(
              0,
              500,
            );
          const warnings: NonNullable<ExtensionOperationStatus['warnings']> = [
            ...commitWarnings,
            {
              workspaceCwd: boundWorkspace,
              code: 'post_commit_failed',
              error,
            },
          ];
          try {
            workspace.invalidateWorkspaceSkillsStatus();
          } catch (invalidationError) {
            warnings.push({
              workspaceCwd: boundWorkspace,
              code: 'status_invalidation_failed',
              error: sanitizeDaemonMessage(
                invalidationError instanceof Error
                  ? invalidationError.message
                  : String(invalidationError),
              ).slice(0, 500),
            });
          }
          updateExtensionOperation(operationId, {
            status: 'succeeded_with_warnings',
            phase: undefined,
            ...(mutationEvent
              ? { result: redactExtensionOperationResult(mutationEvent) }
              : {}),
            warnings,
          });
          try {
            bridge.broadcastExtensionsChanged({
              ...(mutationEvent
                ? bridgeMutationEvent(mutationEvent)
                : {
                    ...(failureContext.source
                      ? {
                          source: redactExtensionDisplaySource(
                            failureContext.source,
                          ),
                        }
                      : {}),
                    ...(failureContext.name
                      ? { name: failureContext.name }
                      : {}),
                  }),
              refreshed: 0,
              failed: 1,
              error,
            });
          } catch {
            // The operation record remains authoritative for this warning.
          }
          try {
            writeStderrLine(
              `qwen serve: [${boundWorkspace}] extensions ${operation}: ${error}`,
            );
          } catch {
            // Keep queued background work from surfacing as unhandledRejection.
          }
          return;
        }
        updateExtensionOperation(operationId, {
          status: 'failed',
          phase: undefined,
          interaction: undefined,
          error: message.slice(0, 500),
          ...(code ? { code } : {}),
        });
        try {
          bridge.broadcastExtensionsChanged({
            status: 'failed',
            ...(failureContext.source
              ? { source: redactExtensionDisplaySource(failureContext.source) }
              : {}),
            ...(failureContext.name ? { name: failureContext.name } : {}),
            refreshed: 0,
            failed: 0,
            error: message.slice(0, 500),
          });
        } catch (broadcastErr) {
          writeStderrLine(
            `qwen serve: [${boundWorkspace}] extensions ${operation}: failed to broadcast failure: ${sanitizeDaemonMessage(
              broadcastErr instanceof Error
                ? broadcastErr.message
                : String(broadcastErr),
            )}`,
          );
        }
        try {
          writeStderrLine(
            `qwen serve: [${boundWorkspace}] extensions ${operation}: background task failed: ${message}`,
          );
        } catch {
          // Keep queued background work from surfacing as unhandledRejection.
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        reconciliationReservation?.release();
        try {
          options.onSettled?.(operationId);
        } finally {
          releaseManagementOperation?.();
          releaseOperationSlot();
        }
      }
    })();
  };

  const buildLocalExtensionsStatus =
    async (): Promise<ServeWorkspaceExtensionsStatus> => {
      const now = Date.now();
      if (extensionsStatusCache && extensionsStatusCache.expiresAt > now) {
        return extensionsStatusCache.value;
      }
      const extensionManager = createExtensionManager();
      const snapshot = await extensionManager.refreshCacheWithSnapshot();
      const entries: ServeExtensionEntry[] = extensionManager
        .getLoadedExtensions()
        .map((ext): ServeExtensionEntry => {
          const activation =
            extensionManager.getExtensionActivationFromSnapshot(
              ext.id,
              snapshot,
              boundWorkspace,
            );
          const capabilities: ServeExtensionCapabilities = {
            mcpServerCount: ext.mcpServers
              ? Object.keys(ext.mcpServers).length
              : 0,
            skillCount: ext.skills?.length ?? 0,
            agentCount: ext.agents?.length ?? 0,
            hookCount: ext.hooks
              ? Object.values(ext.hooks).reduce(
                  (sum, defs) => sum + (defs?.length ?? 0),
                  0,
                )
              : 0,
            commandCount: ext.commands?.length ?? 0,
            contextFileCount: ext.contextFiles.length,
            channelCount: ext.channels ? Object.keys(ext.channels).length : 0,
            hasSettings: (ext.settings?.length ?? 0) > 0,
          };
          return {
            kind: 'extension',
            id: ext.id,
            name: ext.name,
            ...(ext.displayName ? { displayName: ext.displayName } : {}),
            ...(ext.config.description
              ? { description: ext.config.description }
              : {}),
            version: ext.version,
            isActive: ext.isActive,
            defaultActivation: activation.default,
            workspaceActivation:
              activation.workspace === 'inherit' &&
              activation.source === 'legacy_path_rule'
                ? activation.effective
                : activation.workspace,
            path: ext.path,
            ...(ext.installMetadata?.source
              ? {
                  source: redactExtensionDisplaySource(
                    ext.installMetadata.source,
                  ),
                }
              : {}),
            ...(ext.installMetadata?.type
              ? { installType: ext.installMetadata.type }
              : {}),
            ...(ext.installMetadata?.originSource
              ? { originSource: ext.installMetadata.originSource }
              : {}),
            ...(ext.installMetadata?.ref
              ? { ref: ext.installMetadata.ref }
              : {}),
            ...(ext.installMetadata?.autoUpdate !== undefined
              ? { autoUpdate: ext.installMetadata.autoUpdate }
              : {}),
            updateState: ext.installMetadata ? 'unknown' : 'not updatable',
            capabilities,
            details: {
              mcpServers: ext.mcpServers ? Object.keys(ext.mcpServers) : [],
              commands: ext.commands ?? [],
              skills: ext.skills?.map((skill) => skill.name) ?? [],
              agents: ext.agents?.map((agent) => agent.name) ?? [],
              contextFiles: ext.contextFiles,
              settings:
                ext.resolvedSettings?.map((setting) => setting.name) ?? [],
            },
          };
        });
      const status = {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        initialized: true,
        extensions: entries,
      };
      extensionsStatusCache = {
        expiresAt: Date.now() + 2_000,
        value: status,
      };
      return status;
    };

  return {
    boundWorkspace,
    workspace,
    createExtensionManager,
    buildLocalExtensionsStatus,
    refreshExtensionsForAllSessions,
    refreshWorkspaceExtensions,
    getOperation: (operationId) => extensionOperations.get(operationId),
    getActiveOperations: () =>
      [...extensionOperations.values()].filter(
        (operation) => !isTerminalExtensionOperation(operation),
      ),
    updateOperation: updateExtensionOperation,
    preparationQueue,
    acquireOperationSlot,
    validateExtensionMutationClient,
    runQueuedExtensionMutation,
  };
}
