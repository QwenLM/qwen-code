/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExtensionUpdateState,
  checkForExtensionUpdate,
  parseInstallSource,
  redactUrlCredentials,
  SettingScope,
  type Extension,
  type ExtensionInstallMetadata,
  type ExtensionManager,
} from '@qwen-code/qwen-code-core';
import type { Application, Request, RequestHandler, Response } from 'express';
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
  withExtensionTimeout,
  type ExtensionsController,
} from './workspace-extensions-controller.js';

type SafeBody = typeof safeBodyType;

const EXTENSION_REFRESH_TIMEOUT_MS = 30_000;

const isExtensionQueueFullError = (err: unknown): boolean =>
  err instanceof Error && err.message === 'Extension operation queue is full';

const sendExtensionQueueFull = (res: Response): void => {
  res.status(429).json({
    error: 'Extension operation queue is full',
    code: 'extension_queue_full',
  });
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
  // When provided, additionally mounts the workspace-qualified plural routes
  // `/workspaces/:workspace/extensions/*`, dispatching each request to the
  // resolved runtime's own extensions controller. Reads resolve the runtime
  // only; mutations additionally require the workspace to be trusted.
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
        res.status(200).json(operation);
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
        sendBridgeError(res, err, { route: `POST ${base}/install` });
      }
    });

    app.post(
      `${base}/check-updates`,
      mutate({ strict: true }),
      async (req, res) => {
        const ctrl = resolve(req, res, true);
        if (!ctrl) return;
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
          const states = await ctrl.enqueueExtensionInstall(async () =>
            withExtensionTimeout(
              (async () => {
                const extensionManager = ctrl.createExtensionManager();
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
          sendBridgeError(res, err, { route: `POST ${base}/check-updates` });
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
        const result = await ctrl.enqueueExtensionInstall(async () =>
          withExtensionTimeout(
            ctrl.workspace.refreshExtensionsForAllSessions(),
            EXTENSION_REFRESH_TIMEOUT_MS,
            'extension refresh',
          ),
        );
        ctrl.invalidateStatusCache();
        res.status(200).json(result);
      } catch (err) {
        if (isExtensionQueueFullError(err)) {
          sendExtensionQueueFull(res);
          return;
        }
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
            async (extensionManager) => {
              const extension = findLoadedExtension(extensionManager, name);
              if (!extension) {
                throw new Error(`Extension "${name}" not found`);
              }
              await extensionManager.enableExtension(
                extension.name,
                scope,
                ctrl.boundWorkspace,
              );
              return { status: 'enabled', name: extension.name };
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
            async (extensionManager) => {
              const extension = findLoadedExtension(extensionManager, name);
              if (!extension) {
                throw new Error(`Extension "${name}" not found`);
              }
              await extensionManager.disableExtension(
                extension.name,
                scope,
                ctrl.boundWorkspace,
              );
              return { status: 'disabled', name: extension.name };
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
                ...(info?.updatedVersion
                  ? { version: info.updatedVersion }
                  : {}),
              };
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
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await extensionManager.uninstallExtension(
              extension.name,
              false,
              ctrl.boundWorkspace,
            );
            return { status: 'uninstalled', name: extension.name };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, { route: `DELETE ${base}/:name` });
      }
    });
  };

  // Legacy singular routes bound to the primary workspace (behavior unchanged).
  registerFor('/workspace/extensions', () => primaryController);

  // Workspace-qualified plural routes. Each workspace gets its own controller
  // (its own install queue, operation history, and status cache); the primary
  // is shared with the singular routes so both surfaces observe one queue.
  if (workspaceRegistry) {
    const registry = workspaceRegistry;
    const controllers = new Map<string, ExtensionsController>([
      [boundWorkspace, primaryController],
    ]);
    const getOrCreateController = (
      runtime: WorkspaceRuntime,
    ): ExtensionsController => {
      let controller = controllers.get(runtime.workspaceCwd);
      if (!controller) {
        controller = createExtensionsController(
          controllerDeps(
            runtime.workspaceCwd,
            runtime.bridge,
            runtime.workspaceService,
          ),
        );
        controllers.set(runtime.workspaceCwd, controller);
      }
      return controller;
    };
    registerFor(
      '/workspaces/:workspace/extensions',
      (req, res, requireTrust) => {
        const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
        if (!runtime) return null;
        if (requireTrust && !requireTrustedWorkspaceRuntime(runtime, res)) {
          return null;
        }
        return getOrCreateController(runtime);
      },
    );
  }
}
