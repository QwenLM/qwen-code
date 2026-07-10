/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseInstallSource,
  redactUrlCredentials,
  SettingScope,
  type Extension,
  type ExtensionInstallMetadata,
  type ExtensionManager,
} from '@qwen-code/qwen-code-core';
import type { Application, Request, RequestHandler, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { isBlockedAuthProviderHost } from '../server/auth-provider-helpers.js';
import type { SendBridgeError } from '../server/error-response.js';
import type { safeBody as safeBodyType } from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';
import {
  createExtensionsController,
  type ExtensionOperationContext,
  type ExtensionsController,
} from './workspace-extensions-controller.js';

type SafeBody = typeof safeBodyType;

const EXTENSION_PREPARE_DEADLINE_MS = 10 * 60_000;
const EXTENSION_UPDATE_CHECK_DEADLINE_MS = 2 * 60_000;

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
    res.status(400).json({ error: '`registry` must not include credentials' });
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

interface RegisterWorkspaceExtensionRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: SafeBody;
  sendBridgeError: SendBridgeError;
  maxExtensionOperationHistory?: number;
  // Enables V2 workspace projection and targeted reconciliation routes.
  workspaceRegistry?: WorkspaceRegistry;
}

/**
 * Resolves the extensions controller for a request. Returns `null` (after
 * emitting the appropriate error) when the workspace selector is unknown, or
 * when a mutation targets an untrusted workspace.
 */
type ResolveController = (
  req: Request,
  res: Response,
  requireTrust: boolean,
) => ExtensionsController | null;

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
    workspaceRegistry,
  } = deps;
  const maxExtensionOperationHistory = deps.maxExtensionOperationHistory;
  const controllerDeps = (
    ws: string,
    wsBridge: AcpSessionBridge,
    wsService: DaemonWorkspaceService,
  ) => ({
    boundWorkspace: ws,
    bridge: wsBridge,
    workspace: wsService,
    ...(maxExtensionOperationHistory === undefined
      ? {}
      : { maxExtensionOperationHistory }),
  });

  const primaryController = createExtensionsController(
    controllerDeps(boundWorkspace, bridge, workspace),
  );
  const appliedGenerationByWorkspaceId = new Map<string, number>();

  if (workspaceRegistry) {
    let observedGeneration: number | undefined;
    let reconciling = false;
    const reconcileExternalGeneration = async (): Promise<void> => {
      if (reconciling) return;
      reconciling = true;
      try {
        const manager = primaryController.createExtensionManager(
          boundWorkspace,
          true,
        );
        const generation = (await manager.getExtensionStoreSnapshot())
          .generation;
        if (
          observedGeneration !== undefined &&
          generation === observedGeneration
        ) {
          return;
        }
        const runtimes = workspaceRegistry.list();
        const results = await Promise.allSettled(
          runtimes.map(async (runtime) => {
            runtime.workspaceService.invalidateWorkspaceSkillsStatus();
            const result =
              await runtime.bridge.refreshExtensionsForAllSessions();
            if (result.failed > 0) {
              throw new Error(
                `${result.failed} extension session refresh(es) failed`,
              );
            }
          }),
        );
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            const workspaceId = runtimes[index]!.workspaceId;
            appliedGenerationByWorkspaceId.set(
              workspaceId,
              Math.max(
                appliedGenerationByWorkspaceId.get(workspaceId) ?? 0,
                generation,
              ),
            );
          }
        });
        if (results.every((result) => result.status === 'fulfilled')) {
          observedGeneration = generation;
        }
      } catch (error) {
        writeStderrLine(
          `qwen serve: extension generation reconciliation failed: ${redactUrlCredentials(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      } finally {
        reconciling = false;
      }
    };
    const generationPoller = setInterval(
      () => void reconcileExternalGeneration(),
      30_000,
    );
    generationPoller.unref();
    (
      app.locals as { stopExtensionGenerationReconciler?: () => void }
    ).stopExtensionGenerationReconciler = () => clearInterval(generationPoller);
  }

  const registerFor = (base: string, resolve: ResolveController): void => {
    // GET {base} — read-only installed extension status.
    app.get(base, async (req, res) => {
      const ctrl = resolve(req, res, false);
      if (!ctrl) return;
      try {
        ctrl.buildWorkspaceCtx(`GET ${base}`);
        res.status(200).json(await ctrl.buildLocalExtensionsStatus());
      } catch (err) {
        sendBridgeError(res, err, { route: `GET ${base}` });
      }
    });

    app.get(`${base}/operations/:operationId`, async (req, res) => {
      const ctrl = resolve(req, res, false);
      if (!ctrl) return;
      try {
        ctrl.buildWorkspaceCtx(`GET ${base}/operations/:operationId`);
        const operationId = req.params['operationId'];
        if (!operationId) {
          res.status(400).json({ error: 'Missing extension operation id' });
          return;
        }
        const operation = ctrl.getOperation(operationId);
        if (!operation) {
          res.status(404).json({
            error: `Extension operation "${operationId}" not found`,
            code: 'extension_operation_not_found',
          });
          return;
        }
        const legacyRefreshFailure =
          base === '/workspace/extensions' &&
          operation.status === 'succeeded_with_warnings' &&
          (operation.result?.failed ?? 0) > 0;
        const legacyRefreshError =
          operation.warnings?.find((warning) => warning.code === undefined)
            ?.error ?? operation.result?.error;
        res.status(200).json(
          legacyRefreshFailure && operation.result
            ? {
                ...operation,
                status: 'succeeded_with_refresh_error',
                result: {
                  ...operation.result,
                  ...(legacyRefreshError ? { error: legacyRefreshError } : {}),
                },
              }
            : operation,
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: `GET ${base}/operations/:operationId`,
        });
      }
    });

    // POST {base}/install — install an extension and refresh all active
    // sessions asynchronously.
    app.post(`${base}/install`, mutate({ strict: true }), async (req, res) => {
      const ctrl = resolve(req, res, true);
      if (!ctrl) return;
      try {
        if (
          !ctrl.validateExtensionMutationClient(
            req,
            res,
            `POST ${base}/install`,
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

        ctrl.runQueuedExtensionMutation(
          'install',
          { source: sourceValue },
          res,
          async (extensionManager, _signal, context) => {
            const prepared = await context!.prepare(async (signal) => {
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
              return await extensionManager.prepareExtensionInstall({
                installMetadata: {
                  ...installMetadata,
                  ref: refValue,
                  autoUpdate: autoUpdateValue,
                  allowPreRelease: allowPreReleaseValue,
                },
                initialActivation: { scope: 'user' },
                requestConsent: () => Promise.resolve(),
                signal,
              });
            });
            try {
              const committed = await context!.commit(
                async () =>
                  await extensionManager.commitPreparedExtension(prepared),
              );
              return {
                status: 'installed',
                source: sourceValue,
                name: committed.identity.name,
                version: committed.version,
              };
            } finally {
              await extensionManager.disposePreparedExtension(prepared);
            }
          },
          {
            deadlineMs: EXTENSION_PREPARE_DEADLINE_MS,
            ...(workspaceRegistry
              ? { refreshRuntimes: workspaceRegistry.list() }
              : {}),
          },
        );
      } catch (err) {
        sendBridgeError(res, err, { route: `POST ${base}/install` });
      }
    });

    app.post(
      `${base}/check-updates`,
      mutate({ strict: true }),
      async (req, res) => {
        const ctrl = resolve(req, res, true);
        if (!ctrl) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (
            !ctrl.validateExtensionMutationClient(
              req,
              res,
              `POST ${base}/check-updates`,
            )
          ) {
            return;
          }
          const extensionManager = ctrl.createExtensionManager();
          await extensionManager.refreshCache();
          const updateStates: Record<string, string> = {};
          const deadline = new AbortController();
          await extensionManager.checkForAllExtensionUpdates(
            (name, state) => {
              updateStates[name] = state;
            },
            deadline.signal,
            async (task) =>
              await ctrl.preparationQueue.run(task, {
                signal: deadline.signal,
                onStart: () => {
                  if (timer) return;
                  timer = setTimeout(() => {
                    const error = new Error(
                      'Extension update check exceeded its preparation deadline.',
                    ) as Error & { code: string };
                    error.code = 'extension_prepare_timeout';
                    deadline.abort(error);
                  }, EXTENSION_UPDATE_CHECK_DEADLINE_MS);
                  timer.unref();
                },
              }),
          );
          const states = updateStates;
          res.status(200).json({ states });
        } catch (err) {
          sendBridgeError(res, err, { route: `POST ${base}/check-updates` });
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    );

    app.post(`${base}/refresh`, mutate({ strict: true }), async (req, res) => {
      const ctrl = resolve(req, res, true);
      if (!ctrl) return;
      try {
        if (
          !ctrl.validateExtensionMutationClient(
            req,
            res,
            `POST ${base}/refresh`,
          )
        ) {
          return;
        }
        const result = await ctrl.workspace.refreshExtensionsForAllSessions();
        ctrl.invalidateStatusCache();
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, { route: `POST ${base}/refresh` });
      }
    });

    app.post(
      `${base}/:name/enable`,
      mutate({ strict: true }),
      async (req, res) => {
        const ctrl = resolve(req, res, true);
        if (!ctrl) return;
        try {
          if (
            !ctrl.validateExtensionMutationClient(
              req,
              res,
              `POST ${base}/:name/enable`,
              { requireClientId: false },
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
          ctrl.runQueuedExtensionMutation(
            'enable',
            { name },
            res,
            async (extensionManager, _signal, context) => {
              const extension = findLoadedExtension(extensionManager, name);
              if (!extension) {
                throw new Error(`Extension "${name}" not found`);
              }
              await context!.commit(
                async () =>
                  await extensionManager.enableExtension(
                    extension.name,
                    scope,
                    ctrl.boundWorkspace,
                  ),
              );
              return { status: 'enabled', name: extension.name };
            },
            {
              ...(scope === SettingScope.User && workspaceRegistry
                ? { refreshRuntimes: workspaceRegistry.list() }
                : {}),
            },
          );
        } catch (err) {
          sendBridgeError(res, err, { route: `POST ${base}/:name/enable` });
        }
      },
    );

    app.post(
      `${base}/:name/disable`,
      mutate({ strict: true }),
      async (req, res) => {
        const ctrl = resolve(req, res, true);
        if (!ctrl) return;
        try {
          if (
            !ctrl.validateExtensionMutationClient(
              req,
              res,
              `POST ${base}/:name/disable`,
              { requireClientId: false },
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
          ctrl.runQueuedExtensionMutation(
            'disable',
            { name },
            res,
            async (extensionManager, _signal, context) => {
              const extension = findLoadedExtension(extensionManager, name);
              if (!extension) {
                throw new Error(`Extension "${name}" not found`);
              }
              await context!.commit(
                async () =>
                  await extensionManager.disableExtension(
                    extension.name,
                    scope,
                    ctrl.boundWorkspace,
                  ),
              );
              return { status: 'disabled', name: extension.name };
            },
            {
              ...(scope === SettingScope.User && workspaceRegistry
                ? { refreshRuntimes: workspaceRegistry.list() }
                : {}),
            },
          );
        } catch (err) {
          sendBridgeError(res, err, { route: `POST ${base}/:name/disable` });
        }
      },
    );

    app.post(
      `${base}/:name/update`,
      mutate({ strict: true }),
      async (req, res) => {
        const ctrl = resolve(req, res, true);
        if (!ctrl) return;
        try {
          if (
            !ctrl.validateExtensionMutationClient(
              req,
              res,
              `POST ${base}/:name/update`,
            )
          ) {
            return;
          }
          const name = req.params['name'];
          if (!name) {
            res.status(400).json({ error: 'Missing extension name' });
            return;
          }
          ctrl.runQueuedExtensionMutation(
            'update',
            { name },
            res,
            async (extensionManager, _signal, context) => {
              const extension = findLoadedExtension(extensionManager, name);
              if (!extension) {
                throw new Error(`Extension "${name}" not found`);
              }
              let preparedResult: Awaited<
                ReturnType<ExtensionManager['prepareExtensionUpdate']>
              >;
              try {
                preparedResult = await context!.prepare(
                  async (signal) =>
                    await extensionManager.prepareExtensionUpdate({
                      extension,
                      signal,
                    }),
                );
              } catch (error) {
                throw new Error(
                  `Update check failed for extension "${extension.name}": ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
              if (preparedResult.upToDate) {
                throw new Error(`Extension "${extension.name}" has no update`);
              }
              try {
                const committed = await context!.commit(
                  async () =>
                    await extensionManager.commitPreparedExtension(
                      preparedResult.prepared,
                    ),
                );
                return {
                  status: 'updated',
                  name: extension.name,
                  version: committed.version,
                };
              } finally {
                await extensionManager.disposePreparedExtension(
                  preparedResult.prepared,
                );
              }
            },
            {
              deadlineMs: EXTENSION_PREPARE_DEADLINE_MS,
              ...(workspaceRegistry
                ? { refreshRuntimes: workspaceRegistry.list() }
                : {}),
            },
          );
        } catch (err) {
          sendBridgeError(res, err, { route: `POST ${base}/:name/update` });
        }
      },
    );

    app.delete(`${base}/:name`, mutate({ strict: true }), async (req, res) => {
      const ctrl = resolve(req, res, true);
      if (!ctrl) return;
      try {
        if (
          !ctrl.validateExtensionMutationClient(
            req,
            res,
            `DELETE ${base}/:name`,
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        ctrl.runQueuedExtensionMutation(
          'uninstall',
          { name },
          res,
          async (extensionManager, _signal, context) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await context!.commit(
              async () =>
                await extensionManager.uninstallExtension(
                  extension.name,
                  false,
                  ctrl.boundWorkspace,
                ),
            );
            return { status: 'uninstalled', name: extension.name };
          },
          {
            ...(workspaceRegistry
              ? { refreshRuntimes: workspaceRegistry.list() }
              : {}),
          },
        );
      } catch (err) {
        sendBridgeError(res, err, { route: `DELETE ${base}/:name` });
      }
    });
  };

  // Legacy singular routes bound to the primary workspace (behavior unchanged).
  registerFor('/workspace/extensions', () => primaryController);

  const extensionById = (
    manager: ExtensionManager,
    extensionId: string,
  ): Extension | undefined =>
    manager
      .getLoadedExtensions()
      .find((extension) => extension.id === extensionId);

  const parseExtensionId = (req: Request, res: Response): string | null => {
    const extensionId = req.params['extensionId'];
    if (!extensionId || !/^[a-f0-9]{64}$/.test(extensionId)) {
      res.status(400).json({
        error: 'Invalid extension id',
        code: 'invalid_extension_id',
      });
      return null;
    }
    return extensionId;
  };

  const parseActivationState = (
    req: Request,
    res: Response,
  ): 'enabled' | 'disabled' | null => {
    const state = safeBody(req)['state'];
    if (state !== 'enabled' && state !== 'disabled') {
      res.status(400).json({
        error: '`state` must be either "enabled" or "disabled"',
        code: 'invalid_extension_activation',
      });
      return null;
    }
    return state;
  };

  const sendOperation = (
    req: Request,
    res: Response,
    route: string,
    manager: ExtensionManager,
    operation: string,
    failureContext: { source?: string; name?: string },
    run: (
      extensionManager: ExtensionManager,
      signal?: AbortSignal,
      context?: ExtensionOperationContext,
    ) => Promise<{
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
    }>,
    options: {
      refreshRuntimes?: readonly WorkspaceRuntime[];
      skipRefresh?: boolean;
      deadlineMs?: number;
    } = {},
  ): void => {
    if (
      !primaryController.validateExtensionMutationClient(req, res, route, {
        requireClientId: false,
      })
    ) {
      return;
    }
    primaryController.runQueuedExtensionMutation(
      operation,
      failureContext,
      res,
      run,
      {
        manager,
        operationBasePath: '/extensions/operations',
        onRuntimeReconciled: (runtime, generation) => {
          appliedGenerationByWorkspaceId.set(
            runtime.workspaceId,
            Math.max(
              appliedGenerationByWorkspaceId.get(runtime.workspaceId) ?? 0,
              generation,
            ),
          );
        },
        ...options,
      },
    );
  };

  app.get('/extensions', async (_req, res) => {
    try {
      primaryController.buildWorkspaceCtx('GET /extensions');
      const manager = primaryController.createExtensionManager(
        boundWorkspace,
        true,
      );
      await manager.refreshCache();
      const snapshot = await manager.getExtensionStoreSnapshot();
      res.status(200).json({
        v: 1,
        generation: snapshot.generation,
        extensions: manager.getLoadedExtensions().map((extension) => {
          const policy = snapshot.extensions[extension.id];
          return {
            id: extension.id,
            name: extension.name,
            version: extension.version,
            ...(extension.installMetadata?.type
              ? { installType: extension.installMetadata.type }
              : {}),
            defaultActivation: policy?.defaultActivation ?? 'enabled',
            workspaceOverrideCount: Object.values(
              policy?.workspaceOverrides ?? {},
            ).filter((activation) => activation !== 'inherit').length,
          };
        }),
      });
    } catch (error) {
      sendBridgeError(res, error, { route: 'GET /extensions' });
    }
  });

  app.get('/extensions/operations/:operationId', (req, res) => {
    const operationId = req.params['operationId'];
    if (!operationId) {
      res.status(400).json({ error: 'Missing extension operation id' });
      return;
    }
    const operation = primaryController.getOperation(operationId);
    if (!operation) {
      res.status(404).json({
        error: `Extension operation "${operationId}" not found`,
        code: 'extension_operation_not_found',
      });
      return;
    }
    res.status(200).json(operation);
  });

  app.put(
    '/extensions/:extensionId/activation',
    mutate({ strict: true }),
    async (req, res) => {
      const extensionId = parseExtensionId(req, res);
      if (!extensionId) return;
      const state = parseActivationState(req, res);
      if (!state) return;
      const manager = primaryController.createExtensionManager(
        boundWorkspace,
        true,
      );
      sendOperation(
        req,
        res,
        'PUT /extensions/:extensionId/activation',
        manager,
        'activation',
        { name: extensionId },
        async (extensionManager, _signal, context) => {
          const extension = extensionById(extensionManager, extensionId);
          if (!extension)
            throw new Error(`Extension "${extensionId}" not found`);
          await context!.commit(
            async () =>
              await extensionManager.setExtensionDefaultActivation(
                extensionId,
                state,
              ),
          );
          return {
            status: state === 'enabled' ? 'enabled' : 'disabled',
            name: extension.name,
          };
        },
        {
          ...(workspaceRegistry
            ? { refreshRuntimes: workspaceRegistry.list() }
            : {}),
        },
      );
    },
  );

  app.post('/extensions/install', mutate({ strict: true }), (req, res) => {
    const body = safeBody(req);
    const source = body['source'];
    const activation = body['activation'];
    const ref = body['ref'];
    const autoUpdate = body['autoUpdate'];
    const allowPreRelease = body['allowPreRelease'];
    const registry = body['registry'];
    if (typeof source !== 'string' || !source) {
      res.status(400).json({ error: 'Missing or invalid source' });
      return;
    }
    if (ref !== undefined && (typeof ref !== 'string' || !ref)) {
      res.status(400).json({ error: '`ref` must be a non-empty string' });
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
    if (allowPreRelease !== undefined && typeof allowPreRelease !== 'boolean') {
      res.status(400).json({ error: '`allowPreRelease` must be a boolean' });
      return;
    }
    if (registry !== undefined && typeof registry !== 'string') {
      res.status(400).json({ error: '`registry` must be a string' });
      return;
    }
    const registryUrl =
      typeof registry === 'string'
        ? parseExtensionRegistryUrl(registry, res)
        : undefined;
    if (registryUrl === null) return;
    if (body['consent'] !== true) {
      res.status(400).json({
        error: 'Extension installation requires explicit consent',
      });
      return;
    }
    if (!validateExtensionSourceHost(source, res)) return;
    if (!activation || typeof activation !== 'object') {
      res.status(400).json({ error: 'Missing initial activation' });
      return;
    }
    const activationRecord = activation as Record<string, unknown>;
    let initialActivation:
      | { scope: 'user' }
      | { scope: 'workspace'; workspacePath: string };
    if (activationRecord['scope'] === 'user') {
      initialActivation = { scope: 'user' };
    } else if (
      activationRecord['scope'] === 'workspace' &&
      typeof activationRecord['workspaceId'] === 'string' &&
      workspaceRegistry
    ) {
      const runtime = workspaceRegistry.getByWorkspaceId(
        activationRecord['workspaceId'],
      );
      if (!runtime) {
        res.status(400).json({
          error: 'Unknown activation workspace',
          code: 'workspace_mismatch',
        });
        return;
      }
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
      initialActivation = {
        scope: 'workspace',
        workspacePath: runtime.workspaceCwd,
      };
    } else {
      res.status(400).json({ error: 'Invalid initial activation' });
      return;
    }
    const manager = primaryController.createExtensionManager(
      boundWorkspace,
      true,
    );
    sendOperation(
      req,
      res,
      'POST /extensions/install',
      manager,
      'install',
      { source },
      async (extensionManager, _signal, context) => {
        const prepared = await context!.prepare(async (signal) => {
          const metadata = await parseInstallSource(source);
          if (
            metadata.type !== 'git' &&
            metadata.type !== 'github-release' &&
            metadata.type !== 'npm'
          ) {
            throw new Error(
              'Only GitHub, Git, and npm extension installs are supported over the daemon endpoint.',
            );
          }
          if (!validateExtensionSourceMetadata(metadata)) {
            throw new Error('`source` host is not allowed');
          }
          if (metadata.type === 'npm' && ref !== undefined) {
            throw new Error('--ref is not applicable for npm extensions.');
          }
          if (metadata.type !== 'npm' && registryUrl !== undefined) {
            throw new Error(
              '--registry is only applicable for npm extensions.',
            );
          }
          if (metadata.type === 'npm' && registryUrl) {
            metadata.registryUrl = registryUrl;
          }
          return await extensionManager.prepareExtensionInstall({
            installMetadata: {
              ...metadata,
              ...(typeof ref === 'string' ? { ref } : {}),
              ...(typeof autoUpdate === 'boolean' ? { autoUpdate } : {}),
              ...(typeof allowPreRelease === 'boolean'
                ? { allowPreRelease }
                : {}),
            },
            requestConsent: () => Promise.resolve(),
            cwd: boundWorkspace,
            initialActivation,
            signal,
          });
        });
        try {
          const committed = await context!.commit(
            async () =>
              await extensionManager.commitPreparedExtension(prepared),
          );
          return {
            status: 'installed',
            source,
            name: committed.identity.name,
            version: committed.version,
          };
        } finally {
          await extensionManager.disposePreparedExtension(prepared);
        }
      },
      {
        deadlineMs: EXTENSION_PREPARE_DEADLINE_MS,
        ...(workspaceRegistry
          ? { refreshRuntimes: workspaceRegistry.list() }
          : {}),
      },
    );
  });

  app.post(
    '/extensions/check-updates',
    mutate({ strict: true }),
    (req, res) => {
      const manager = primaryController.createExtensionManager(
        boundWorkspace,
        true,
      );
      sendOperation(
        req,
        res,
        'POST /extensions/check-updates',
        manager,
        'check-updates',
        {},
        async (extensionManager, signal, context) => {
          const states: Record<string, string> = {};
          await extensionManager.checkForAllExtensionUpdates(
            (name, state) => {
              states[name] = state;
            },
            signal,
            async (task) => await context!.prepare(async () => await task()),
          );
          return { status: 'checked', states };
        },
        {
          skipRefresh: true,
          deadlineMs: EXTENSION_UPDATE_CHECK_DEADLINE_MS,
        },
      );
    },
  );

  app.post(
    '/extensions/:extensionId/update',
    mutate({ strict: true }),
    (req, res) => {
      const extensionId = parseExtensionId(req, res);
      if (!extensionId) return;
      const manager = primaryController.createExtensionManager(
        boundWorkspace,
        true,
      );
      sendOperation(
        req,
        res,
        'POST /extensions/:extensionId/update',
        manager,
        'update',
        { name: extensionId },
        async (extensionManager, _signal, context) => {
          const extension = extensionById(extensionManager, extensionId);
          if (!extension)
            throw new Error(`Extension "${extensionId}" not found`);
          if (
            extension.installMetadata?.type !== 'git' &&
            extension.installMetadata?.type !== 'github-release' &&
            extension.installMetadata?.type !== 'npm'
          ) {
            throw new Error(
              `Extension "${extension.name}" is not remotely updatable.`,
            );
          }
          const preparedResult = await context!.prepare(
            async (signal) =>
              await extensionManager.prepareExtensionUpdate({
                extension,
                signal,
              }),
          );
          if (preparedResult.upToDate) {
            return {
              status: 'updated',
              name: extension.name,
              updated: false,
              reason: 'up_to_date',
            };
          }
          try {
            const committed = await context!.commit(
              async () =>
                await extensionManager.commitPreparedExtension(
                  preparedResult.prepared,
                ),
            );
            return {
              status: 'updated',
              name: extension.name,
              updated: true,
              version: committed.version,
            };
          } finally {
            await extensionManager.disposePreparedExtension(
              preparedResult.prepared,
            );
          }
        },
        {
          deadlineMs: EXTENSION_PREPARE_DEADLINE_MS,
          ...(workspaceRegistry
            ? { refreshRuntimes: workspaceRegistry.list() }
            : {}),
        },
      );
    },
  );

  app.delete(
    '/extensions/:extensionId',
    mutate({ strict: true }),
    async (req, res) => {
      const extensionId = parseExtensionId(req, res);
      if (!extensionId) return;
      const route = 'DELETE /extensions/:extensionId';
      if (
        !primaryController.validateExtensionMutationClient(req, res, route, {
          requireClientId: false,
        })
      ) {
        return;
      }
      try {
        const manager = primaryController.createExtensionManager(
          boundWorkspace,
          true,
        );
        await manager.refreshCache();
        const extension = extensionById(manager, extensionId);
        if (!extension) {
          res.status(204).end();
          return;
        }
        sendOperation(
          req,
          res,
          route,
          manager,
          'uninstall',
          { name: extension.name },
          async (extensionManager, _signal, context) => {
            await context!.commit(
              async () =>
                await extensionManager.uninstallExtension(
                  extension.name,
                  false,
                ),
            );
            return { status: 'uninstalled', name: extension.name };
          },
          {
            ...(workspaceRegistry
              ? { refreshRuntimes: workspaceRegistry.list() }
              : {}),
          },
        );
      } catch (error) {
        sendBridgeError(res, error, { route });
      }
    },
  );

  if (workspaceRegistry) {
    const registry = workspaceRegistry;
    app.get('/workspaces/:workspace/extensions', async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
      if (!runtime) return;
      try {
        const manager = primaryController.createExtensionManager(
          runtime.workspaceCwd,
          runtime.trusted,
        );
        await manager.refreshCache();
        const snapshot = await manager.getExtensionStoreSnapshot();
        const extensions = await Promise.all(
          manager.getLoadedExtensions().map(async (extension) => {
            const activation = await manager.getExtensionActivation(
              extension.id,
              runtime.workspaceCwd,
            );
            return {
              extensionId: extension.id,
              name: extension.name,
              version: extension.version,
              defaultActivation: activation.default,
              workspaceActivation:
                activation.workspace === 'inherit'
                  ? null
                  : activation.workspace,
              effectiveActivation: activation.effective,
              activationSource: activation.source,
            };
          }),
        );
        res.status(200).json({
          v: 1,
          workspaceId: runtime.workspaceId,
          workspaceCwd: runtime.workspaceCwd,
          trusted: runtime.trusted,
          desiredGeneration: snapshot.generation,
          appliedGeneration:
            appliedGenerationByWorkspaceId.get(runtime.workspaceId) ?? 0,
          extensions,
        });
      } catch (error) {
        sendBridgeError(res, error, {
          route: 'GET /workspaces/:workspace/extensions',
        });
      }
    });

    app.put(
      '/workspaces/:workspace/extensions/:extensionId/activation',
      mutate({ strict: true }),
      (req, res) => {
        const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
        if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
        const extensionId = parseExtensionId(req, res);
        if (!extensionId) return;
        const state = parseActivationState(req, res);
        if (!state) return;
        const manager = primaryController.createExtensionManager(
          runtime.workspaceCwd,
          true,
        );
        sendOperation(
          req,
          res,
          'PUT /workspaces/:workspace/extensions/:extensionId/activation',
          manager,
          'activation',
          { name: extensionId },
          async (extensionManager, _signal, context) => {
            const extension = extensionById(extensionManager, extensionId);
            if (!extension) {
              throw new Error(`Extension "${extensionId}" not found`);
            }
            await context!.commit(
              async () =>
                await extensionManager.setExtensionWorkspaceActivation(
                  extensionId,
                  runtime.workspaceCwd,
                  state,
                ),
            );
            return {
              status: state === 'enabled' ? 'enabled' : 'disabled',
              name: extension.name,
            };
          },
          { refreshRuntimes: [runtime] },
        );
      },
    );

    app.delete(
      '/workspaces/:workspace/extensions/:extensionId/activation',
      mutate({ strict: true }),
      (req, res) => {
        const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
        if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
        const extensionId = parseExtensionId(req, res);
        if (!extensionId) return;
        const manager = primaryController.createExtensionManager(
          runtime.workspaceCwd,
          true,
        );
        sendOperation(
          req,
          res,
          'DELETE /workspaces/:workspace/extensions/:extensionId/activation',
          manager,
          'activation',
          { name: extensionId },
          async (extensionManager, _signal, context) => {
            const extension = extensionById(extensionManager, extensionId);
            if (!extension) {
              throw new Error(`Extension "${extensionId}" not found`);
            }
            await context!.commit(
              async () =>
                await extensionManager.clearExtensionWorkspaceActivation(
                  extensionId,
                  runtime.workspaceCwd,
                ),
            );
            const activation = await extensionManager.getExtensionActivation(
              extensionId,
              runtime.workspaceCwd,
            );
            return { status: activation.effective, name: extension.name };
          },
          { refreshRuntimes: [runtime] },
        );
      },
    );

    app.post(
      '/workspaces/:workspace/extensions/refresh',
      mutate({ strict: true }),
      (req, res) => {
        const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
        if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
        const manager = primaryController.createExtensionManager(
          runtime.workspaceCwd,
          true,
        );
        sendOperation(
          req,
          res,
          'POST /workspaces/:workspace/extensions/refresh',
          manager,
          'refresh',
          {},
          async () => ({ status: 'refreshed' }),
          { refreshRuntimes: [runtime] },
        );
      },
    );
  }
}
