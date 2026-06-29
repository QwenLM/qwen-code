/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import {
  ExtensionUpdateState,
  ExtensionManager,
  checkForExtensionUpdate,
  parseInstallSource,
  redactUrlCredentials,
  SettingScope,
  type Extension,
  type ExtensionInstallMetadata,
  type ExtensionSetting,
} from '@qwen-code/qwen-code-core';
import type { Application, Request, RequestHandler, Response } from 'express';
import { loadSettings } from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { isBlockedAuthProviderHost } from '../server/auth-provider-helpers.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  parseAndValidateWorkspaceClientId,
  type safeBody as safeBodyType,
} from '../server/request-helpers.js';
import {
  STATUS_SCHEMA_VERSION,
  type ServeExtensionCapabilities,
  type ServeExtensionEntry,
  type ServeWorkspaceExtensionsStatus,
} from '@qwen-code/acp-bridge/status';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';

type SafeBody = typeof safeBodyType;

interface RegisterWorkspaceExtensionRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: SafeBody;
  sendBridgeError: SendBridgeError;
}

export function registerWorkspaceExtensionRoutes(
  app: Application,
  deps: RegisterWorkspaceExtensionRoutesDeps,
): void {
  const {
    boundWorkspace,
    bridge,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
  } = deps;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);

  let extensionInstallQueue: Promise<unknown> = Promise.resolve();
  let extensionInstallQueueDepth = 0;
  const MAX_EXTENSION_INSTALL_QUEUE_DEPTH = 10;
  const enqueueExtensionInstall = async <T>(run: () => Promise<T>) => {
    if (extensionInstallQueueDepth >= MAX_EXTENSION_INSTALL_QUEUE_DEPTH) {
      throw new Error('Extension operation queue is full');
    }
    extensionInstallQueueDepth += 1;
    const next = extensionInstallQueue.then(run, run).finally(() => {
      extensionInstallQueueDepth -= 1;
    });
    extensionInstallQueue = next.catch(() => undefined);
    return next;
  };
  const EXTENSION_MUTATION_TIMEOUT_MS = 10 * 60_000;
  const EXTENSION_REFRESH_TIMEOUT_MS = 30_000;
  const isExtensionQueueFullError = (err: unknown): boolean =>
    err instanceof Error && err.message === 'Extension operation queue is full';
  const sendExtensionQueueFull = (res: Response) => {
    res.status(429).json({
      error: 'Extension operation queue is full',
      code: 'extension_queue_full',
    });
  };
  const withExtensionTimeout = async <T>(
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
  ): boolean => {
    const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
    if (clientId === null) return false;
    if (clientId === undefined) {
      res.status(400).json({
        error: 'Missing X-Qwen-Client-Id header',
        code: 'missing_client_id',
      });
      return false;
    }
    buildWorkspaceCtx(route, clientId);
    return true;
  };
  const parseExtensionScope = (
    body: Record<string, unknown>,
    res: Response,
  ): SettingScope | null => {
    const scope = body['scope'];
    if (scope !== 'user' && scope !== 'workspace') {
      res
        .status(400)
        .json({ error: '`scope` must be either "user" or "workspace"' });
      return null;
    }
    return scope === 'user' ? SettingScope.User : SettingScope.Workspace;
  };
  const parseExtensionRegistryUrl = (
    value: string,
    res: Response,
  ): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      res.status(400).json({ error: '`registry` must be a valid URL' });
      return null;
    }
    if (parsed.protocol !== 'https:') {
      res.status(400).json({ error: '`registry` must use https' });
      return null;
    }
    if (parsed.username || parsed.password) {
      res
        .status(400)
        .json({ error: '`registry` must not include credentials' });
      return null;
    }
    if (isBlockedAuthProviderHost(parsed.hostname)) {
      res.status(400).json({ error: '`registry` host is not allowed' });
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  };
  const parsePotentialSourceUrl = (source: string): URL | null => {
    if (/^[a-zA-Z]:[\\/]/.test(source)) return null;
    try {
      return new URL(source);
    } catch {
      const sshMatch = /^(?:[^@]+@)?(\[[^\]]+\]|[^:]+):/.exec(source);
      if (!sshMatch?.[1]) return null;
      try {
        return new URL(`ssh://${sshMatch[1]}`);
      } catch {
        return null;
      }
    }
  };
  const validateExtensionSourceHost = (
    source: string,
    res: Response,
  ): boolean => {
    const parsed = parsePotentialSourceUrl(source);
    if (!parsed) return true;
    if (parsed.username || parsed.password) {
      res.status(400).json({ error: '`source` must not include credentials' });
      return false;
    }
    if (isBlockedAuthProviderHost(parsed.hostname)) {
      res.status(400).json({ error: '`source` host is not allowed' });
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
      res.status(400).json({ error: '`source` must use https or ssh' });
      return false;
    }
    return true;
  };
  const validateExtensionSourceMetadata = (
    installMetadata: ExtensionInstallMetadata,
  ): boolean => {
    if (installMetadata.type !== 'git') return true;
    const parsed = parsePotentialSourceUrl(installMetadata.source);
    return (
      !!parsed &&
      (parsed.protocol === 'https:' || parsed.protocol === 'ssh:') &&
      !isBlockedAuthProviderHost(parsed.hostname)
    );
  };
  const findLoadedExtension = (
    extensionManager: ExtensionManager,
    extensionName: string,
  ): Extension | undefined => {
    const requested = extensionName.toLowerCase();
    const extensions = extensionManager.getLoadedExtensions();
    const byName = extensions.find(
      (extension) => extension.name.toLowerCase() === requested,
    );
    if (byName) return byName;
    if (!extensionName.includes('://') && !extensionName.includes('@')) {
      return undefined;
    }
    return extensions.find(
      (extension) =>
        extension.installMetadata?.source?.toLowerCase() === requested,
    );
  };
  type ExtensionMutationEvent = {
    status: 'installed' | 'enabled' | 'disabled' | 'updated' | 'uninstalled';
    source?: string;
    name?: string;
    version?: string;
  };
  type ExtensionOperationStatus = {
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
  const extensionOperations = new Map<string, ExtensionOperationStatus>();
  const MAX_EXTENSION_OPERATION_HISTORY = 100;
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
    while (extensionOperations.size > MAX_EXTENSION_OPERATION_HISTORY) {
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
  const runQueuedExtensionMutation = (
    operation: string,
    failureContext: { source?: string; name?: string },
    res: Response,
    run: (
      extensionManager: ExtensionManager,
    ) => Promise<ExtensionMutationEvent>,
  ): void => {
    if (extensionInstallQueueDepth >= MAX_EXTENSION_INSTALL_QUEUE_DEPTH) {
      sendExtensionQueueFull(res);
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
        try {
          const result = await bridge.refreshExtensionsForAllSessions(event);
          updateExtensionOperation(operationId, {
            status: 'succeeded',
            result: {
              ...redactExtensionOperationResult(event),
              refreshed: result.refreshed,
              failed: result.failed,
            },
          });
          writeStderrLine(
            `qwen serve: extensions ${operation}: refreshed ${result.refreshed} session(s), ${result.failed} failed`,
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
              ...event,
              refreshed: 0,
              failed: 1,
              error: message.slice(0, 500),
            });
          } catch (broadcastErr) {
            writeStderrLine(
              `qwen serve: extensions ${operation}: failed to broadcast refresh failure: ${
                broadcastErr instanceof Error
                  ? redactUrlCredentials(broadcastErr.message)
                  : String(broadcastErr)
              }`,
            );
          }
          writeStderrLine(
            `qwen serve: extensions ${operation}: mutation succeeded but refresh failed: ${message}`,
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
            `qwen serve: extensions ${operation}: failed to broadcast failure: ${
              broadcastErr instanceof Error
                ? redactUrlCredentials(broadcastErr.message)
                : String(broadcastErr)
            }`,
          );
        }
        try {
          writeStderrLine(
            `qwen serve: extensions ${operation}: background task failed: ${message}`,
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
          `qwen serve: extensions ${operation}: queued task failed: ${message}`,
        );
      } catch {
        // Last-resort guard for detached async work.
      }
    });
  };
  let extensionsStatusCache:
    | { expiresAt: number; value: ServeWorkspaceExtensionsStatus }
    | undefined;
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
  // GET /workspace/extensions — read-only installed extension status.
  app.get('/workspace/extensions', async (_req, res) => {
    try {
      buildWorkspaceCtx('GET /workspace/extensions');
      res.status(200).json(await buildLocalExtensionsStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/extensions' });
    }
  });

  app.get('/workspace/extensions/operations/:operationId', async (req, res) => {
    try {
      buildWorkspaceCtx('GET /workspace/extensions/operations/:operationId');
      const operationId = req.params['operationId'];
      if (!operationId) {
        res.status(400).json({ error: 'Missing extension operation id' });
        return;
      }
      const operation = extensionOperations.get(operationId);
      if (!operation) {
        res.status(404).json({
          error: `Extension operation "${operationId}" not found`,
          code: 'extension_operation_not_found',
        });
        return;
      }
      res.status(200).json(operation);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /workspace/extensions/operations/:operationId',
      });
    }
  });

  // POST /workspace/extensions/install — install an extension and refresh
  // all active sessions asynchronously.
  app.post(
    '/workspace/extensions/install',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/install',
          )
        ) {
          return;
        }
        const body = safeBody(req);
        const source = body['source'];
        const ref = body['ref'];
        const autoUpdate = body['autoUpdate'];
        const allowPreRelease = body['allowPreRelease'];
        const registry = body['registry'];
        const consent = body['consent'];

        if (!source || typeof source !== 'string') {
          res.status(400).json({ error: 'Missing or invalid source' });
          return;
        }
        if (ref !== undefined && (typeof ref !== 'string' || ref === '')) {
          res.status(400).json({ error: '`ref` must be a string' });
          return;
        }
        if (typeof ref === 'string' && ref.startsWith('-')) {
          res.status(400).json({ error: '`ref` must not start with "-"' });
          return;
        }
        if (autoUpdate !== undefined && typeof autoUpdate !== 'boolean') {
          res.status(400).json({ error: '`autoUpdate` must be a boolean' });
          return;
        }
        if (
          allowPreRelease !== undefined &&
          typeof allowPreRelease !== 'boolean'
        ) {
          res
            .status(400)
            .json({ error: '`allowPreRelease` must be a boolean' });
          return;
        }
        if (registry !== undefined && typeof registry !== 'string') {
          res.status(400).json({ error: '`registry` must be a string' });
          return;
        }
        const sourceValue = source;
        const refValue = typeof ref === 'string' ? ref : undefined;
        const autoUpdateValue =
          typeof autoUpdate === 'boolean' ? autoUpdate : undefined;
        const allowPreReleaseValue =
          typeof allowPreRelease === 'boolean' ? allowPreRelease : undefined;
        const registryValue =
          typeof registry === 'string' ? registry : undefined;
        const registryUrl =
          registryValue !== undefined
            ? parseExtensionRegistryUrl(registryValue, res)
            : undefined;
        if (registryUrl === null) return;
        if (consent !== true) {
          res.status(400).json({
            error: 'Extension installation requires explicit consent',
          });
          return;
        }
        if (!validateExtensionSourceHost(sourceValue, res)) {
          return;
        }

        runQueuedExtensionMutation(
          'install',
          { source: sourceValue },
          res,
          async (extensionManager) => {
            const installMetadata = await parseInstallSource(sourceValue);

            if (
              installMetadata.type !== 'git' &&
              installMetadata.type !== 'github-release' &&
              installMetadata.type !== 'npm'
            ) {
              throw new Error(
                'Only GitHub, Git, and npm extension installs are supported over the daemon endpoint.',
              );
            }
            if (installMetadata.type === 'npm' && refValue) {
              throw new Error('--ref is not applicable for npm extensions.');
            }
            if (installMetadata.type !== 'npm' && registryValue) {
              throw new Error(
                '--registry is only applicable for npm extensions.',
              );
            }
            if (!validateExtensionSourceMetadata(installMetadata)) {
              throw new Error('`source` host is not allowed');
            }
            if (installMetadata.type === 'npm' && registryUrl) {
              installMetadata.registryUrl = registryUrl;
            }
            const extension = await extensionManager.installExtension(
              {
                ...installMetadata,
                ref: refValue,
                autoUpdate: autoUpdateValue,
                allowPreRelease: allowPreReleaseValue,
              },
              () => Promise.resolve(),
            );
            return {
              status: 'installed',
              source: sourceValue,
              name: extension.name,
              version: extension.config.version,
            };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/install',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/check-updates',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/check-updates',
          )
        ) {
          return;
        }
        const states = await enqueueExtensionInstall(async () =>
          withExtensionTimeout(
            (async () => {
              const extensionManager = createExtensionManager();
              await extensionManager.refreshCache();
              const updateStates: Record<string, string> = {};
              await extensionManager.checkForAllExtensionUpdates(
                (name, state) => {
                  updateStates[name] = state;
                },
              );
              return updateStates;
            })(),
            EXTENSION_REFRESH_TIMEOUT_MS,
            'extension update check',
          ),
        );
        res.status(200).json({ states });
      } catch (err) {
        if (isExtensionQueueFullError(err)) {
          sendExtensionQueueFull(res);
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/check-updates',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/refresh',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/refresh',
          )
        ) {
          return;
        }
        const result = await enqueueExtensionInstall(async () =>
          withExtensionTimeout(
            workspace.refreshExtensionsForAllSessions(),
            EXTENSION_REFRESH_TIMEOUT_MS,
            'extension refresh',
          ),
        );
        res.status(200).json(result);
      } catch (err) {
        if (isExtensionQueueFullError(err)) {
          sendExtensionQueueFull(res);
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/refresh',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/:name/enable',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/:name/enable',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        const scope = parseExtensionScope(safeBody(req), res);
        if (scope === null) return;
        runQueuedExtensionMutation(
          'enable',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await extensionManager.enableExtension(
              extension.name,
              scope,
              boundWorkspace,
            );
            return { status: 'enabled', name: extension.name };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/:name/enable',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/:name/disable',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/:name/disable',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        const scope = parseExtensionScope(safeBody(req), res);
        if (scope === null) return;
        runQueuedExtensionMutation(
          'disable',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await extensionManager.disableExtension(
              extension.name,
              scope,
              boundWorkspace,
            );
            return { status: 'disabled', name: extension.name };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/:name/disable',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/:name/update',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/:name/update',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        runQueuedExtensionMutation(
          'update',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            let updateError: unknown;
            const updateState = await withExtensionTimeout(
              checkForExtensionUpdate(extension, extensionManager).catch(
                (err: unknown) => {
                  updateError = err;
                  return ExtensionUpdateState.ERROR;
                },
              ),
              EXTENSION_REFRESH_TIMEOUT_MS,
              'extension update check',
            );
            if (updateState === ExtensionUpdateState.ERROR) {
              const message =
                updateError === undefined
                  ? undefined
                  : redactUrlCredentials(
                      updateError instanceof Error
                        ? updateError.message
                        : String(updateError),
                    );
              throw new Error(
                `Update check failed for extension "${extension.name}"${
                  message ? `: ${message}` : ''
                }`,
              );
            }
            if (updateState !== ExtensionUpdateState.UPDATE_AVAILABLE) {
              throw new Error(`Extension "${extension.name}" has no update`);
            }
            const info = await extensionManager.updateExtension(
              extension,
              updateState,
              () => undefined,
            );
            return {
              status: 'updated',
              name: extension.name,
              ...(info?.updatedVersion ? { version: info.updatedVersion } : {}),
            };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/:name/update',
        });
      }
    },
  );

  app.delete(
    '/workspace/extensions/:name',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'DELETE /workspace/extensions/:name',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        runQueuedExtensionMutation(
          'uninstall',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await extensionManager.uninstallExtension(
              extension.name,
              false,
              boundWorkspace,
            );
            return { status: 'uninstalled', name: extension.name };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/extensions/:name',
        });
      }
    },
  );
}
