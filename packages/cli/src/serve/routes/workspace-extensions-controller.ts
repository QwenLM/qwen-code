/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import {
  ExtensionManager,
  redactUrlCredentials,
  type ExtensionSetting,
} from '@qwen-code/qwen-code-core';
import type { Request, Response } from 'express';
import { loadSettings } from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  createBuildWorkspaceCtx,
  parseAndValidateWorkspaceClientId,
} from '../server/request-helpers.js';
import {
  STATUS_SCHEMA_VERSION,
  type ServeExtensionCapabilities,
  type ServeExtensionEntry,
  type ServeWorkspaceExtensionsStatus,
} from '@qwen-code/acp-bridge/status';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';

const MAX_EXTENSION_INSTALL_QUEUE_DEPTH = 10;
const EXTENSION_MUTATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Thrown by the per-workspace install queue when it is saturated, and matched
 * by the route layer to emit a 429. Shared so the throw site and the match
 * site (a separate module) can never silently drift apart.
 */
export const EXTENSION_QUEUE_FULL_MESSAGE = 'Extension operation queue is full';

/**
 * Wraps a promise with a timeout that rejects if the underlying work does not
 * settle in time. Shared by the controller (mutation queue) and the route
 * handlers (update-check / refresh).
 *
 * Non-cancellation semantics: on timeout the returned promise rejects, but the
 * underlying operation is NOT aborted and keeps running to completion in the
 * background. Inside `runQueuedExtensionMutation` a timed-out mutation is
 * recorded as `failed` even though the on-disk install/uninstall may still
 * settle, and the per-workspace queue stays occupied until the underlying work
 * finishes. Cancelling the underlying operation (e.g. via `AbortController`)
 * is tracked as a follow-up.
 */
export const withExtensionTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });

export type ExtensionMutationEvent = {
  status: 'installed' | 'enabled' | 'disabled' | 'updated' | 'uninstalled';
  source?: string;
  name?: string;
  version?: string;
};

export type ExtensionOperationStatus = {
  v: 1;
  operationId: string;
  operation: string;
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'succeeded_with_refresh_error'
    | 'failed';
  createdAt: number;
  updatedAt: number;
  source?: string;
  name?: string;
  result?: ExtensionMutationEvent & {
    refreshed?: number;
    failed?: number;
    error?: string;
  };
  error?: string;
};

export interface CreateExtensionsControllerDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspace: DaemonWorkspaceService;
  maxExtensionOperationHistory?: number;
}

/**
 * Per-workspace extension operation state and the mutation/refresh machinery
 * bound to a single workspace's `bridge` and `workspace` service. One
 * controller owns that workspace's install-serialization queue, async
 * operation history, and status cache, so both the legacy singular routes and
 * the workspace-qualified plural routes dispatch through the same instance for
 * a given workspace (never two competing install queues for one directory).
 */
export interface ExtensionsController {
  readonly boundWorkspace: string;
  readonly workspace: DaemonWorkspaceService;
  buildWorkspaceCtx: ReturnType<typeof createBuildWorkspaceCtx>;
  createExtensionManager(): ExtensionManager;
  buildLocalExtensionsStatus(): Promise<ServeWorkspaceExtensionsStatus>;
  invalidateStatusCache(): void;
  getOperation(operationId: string): ExtensionOperationStatus | undefined;
  enqueueExtensionInstall<T>(run: () => Promise<T>): Promise<T>;
  validateExtensionMutationClient(
    req: Request,
    res: Response,
    route: string,
    opts?: { requireClientId?: boolean },
  ): boolean;
  runQueuedExtensionMutation(
    operation: string,
    failureContext: { source?: string; name?: string },
    res: Response,
    run: (
      extensionManager: ExtensionManager,
    ) => Promise<ExtensionMutationEvent>,
  ): void;
}

export function createExtensionsController(
  deps: CreateExtensionsControllerDeps,
): ExtensionsController {
  const { boundWorkspace, bridge, workspace } = deps;
  const maxExtensionOperationHistory = deps.maxExtensionOperationHistory ?? 100;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);

  let extensionInstallQueue: Promise<unknown> = Promise.resolve();
  let extensionInstallQueueDepth = 0;
  const enqueueExtensionInstall = async <T>(run: () => Promise<T>) => {
    if (extensionInstallQueueDepth >= MAX_EXTENSION_INSTALL_QUEUE_DEPTH) {
      throw new Error(EXTENSION_QUEUE_FULL_MESSAGE);
    }
    extensionInstallQueueDepth += 1;
    const next = extensionInstallQueue.then(run, run).finally(() => {
      extensionInstallQueueDepth -= 1;
    });
    extensionInstallQueue = next.catch(() => undefined);
    return next;
  };

  const createExtensionManager = () =>
    new ExtensionManager({
      workspaceDir: boundWorkspace,
      isWorkspaceTrusted:
        getWorkspaceTrustStatus(
          loadSettings(boundWorkspace).merged,
          boundWorkspace,
        ).effective.state === 'trusted',
      requestConsent: () => Promise.resolve(),
      requestSetting: async (setting: ExtensionSetting) => {
        throw new Error(
          `Extension setting "${setting.envVar}" requires interactive configuration and is not supported over the daemon install endpoint.`,
        );
      },
      requestChoicePlugin: async () => {
        throw new Error(
          'Marketplace plugin selection is not supported over the daemon install endpoint. Specify a plugin name in the source.',
        );
      },
    });

  const validateExtensionMutationClient = (
    req: Request,
    res: Response,
    route: string,
    opts: { requireClientId?: boolean } = {},
  ): boolean => {
    const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
    if (clientId === null) return false;
    if (clientId === undefined && opts.requireClientId !== false) {
      res.status(400).json({
        error: 'Missing X-Qwen-Client-Id header',
        code: 'missing_client_id',
      });
      return false;
    }
    buildWorkspaceCtx(route, clientId);
    return true;
  };

  const extensionOperations = new Map<string, ExtensionOperationStatus>();
  const isTerminalExtensionOperation = (
    operation: ExtensionOperationStatus,
  ): boolean => operation.status !== 'queued' && operation.status !== 'running';
  const redactExtensionOperationResult = (
    event: ExtensionMutationEvent,
  ): ExtensionMutationEvent => ({
    ...event,
    ...(event.source ? { source: redactUrlCredentials(event.source) } : {}),
  });
  const rememberExtensionOperation = (
    operation: ExtensionOperationStatus,
  ): void => {
    extensionOperations.set(operation.operationId, operation);
    while (extensionOperations.size > maxExtensionOperationHistory) {
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
  };

  let extensionsStatusCache:
    | { expiresAt: number; value: ServeWorkspaceExtensionsStatus }
    | undefined;

  const runQueuedExtensionMutation = (
    operation: string,
    failureContext: { source?: string; name?: string },
    res: Response,
    run: (
      extensionManager: ExtensionManager,
    ) => Promise<ExtensionMutationEvent>,
  ): void => {
    if (extensionInstallQueueDepth >= MAX_EXTENSION_INSTALL_QUEUE_DEPTH) {
      res.status(429).json({
        error: EXTENSION_QUEUE_FULL_MESSAGE,
        code: 'extension_queue_full',
      });
      return;
    }
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
        ? { source: redactUrlCredentials(failureContext.source) }
        : {}),
      ...(failureContext.name ? { name: failureContext.name } : {}),
    });
    res.status(202).json({ accepted: true, operationId });
    void enqueueExtensionInstall(async () => {
      try {
        updateExtensionOperation(operationId, { status: 'running' });
        const extensionManager = createExtensionManager();
        await extensionManager.refreshCache();
        const event = await withExtensionTimeout(
          run(extensionManager),
          EXTENSION_MUTATION_TIMEOUT_MS,
          `extension ${operation}`,
        );
        extensionsStatusCache = undefined;
        workspace.invalidateWorkspaceSkillsStatus();
        try {
          const result = await bridge.refreshExtensionsForAllSessions(
            redactExtensionOperationResult(event),
          );
          updateExtensionOperation(operationId, {
            status: 'succeeded',
            result: {
              ...redactExtensionOperationResult(event),
              refreshed: result.refreshed,
              failed: result.failed,
            },
          });
          writeStderrLine(
            `qwen serve: [${boundWorkspace}] extensions ${operation}: refreshed ${result.refreshed} session(s), ${result.failed} failed`,
          );
        } catch (refreshErr) {
          const message = redactUrlCredentials(
            refreshErr instanceof Error
              ? refreshErr.message
              : String(refreshErr),
          );
          updateExtensionOperation(operationId, {
            status: 'succeeded_with_refresh_error',
            result: {
              ...redactExtensionOperationResult(event),
              refreshed: 0,
              failed: 1,
              error: message.slice(0, 500),
            },
          });
          try {
            bridge.broadcastExtensionsChanged({
              ...redactExtensionOperationResult(event),
              refreshed: 0,
              failed: 1,
              error: message.slice(0, 500),
            });
          } catch (broadcastErr) {
            writeStderrLine(
              `qwen serve: [${boundWorkspace}] extensions ${operation}: failed to broadcast refresh failure: ${
                broadcastErr instanceof Error
                  ? redactUrlCredentials(broadcastErr.message)
                  : String(broadcastErr)
              }`,
            );
          }
          writeStderrLine(
            `qwen serve: [${boundWorkspace}] extensions ${operation}: mutation succeeded but refresh failed: ${message}`,
          );
        }
      } catch (err) {
        const message = redactUrlCredentials(
          err instanceof Error ? err.message : String(err),
        );
        updateExtensionOperation(operationId, {
          status: 'failed',
          error: message.slice(0, 500),
        });
        try {
          bridge.broadcastExtensionsChanged({
            status: 'failed',
            ...(failureContext.source
              ? { source: redactUrlCredentials(failureContext.source) }
              : {}),
            ...(failureContext.name ? { name: failureContext.name } : {}),
            refreshed: 0,
            failed: 0,
            error: message.slice(0, 500),
          });
        } catch (broadcastErr) {
          writeStderrLine(
            `qwen serve: [${boundWorkspace}] extensions ${operation}: failed to broadcast failure: ${
              broadcastErr instanceof Error
                ? redactUrlCredentials(broadcastErr.message)
                : String(broadcastErr)
            }`,
          );
        }
        try {
          writeStderrLine(
            `qwen serve: [${boundWorkspace}] extensions ${operation}: background task failed: ${message}`,
          );
        } catch {
          // Keep queued background work from surfacing as unhandledRejection.
        }
      }
    }).catch((err) => {
      const message = redactUrlCredentials(
        err instanceof Error ? err.message : String(err),
      );
      updateExtensionOperation(operationId, {
        status: 'failed',
        error: message.slice(0, 500),
      });
      try {
        writeStderrLine(
          `qwen serve: [${boundWorkspace}] extensions ${operation}: queued task failed: ${message}`,
        );
      } catch {
        // Last-resort guard for detached async work.
      }
    });
  };

  const buildLocalExtensionsStatus =
    async (): Promise<ServeWorkspaceExtensionsStatus> => {
      const now = Date.now();
      if (extensionsStatusCache && extensionsStatusCache.expiresAt > now) {
        return extensionsStatusCache.value;
      }
      const extensionManager = createExtensionManager();
      await extensionManager.refreshCache();
      const entries: ServeExtensionEntry[] = extensionManager
        .getLoadedExtensions()
        .map((ext): ServeExtensionEntry => {
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
            path: ext.path,
            ...(ext.installMetadata?.source
              ? { source: redactUrlCredentials(ext.installMetadata.source) }
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
        expiresAt: now + 2_000,
        value: status,
      };
      return status;
    };

  return {
    boundWorkspace,
    workspace,
    buildWorkspaceCtx,
    createExtensionManager,
    buildLocalExtensionsStatus,
    invalidateStatusCache: () => {
      extensionsStatusCache = undefined;
    },
    getOperation: (operationId) => extensionOperations.get(operationId),
    enqueueExtensionInstall,
    validateExtensionMutationClient,
    runQueuedExtensionMutation,
  };
}
