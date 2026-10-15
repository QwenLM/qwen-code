/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import {
  redactExtensionDisplaySource,
  toExtensionEntry,
  toExtensionSummary,
} from './extension-status.js';
import {
  ExtensionManager,
  parseBooleanEnvFlag,
  redactUrlCredentials,
  resolveExtensionTelemetryProxy,
  resolveUsageStatisticsEnabled,
  stripAnsiAndControl,
  type ClaudeMarketplaceConfig,
  type ExtensionSetting,
} from '@qwen-code/qwen-code-core';
import type { Request, Response } from 'express';
import { loadSettings, type Settings } from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import {
  detectSystemLanguage,
  resolveLanguageSetting,
} from '../../i18n/index.js';
import { resolveSupportedLanguage } from '../../i18n/languages.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';
import {
  STATUS_SCHEMA_VERSION,
  type ServeExtensionEntry,
  type ServeWorkspaceExtensionsStatus,
  type ServeWorkspaceExtensionSummaries,
} from '@qwen-code/acp-bridge/status';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  createFifoTaskQueue,
  type FifoTaskQueue,
} from '../extension-operation-scheduler.js';

const MAX_UNFINISHED_EXTENSION_OPERATIONS = 10;

const sanitizeDaemonMessage = (message: string): string =>
  redactUrlCredentials(stripAnsiAndControl(message));

export { redactExtensionDisplaySource } from './extension-status.js';

const EXTENSION_PREPARATION_CONCURRENCY = 2;
const EXTENSION_REFRESH_TIMEOUT_MS = 30_000;
const RECONCILE_SLOW_MS = 30_000;

const resolveExtensionLocale = (mergedSettings: Settings): string => {
  const configuredLanguage = mergedSettings.general?.language as
    | string
    | undefined;
  const requestedLocale = resolveLanguageSetting(configuredLanguage);
  if (requestedLocale === 'auto') {
    return detectSystemLanguage();
  }

  return resolveSupportedLanguage(requestedLocale) ?? requestedLocale;
};

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
  credentialPersistence?: 'stored' | 'one_time';
  credentialStorage?: 'keychain' | 'encrypted_file';
  updated?: boolean;
  reason?: string;
  states?: Record<string, string>;
  resourceStates?: {
    skills: Array<{
      name: string;
      defaultEnabled: boolean;
      workspaceEnabled: boolean | null;
      effectiveEnabled: boolean;
      disabledReason?: 'hard' | 'default' | 'inactive_extension';
      lockedScope?: 'system' | 'user' | 'systemDefaults';
    }>;
  };
  results?: Array<
    | {
        name: string;
        defaultActivation: 'enabled' | 'disabled';
      }
    | {
        name: string;
        workspaceActivation: 'enabled' | 'disabled' | null;
        effectiveActivation: 'enabled' | 'disabled';
      }
  >;
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
  source?: string;
  name?: string;
  result?: ExtensionMutationEvent & {
    refreshed?: number;
    failed?: number;
    error?: string;
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
  maxExtensionOperationHistory?: number;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
  /**
   * The resolved environment of the runtime that owns `boundWorkspace` —
   * `buildRuntimeEnvironment`'s `effectiveEnv`, the same value
   * `resolveSetupGithubProxy(boundWorkspace, deps.env, ...)` receives. It is
   * never the daemon's ambient `process.env`: one daemon hosts every
   * workspace, so an ambient value is not attributable to this one.
   *
   * Scoped to `boundWorkspace`, not to every manager this controller builds:
   * `createExtensionManager` applies it only when `workspaceDir ===
   * boundWorkspace`. A manager with no attributable env — another hosted
   * workspace, or this one after its runtime left `active` — resolves proxy
   * from that directory's own settings alone, and resolves consent from those
   * settings plus an ambient *opt-out* only: `QWEN_USAGE_STATISTICS_ENABLED`
   * is not in `DEFAULT_EXCLUDED_ENV_VARS`, and `loadEnvironment` writes parsed
   * `.env` keys into `process.env` without restoring them, so an ambient
   * opt-IN can belong to some other hosted repo and must not re-open this
   * one's gate. A secondary runtime's own env is not visible here;
   * attributing it would need a `workspaceDir`-keyed resolver rather than
   * this single field.
   */
  env?: Readonly<NodeJS.ProcessEnv>;
}

/** Shared coordinator for the legacy adapter and V2 global operations. */
export interface ExtensionsController {
  readonly boundWorkspace: string;
  readonly workspace: DaemonWorkspaceService;
  createExtensionManager(
    workspaceDir?: string,
    isWorkspaceTrusted?: boolean,
    interactions?: ExtensionInteractionHandlers,
  ): ExtensionManager;
  buildLocalExtensionsStatus(): Promise<ServeWorkspaceExtensionsStatus>;
  buildLocalExtensionSummaries(): Promise<ServeWorkspaceExtensionSummaries>;
  buildLocalExtensionDetails(name: string): Promise<ServeExtensionEntry | null>;
  refreshExtensionsForAllSessions(): Promise<{
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
      onSettled?: (operationId: string) => void;
      refreshRuntimes?:
        | readonly WorkspaceRuntime[]
        | (() => readonly WorkspaceRuntime[]);
      reserveRuntimeReconciliation?: ReserveRuntimeReconciliation;
      operationBasePath?: string;
      skipRefresh?: boolean;
      skillsOnly?: boolean;
      deadlineMs?: number;
      onRuntimeReconciled?: (
        runtime: WorkspaceRuntime,
        generation: number,
      ) => void;
      assertGenerationOpen?: () => void;
    },
  ): void;
}

export function createExtensionsController(
  deps: CreateExtensionsControllerDeps,
): ExtensionsController {
  const { boundWorkspace, bridge, workspace } = deps;
  const maxExtensionOperationHistory = deps.maxExtensionOperationHistory ?? 100;

  const preparationQueue = createFifoTaskQueue(
    EXTENSION_PREPARATION_CONCURRENCY,
  );
  const commitQueue = createFifoTaskQueue(1);
  let unfinishedOperationCount = 0;

  const acquireOperationSlot = (res: Response): (() => void) | undefined => {
    if (unfinishedOperationCount >= MAX_UNFINISHED_EXTENSION_OPERATIONS) {
      res.status(429).json({
        error: EXTENSION_QUEUE_FULL_MESSAGE,
        code: 'extension_queue_full',
      });
      return undefined;
    }
    unfinishedOperationCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unfinishedOperationCount -= 1;
    };
  };

  const createExtensionManager = (
    workspaceDir = boundWorkspace,
    trustedOverride?: boolean,
    interactions?: ExtensionInteractionHandlers,
  ) => {
    const workspaceTrusted = trustedOverride ?? deps.isWorkspaceTrusted?.();
    // One trust-gated load per call, shared by the locale, the trust fallback
    // and the telemetry options below. `skipLoadEnvironment` keeps this
    // workspace's own `.env` / `settings.env` out of the daemon's shared
    // `process.env`: one daemon hosts every workspace, so writing there leaks
    // one repo's values into every other workspace's resolution for the
    // process lifetime. The trust options are what `resolveExtensionLocale`
    // used to resolve on its own, so both now read one consistent view of the
    // same workspace file.
    // `consumeCorruptionEnvVars: false` because this load surfaces neither the
    // corruption marker nor the recovery notice, and the pair is one-shot: the
    // default (`?? true`) would delete it here and leave the load that does
    // surface it nothing to report for the rest of the daemon's life. The
    // extensions routes already read it this way (`workspace-extensions.ts`).
    const settings = loadSettings(
      workspaceDir,
      workspaceTrusted === undefined
        ? { skipLoadEnvironment: true, consumeCorruptionEnvVars: false }
        : {
            skipLoadEnvironment: true,
            skipWorkspaceSettings: !workspaceTrusted,
            workspaceTrusted,
            consumeCorruptionEnvVars: false,
          },
    ).merged;
    // `deps.env` is the bound runtime's LIVE env delegate: every read goes
    // through `requirePrimaryRuntime()`, which throws once that entry leaves
    // `active` — something the trust reconciler does in normal operation. So
    // bind the term to the one workspace this controller owns (a manager built
    // for another directory must not inherit its consent or proxy), and
    // tolerate a non-active runtime so a property read cannot throw out of a
    // route that is serving a different workspace.
    const runtimeEnv = ((): Readonly<NodeJS.ProcessEnv> | undefined => {
      if (workspaceDir !== boundWorkspace || !deps.env) return undefined;
      try {
        return { ...deps.env };
      } catch {
        return undefined;
      }
    })();
    // Consent term for the no-attributable-env case. Passing `undefined`
    // through would land on `resolveUsageStatisticsEnabled`'s `env =
    // process.env` default, i.e. resolve the opt-in from the daemon's shared
    // ambient env — which is not neutral: `loadEnvironment` writes parsed
    // `.env` keys into `process.env` in no-override mode and never restores
    // them, `canApplyParsedEnvKey` has no trust gate, and
    // `QWEN_USAGE_STATISTICS_ENABLED` is excluded from neither
    // `DEFAULT_EXCLUDED_ENV_VARS` nor `PROJECT_ENV_HARDCODED_EXCLUSIONS`. So
    // one hosted repo publishing `QWEN_USAGE_STATISTICS_ENABLED=1` would
    // re-open the gate for a different workspace whose own settings opt out,
    // and that workspace's extension lifecycle events would upload (#12770).
    // The narrowing is one-directional on purpose: an ambient *opt-out* is an
    // operator decision about this daemon and must still close every gate
    // here, while an ambient *opt-in* is not this workspace's to inherit.
    const ambientConsent = parseBooleanEnvFlag(
      process.env['QWEN_USAGE_STATISTICS_ENABLED'],
    );
    const consentEnv: Readonly<NodeJS.ProcessEnv> =
      runtimeEnv ??
      (ambientConsent === false
        ? {
            QWEN_USAGE_STATISTICS_ENABLED:
              process.env['QWEN_USAGE_STATISTICS_ENABLED'],
          }
        : {});
    return new ExtensionManager({
      workspaceDir,
      locale: resolveExtensionLocale(settings),
      isWorkspaceTrusted:
        workspaceTrusted ??
        getWorkspaceTrustStatus(settings, workspaceDir).effective.state ===
          'trusted',
      // Consent and proxy resolve against the bound runtime's environment
      // when there is one, never against the ambient `process.env` that every
      // hosted workspace shares and that no workspace's settings load may
      // write to (see `skipLoadEnvironment` above). With no attributable env
      // — a manager built for another hosted directory, or for this one after
      // its runtime left `active` — proxy stays settings-only, because an
      // ambient proxy is not this workspace's and would route its RUM uploads
      // through an egress path it never configured, and consent keeps only the
      // ambient opt-out (see `consentEnv` above): both terms then resolve from
      // that directory's own settings, except that an operator's daemon-wide
      // opt-out still closes the gate.
      usageStatisticsEnabled: resolveUsageStatisticsEnabled(
        settings.privacy?.usageStatisticsEnabled,
        consentEnv,
      ),
      proxy: resolveExtensionTelemetryProxy(settings.proxy, runtimeEnv ?? {}),
      requestConsent: () => Promise.resolve(),
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
  };

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

  const extensionOperations = new Map<string, ExtensionOperationStatus>();
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
    | {
        locale: string;
        trusted: boolean;
        expiresAt: number;
        value: ServeWorkspaceExtensionsStatus;
      }
    | undefined;

  let extensionsStatusInFlight:
    | {
        locale: string;
        trusted: boolean;
        promise: Promise<ServeWorkspaceExtensionsStatus>;
      }
    | undefined;

  const invalidateExtensionsStatus = (): void => {
    extensionsStatusCache = undefined;
    extensionsStatusInFlight = undefined;
  };

  const refreshExtensionsForAllSessions = async (): Promise<{
    refreshed: number;
    failed: number;
  }> => {
    const queueAbort = new AbortController();
    let releaseCommitLane: (() => void) | undefined;
    const refresh = commitQueue.runUntilReleased(
      async (release) => {
        releaseCommitLane = release;
        invalidateExtensionsStatus();
        return await workspace.refreshExtensionsForAllSessions();
      },
      { signal: queueAbort.signal },
    );
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
      onSettled?: (operationId: string) => void;
      refreshRuntimes?:
        | readonly WorkspaceRuntime[]
        | (() => readonly WorkspaceRuntime[]);
      reserveRuntimeReconciliation?: ReserveRuntimeReconciliation;
      operationBasePath?: string;
      skipRefresh?: boolean;
      skillsOnly?: boolean;
      deadlineMs?: number;
      onRuntimeReconciled?: (
        runtime: WorkspaceRuntime,
        generation: number,
      ) => void;
      assertGenerationOpen?: () => void;
    } = {},
  ): void => {
    const assertGenerationOpen =
      options.assertGenerationOpen ?? deps.captureGenerationAssertion?.();
    assertGenerationOpen?.();
    const releaseOperationSlot = acquireOperationSlot(res);
    if (!releaseOperationSlot) return;
    const operationId = crypto.randomUUID();
    const now = Date.now();
    rememberExtensionOperation({
      v: 1,
      operationId,
      operation,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
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
        .json({ accepted: true, operationId });
    } catch {
      extensionOperations.delete(operationId);
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
        assertGenerationOpen?.();
        updateExtensionOperation(operationId, {
          status: 'running',
          phase: 'preparing',
        });
        const extensionManager =
          options.manager ??
          options.createManager?.(operationId) ??
          createExtensionManager();
        const deadlineController = new AbortController();
        let deadlineStarted = false;
        const startDeadline = () => {
          if (deadlineStarted) return;
          deadlineStarted = true;
          if (options.deadlineMs) {
            deadline = setTimeout(() => {
              const error = new Error(
                `Extension ${operation} exceeded its ${options.deadlineMs}ms preparation deadline.`,
              ) as Error & { code: string };
              error.code = 'extension_prepare_timeout';
              deadlineController.abort(error);
            }, options.deadlineMs);
            deadline.unref?.();
          }
        };
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
                    assertGenerationOpen?.();
                    return await task(deadlineController.signal);
                  } finally {
                    activePreparations -= 1;
                    updatePreparationState();
                  }
                },
                {
                  signal: deadlineController.signal,
                  onStart: () => {
                    startDeadline();
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
            assertGenerationOpen?.();
            updateExtensionOperation(operationId, {
              status: 'running',
              phase: 'committing',
            });
            const result = await commitQueue.runUntilReleased(
              async (release) => {
                assertGenerationOpen?.();
                return await task((generation) => {
                  // sendOperation passes reserveRuntimeReconciliation even on
                  // skipRefresh routes; an operation that will not reconcile
                  // never runs a reservation, so it must not take one.
                  if (!options.skipRefresh) {
                    reconciliationReservation ??=
                      options.reserveRuntimeReconciliation?.();
                  }
                  committedGeneration = generation;
                  release();
                });
              },
            );
            if (committedGeneration === undefined) {
              if (!options.skipRefresh) {
                reconciliationReservation ??=
                  options.reserveRuntimeReconciliation?.();
              }
              committedGeneration = result.generation;
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
        if (deadline) clearTimeout(deadline);
        invalidateExtensionsStatus();
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
          const results = await runReconciliation(
            async () =>
              await Promise.all(
                refreshTargets.map(async (runtime) => {
                  const startedAt = Date.now();
                  try {
                    runtime.workspaceService.invalidateWorkspaceSkillsStatus();
                    try {
                      return {
                        status: 'fulfilled' as const,
                        result:
                          await runtime.bridge.refreshExtensionsForAllSessions(
                            bridgeMutationEvent(event),
                            ...(options.skillsOnly
                              ? [{ skillsOnly: true }]
                              : []),
                          ),
                        elapsedMs: Date.now() - startedAt,
                      };
                    } finally {
                      runtime.workspaceService.invalidateWorkspaceSkillsStatus();
                    }
                  } catch (reason) {
                    return {
                      status: 'rejected' as const,
                      reason,
                      elapsedMs: Date.now() - startedAt,
                    };
                  }
                }),
              ),
          );
          let refreshed = 0;
          let failed = 0;
          const warnings: NonNullable<ExtensionOperationStatus['warnings']> = [
            ...commitWarnings,
          ];
          for (let index = 0; index < results.length; index += 1) {
            const settled = results[index]!;
            const runtime = refreshTargets[index]!;
            if (settled.status === 'fulfilled') {
              refreshed += settled.result.refreshed;
              failed += settled.result.failed;
              if (settled.result.failed > 0) {
                warnings.push({
                  workspaceId: runtime.workspaceId,
                  workspaceCwd: runtime.workspaceCwd,
                  error: `${settled.result.failed} session refresh(es) failed`,
                });
              } else {
                options.onRuntimeReconciled?.(runtime, committedGeneration);
              }
            } else {
              failed += 1;
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
            },
            ...(warnings.length > 0 ? { warnings } : {}),
          });
        } else {
          try {
            const { result, elapsedMs } = await runReconciliation(async () => {
              workspace.invalidateWorkspaceSkillsStatus();
              const startedAt = Date.now();
              try {
                const result = await bridge.refreshExtensionsForAllSessions(
                  bridgeMutationEvent(event),
                  ...(options.skillsOnly ? [{ skillsOnly: true }] : []),
                );
                return { result, elapsedMs: Date.now() - startedAt };
              } finally {
                workspace.invalidateWorkspaceSkillsStatus();
              }
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
          invalidateExtensionsStatus();
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
        options.onSettled?.(operationId);
        releaseOperationSlot();
      }
    })();
  };

  const loadLocalExtensionsStatus = async (
    trusted: boolean,
  ): Promise<ServeWorkspaceExtensionsStatus> => {
    const extensionManager = createExtensionManager(boundWorkspace, trusted);
    await extensionManager.refreshCache();
    const entries: ServeExtensionEntry[] = extensionManager
      .getLoadedExtensions()
      .map(toExtensionEntry);
    const status = {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd: boundWorkspace,
      initialized: true,
      extensions: entries,
    };
    return status;
  };

  const buildLocalExtensionsStatus =
    async (): Promise<ServeWorkspaceExtensionsStatus> => {
      // `skipLoadEnvironment` for the same reason as the load in
      // `createExtensionManager`: this route is trust-free and reachable with
      // a single GET, so writing the bound workspace's `.env` /
      // `settings.env` into the daemon's shared `process.env` would publish
      // one repo's values to every other workspace the daemon hosts for the
      // process lifetime. `consumeCorruptionEnvVars: false` for the reason
      // stated there too: this poll is the most frequently hit load in the
      // daemon, so letting it spend the one-shot marker it never surfaces
      // would drop the signal for every hosted workspace.
      //
      // The probe stays ungated only where it is actually read. An
      // authoritative `false` from `isWorkspaceTrusted` short-circuits
      // `trusted`, so probing there would parse an untrusted workspace's own
      // `.qwen/settings.json` and then throw the result away — and parsing
      // runs the migration / corruption-recovery path, which REWRITES that
      // file (injecting `$version`, or resetting invalid JSON to `{}` beside
      // a `.corrupted` sibling). A trust-free, read-only-by-contract status
      // poll must not mutate the workspace it reports on, so that arm
      // performs exactly one load: the gated one below.
      const trustedFromDeps = deps.isWorkspaceTrusted?.();
      const probeSettings =
        trustedFromDeps === false
          ? undefined
          : loadSettings(boundWorkspace, {
              skipLoadEnvironment: true,
              consumeCorruptionEnvVars: false,
            }).merged;
      const trusted =
        trustedFromDeps ??
        (probeSettings !== undefined &&
          getWorkspaceTrustStatus(probeSettings, boundWorkspace).effective
            .state === 'trusted');
      // An untrusted workspace must not select the locale through its own
      // `general.language`: `loadSettings` merges the workspace scope for
      // any directory unless told otherwise, while the entries behind this
      // key are built by `createExtensionManager(boundWorkspace, trusted)`,
      // which does gate it. Re-resolving on the gated merge keeps the cache
      // key and the cached payload on one view of the same file. A trusted
      // workspace reuses the probe, so that path is still a single load.
      const mergedSettings =
        trusted && probeSettings
          ? probeSettings
          : loadSettings(boundWorkspace, {
              skipLoadEnvironment: true,
              consumeCorruptionEnvVars: false,
              skipWorkspaceSettings: true,
              workspaceTrusted: false,
            }).merged;
      const locale = resolveExtensionLocale(mergedSettings);
      if (
        extensionsStatusCache?.locale === locale &&
        extensionsStatusCache.trusted === trusted &&
        extensionsStatusCache.expiresAt > Date.now()
      ) {
        return extensionsStatusCache.value;
      }
      if (
        extensionsStatusInFlight?.locale === locale &&
        extensionsStatusInFlight.trusted === trusted
      ) {
        return extensionsStatusInFlight.promise;
      }
      const load = {
        locale,
        trusted,
        promise: loadLocalExtensionsStatus(trusted),
      };
      extensionsStatusInFlight = load;
      try {
        const value = await load.promise;
        if (extensionsStatusInFlight === load) {
          extensionsStatusCache = {
            locale,
            trusted,
            expiresAt: Date.now() + 2_000,
            value,
          };
        }
        return value;
      } finally {
        if (extensionsStatusInFlight === load) {
          extensionsStatusInFlight = undefined;
        }
      }
    };

  const buildLocalExtensionSummaries =
    async (): Promise<ServeWorkspaceExtensionSummaries> => {
      const manager = createExtensionManager();
      const { snapshot, extensions } = await manager.refreshCatalogSnapshot();
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        initialized: true,
        extensions: [
          ...new Map(
            extensions.map((extension) => [extension.name, extension]),
          ).values(),
        ].map((extension) => ({
          ...toExtensionSummary(extension),
          isActive:
            manager.getExtensionActivationForIdentityFromSnapshot(
              extension,
              snapshot,
              boundWorkspace,
            ).effective === 'enabled',
        })),
      };
    };

  const buildLocalExtensionDetails = async (
    name: string,
  ): Promise<ServeExtensionEntry | null> => {
    const manager = createExtensionManager();
    const { snapshot, extension } =
      await manager.refreshExtensionDetailsSnapshot(name);
    if (!extension) return null;
    return {
      ...toExtensionEntry(extension),
      isActive:
        manager.getExtensionActivationForIdentityFromSnapshot(
          extension,
          snapshot,
          boundWorkspace,
        ).effective === 'enabled',
    };
  };

  return {
    boundWorkspace,
    workspace,
    createExtensionManager,
    buildLocalExtensionsStatus,
    buildLocalExtensionSummaries,
    buildLocalExtensionDetails,
    refreshExtensionsForAllSessions,
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
