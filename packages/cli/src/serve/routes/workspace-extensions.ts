/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import {
  parseInstallSource,
  redactUrlCredentials,
  SettingScope,
  type Extension,
  type ExtensionInstallMetadata,
  type ExtensionManager,
  type ClaudeMarketplaceConfig,
  type ExtensionSetting,
} from '@qwen-code/qwen-code-core';
import type { Application, Request, RequestHandler, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { createFifoTaskQueue } from '../extension-operation-scheduler.js';
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
  type ExtensionPendingInteraction,
  type ExtensionOperationContext,
  type ExtensionsController,
  type RuntimeReconciliationReservation,
} from './workspace-extensions-controller.js';

type SafeBody = typeof safeBodyType;

const EXTENSION_PREPARE_DEADLINE_MS = 10 * 60_000;
const EXTENSION_INTERACTION_DEADLINE_MS = 10 * 60_000;
const EXTENSION_INTERACTIVE_PREPARE_DEADLINE_MS =
  EXTENSION_PREPARE_DEADLINE_MS + EXTENSION_INTERACTION_DEADLINE_MS;
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
    const colonIndex = source.indexOf(':');
    if (colonIndex >= 0 && source.slice(0, colonIndex).includes('/')) {
      return null;
    }
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
  if (parsed.protocol !== 'https:') {
    res.status(400).json({ error: '`source` must use https' });
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
    (installMetadata.networkPolicy === 'public'
      ? parsed.protocol === 'https:'
      : parsed.protocol === 'https:' || parsed.protocol === 'ssh:') &&
    !isBlockedAuthProviderHost(parsed.hostname)
  );
};

const redactExtensionDisplaySource = (source: string): string => {
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
  type ExtensionInteractionRequest =
    | Omit<
        Extract<ExtensionPendingInteraction, { kind: 'marketplace_plugin' }>,
        'id'
      >
    | Omit<Extract<ExtensionPendingInteraction, { kind: 'setting' }>, 'id'>;
  const pendingExtensionInteractions = new Map<
    string,
    {
      interaction: ExtensionPendingInteraction;
      resolve: (value: string) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const supersededInstallOperations = new Set<string>();
  const cancelPendingExtensionInteraction = (
    operationId: string,
    reason: string,
  ): void => {
    const pending = pendingExtensionInteractions.get(operationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingExtensionInteractions.delete(operationId);
    pending.reject(new Error(reason));
  };
  const supersedeActiveInstallOperations = (
    controller: ExtensionsController,
    currentOperationId: string,
  ): void => {
    for (const operation of controller.getActiveOperations()) {
      if (
        operation.operation !== 'install' ||
        operation.operationId === currentOperationId
      ) {
        continue;
      }
      supersededInstallOperations.add(operation.operationId);
      cancelPendingExtensionInteraction(
        operation.operationId,
        'Extension installation cancelled by a new install request',
      );
    }
  };
  const waitForExtensionInteraction = (
    controller: ExtensionsController,
    operationId: string,
    interaction: ExtensionInteractionRequest,
  ): Promise<string> => {
    if (supersededInstallOperations.delete(operationId)) {
      return Promise.reject(
        new Error('Extension installation superseded by a new install request'),
      );
    }
    const pendingInteraction = {
      ...interaction,
      id: crypto.randomUUID(),
    } as ExtensionPendingInteraction;
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingExtensionInteractions.delete(operationId);
        controller.updateOperation(operationId, {
          status: 'failed',
          phase: undefined,
          interaction: undefined,
          error: 'Extension interaction timed out',
        });
        reject(new Error('Extension interaction timed out'));
      }, EXTENSION_INTERACTION_DEADLINE_MS);
      timeout.unref?.();
      pendingExtensionInteractions.set(operationId, {
        interaction: pendingInteraction,
        resolve,
        reject,
        timeout,
      });
      controller.updateOperation(operationId, {
        status: 'waiting_for_input',
        phase: undefined,
        interaction: pendingInteraction,
      });
    });
  };
  const extensionInteractionHandlers = (
    controller: ExtensionsController,
    operationId: string,
  ) => ({
    requestSetting: (setting: ExtensionSetting) =>
      waitForExtensionInteraction(controller, operationId, {
        kind: 'setting',
        setting: {
          name: setting.name,
          description: setting.description,
          sensitive: setting.sensitive === true,
        },
      }),
    requestChoicePlugin: (marketplace: ClaudeMarketplaceConfig) => {
      if (marketplace.plugins.length === 0) {
        return Promise.reject(
          new Error(`Marketplace "${marketplace.name}" has no plugins`),
        );
      }
      return waitForExtensionInteraction(controller, operationId, {
        kind: 'marketplace_plugin',
        marketplace: { name: marketplace.name },
        plugins: marketplace.plugins.map((plugin) => ({
          name: plugin.name,
          ...(plugin.description ? { description: plugin.description } : {}),
          source: redactExtensionDisplaySource(
            typeof plugin.source === 'string'
              ? plugin.source
              : plugin.source.source === 'github'
                ? plugin.source.repo
                : plugin.source.source === 'git-subdir'
                  ? plugin.source.path
                  : plugin.source.url,
          ),
          ...(plugin.category ? { category: plugin.category } : {}),
          ...(plugin.tags ? { tags: plugin.tags } : {}),
        })),
      });
    },
  });
  const runtimeReconciliationQueue = createFifoTaskQueue(1);
  const reserveRuntimeReconciliation = (): RuntimeReconciliationReservation => {
    let provideTask!: (task?: () => Promise<unknown>) => void;
    const task = new Promise<(() => Promise<unknown>) | undefined>(
      (resolve) => {
        provideTask = resolve;
      },
    );
    const queued = runtimeReconciliationQueue.run(async () => {
      const run = await task;
      return run ? await run() : undefined;
    });
    let used = false;
    return {
      run: async <T>(run: () => Promise<T>): Promise<T> => {
        if (used) throw new Error('Runtime reconciliation already released');
        used = true;
        provideTask(run);
        return (await queued) as T;
      },
      release: () => {
        if (used) return;
        used = true;
        provideTask(undefined);
      },
    };
  };
  const appliedGenerationByWorkspaceId = new Map<string, number>();
  const onRuntimeReconciled = (
    runtime: WorkspaceRuntime,
    generation: number,
  ): void => {
    appliedGenerationByWorkspaceId.set(runtime.workspaceId, generation);
  };
  const globalReconciliationOptions = () =>
    workspaceRegistry
      ? {
          refreshRuntimes: () => workspaceRegistry.list(),
          reserveRuntimeReconciliation,
          onRuntimeReconciled,
        }
      : {};
  const workspaceReconciliationOptions = () =>
    workspaceRegistry
      ? {
          refreshRuntimes: [workspaceRegistry.primary],
          reserveRuntimeReconciliation,
          onRuntimeReconciled,
        }
      : {};
  const mutationClientBridges = (
    runtimes?:
      | readonly WorkspaceRuntime[]
      | (() => readonly WorkspaceRuntime[]),
  ): readonly AcpSessionBridge[] =>
    (typeof runtimes === 'function'
      ? runtimes()
      : (runtimes ?? workspaceRegistry?.list())
    )?.map((runtime) => runtime.bridge) ?? [bridge];

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
        const pendingRuntimes = workspaceRegistry
          .list()
          .filter(
            (runtime) =>
              (appliedGenerationByWorkspaceId.get(runtime.workspaceId) ?? 0) !==
              generation,
          );
        if (generation === observedGeneration && pendingRuntimes.length === 0)
          return;
        const runtimes = pendingRuntimes;
        if (runtimes.length === 0) return;
        const results = await runtimeReconciliationQueue.run(
          async () =>
            await Promise.allSettled(
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
            ),
        );
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            const workspaceId = runtimes[index]!.workspaceId;
            appliedGenerationByWorkspaceId.set(workspaceId, generation);
          } else {
            writeStderrLine(
              `qwen serve: extension generation reconciliation failed for workspace ${runtimes[index]!.workspaceId}: ${redactUrlCredentials(
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
              )}`,
            );
          }
        });
        if (
          runtimes.length === pendingRuntimes.length &&
          results.every((result) => result.status === 'fulfilled')
        ) {
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
        res.status(200).json(await ctrl.buildLocalExtensionsStatus());
      } catch (err) {
        sendBridgeError(res, err, { route: `GET ${base}` });
      }
    });

    app.get(`${base}/operations`, async (req, res) => {
      const ctrl = resolve(req, res, false);
      if (!ctrl) return;
      res.status(200).json({ v: 1, operations: ctrl.getActiveOperations() });
    });

    app.get(`${base}/operations/:operationId`, async (req, res) => {
      const ctrl = resolve(req, res, false);
      if (!ctrl) return;
      try {
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
        if (
          base === '/workspace/extensions' &&
          operation.status === 'succeeded_with_warnings'
        ) {
          const warningError =
            operation.warnings?.find((warning) => warning.code === undefined)
              ?.error ??
            operation.warnings?.[0]?.error ??
            operation.result?.error;
          const legacyOperation = {
            ...operation,
            status: 'succeeded_with_refresh_error' as const,
          };
          if (operation.result && warningError) {
            legacyOperation.result = {
              ...operation.result,
              error: warningError,
            };
          } else if (warningError) {
            legacyOperation.error = warningError;
          }
          res.status(200).json(legacyOperation);
          return;
        }
        res.status(200).json(operation);
      } catch (err) {
        sendBridgeError(res, err, {
          route: `GET ${base}/operations/:operationId`,
        });
      }
    });

    app.post(
      `${base}/operations/:operationId/interactions/:interactionId`,
      mutate({ strict: true }),
      async (req, res) => {
        const ctrl = resolve(req, res, false);
        if (!ctrl) return;
        try {
          if (
            !ctrl.validateExtensionMutationClient(req, res, {
              requireClientId: false,
            })
          ) {
            return;
          }
          const operationId = req.params['operationId'];
          const interactionId = req.params['interactionId'];
          const pending = operationId
            ? pendingExtensionInteractions.get(operationId)
            : undefined;
          if (!operationId || !interactionId || !pending) {
            res.status(404).json({ error: 'Extension interaction not found' });
            return;
          }
          if (pending.interaction.id !== interactionId) {
            res.status(404).json({ error: 'Extension interaction not found' });
            return;
          }
          const body = safeBody(req);
          let value: string;
          if (body['cancelled'] === true) {
            clearTimeout(pending.timeout);
            pendingExtensionInteractions.delete(operationId);
            ctrl.updateOperation(operationId, {
              status: 'failed',
              phase: undefined,
              interaction: undefined,
              error: 'Extension operation cancelled',
            });
            pending.reject(new Error('Extension operation cancelled'));
            res.status(200).json({ accepted: true });
            return;
          }
          if (pending.interaction.kind === 'marketplace_plugin') {
            const pluginName = body['pluginName'];
            if (
              typeof pluginName !== 'string' ||
              !pending.interaction.plugins.some(
                (plugin) => plugin.name === pluginName,
              )
            ) {
              res
                .status(400)
                .json({ error: 'Invalid marketplace plugin name' });
              return;
            }
            value = pluginName;
          } else {
            const settingValue = body['value'];
            if (typeof settingValue !== 'string') {
              res
                .status(400)
                .json({ error: 'Extension setting value must be a string' });
              return;
            }
            value = settingValue;
          }
          clearTimeout(pending.timeout);
          pendingExtensionInteractions.delete(operationId);
          ctrl.updateOperation(operationId, {
            status: 'running',
            phase: 'preparing',
            interaction: undefined,
            error: undefined,
          });
          pending.resolve(value);
          res.status(200).json({ accepted: true });
        } catch (err) {
          sendBridgeError(res, err, {
            route: `POST ${base}/operations/:operationId/interactions/:interactionId`,
          });
        }
      },
    );

    // POST {base}/install — install an extension and refresh all active
    // sessions asynchronously.
    app.post(`${base}/install`, mutate({ strict: true }), async (req, res) => {
      const ctrl = resolve(req, res, true);
      if (!ctrl) return;
      try {
        if (
          !ctrl.validateExtensionMutationClient(req, res, {
            requireClientId: false,
          })
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
        const localSource =
          /^[A-Za-z]:[\\/]/.test(sourceValue) ||
          sourceValue.startsWith('/') ||
          sourceValue.startsWith('.');
        if (localSource) {
          try {
            const metadata = await parseInstallSource(sourceValue, {
              networkPolicy: 'public',
            });
            if (
              metadata.type !== 'git' &&
              metadata.type !== 'github-release' &&
              metadata.type !== 'npm'
            ) {
              res.status(400).json({
                error:
                  'Only GitHub, Git, and npm extension installs are supported over the daemon endpoint.',
              });
              return;
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Invalid install source';
            res.status(400).json({
              error: redactUrlCredentials(
                message.replace(
                  sourceValue,
                  redactExtensionDisplaySource(sourceValue),
                ),
              ),
            });
            return;
          }
        }
        const npmSource = sourceValue.startsWith('@');
        const remoteSource =
          npmSource ||
          sourceValue.startsWith('https://') ||
          /^[^/\s]+\/[^/\s]+/.test(sourceValue);
        if (!localSource && !remoteSource) {
          res.status(400).json({
            error: `Install source not found: ${redactExtensionDisplaySource(
              sourceValue,
            )}`,
          });
          return;
        }
        if (npmSource && refValue) {
          res
            .status(400)
            .json({ error: '--ref is not applicable for npm extensions.' });
          return;
        }
        if (!npmSource && registryValue) {
          res.status(400).json({
            error: '--registry is only applicable for npm extensions.',
          });
          return;
        }

        ctrl.runQueuedExtensionMutation(
          'install',
          { source: sourceValue },
          res,
          async (extensionManager, _signal, context, operationId) => {
            const prepared = await context!.prepare(async (signal) => {
              const installMetadata = await parseInstallSource(sourceValue, {
                networkPolicy: 'public',
              });

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
              supersedeActiveInstallOperations(ctrl, operationId!);
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
                async (onCommitted) =>
                  await extensionManager.commitPreparedExtension(
                    prepared,
                    onCommitted,
                  ),
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
            createManager: (operationId) =>
              ctrl.createExtensionManager(
                undefined,
                undefined,
                extensionInteractionHandlers(ctrl, operationId),
              ),
            onSettled: (operationId) => {
              supersededInstallOperations.delete(operationId);
              cancelPendingExtensionInteraction(
                operationId,
                'Extension operation ended',
              );
            },
            deadlineMs: EXTENSION_INTERACTIVE_PREPARE_DEADLINE_MS,
            ...globalReconciliationOptions(),
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
        let releaseOperationSlot: (() => void) | undefined;
        try {
          if (
            !ctrl.validateExtensionMutationClient(req, res, {
              requireClientId: false,
            })
          ) {
            return;
          }
          releaseOperationSlot = ctrl.acquireOperationSlot(res);
          if (!releaseOperationSlot) return;
          const extensionManager = ctrl.createExtensionManager();
          const updateStates: Record<string, string> = Object.create(null);
          const deadline = new AbortController();
          timer = setTimeout(() => {
            const error = new Error(
              'Extension update check exceeded its preparation deadline.',
            ) as Error & { code: string };
            error.code = 'extension_prepare_timeout';
            deadline.abort(error);
          }, EXTENSION_UPDATE_CHECK_DEADLINE_MS);
          timer.unref();
          let rejectRefreshOnAbort: (() => void) | undefined;
          try {
            await Promise.race([
              extensionManager.refreshCache(),
              new Promise<never>((_resolve, reject) => {
                rejectRefreshOnAbort = () => reject(deadline.signal.reason);
                deadline.signal.addEventListener(
                  'abort',
                  rejectRefreshOnAbort,
                  { once: true },
                );
              }),
            ]);
          } finally {
            if (rejectRefreshOnAbort) {
              deadline.signal.removeEventListener(
                'abort',
                rejectRefreshOnAbort,
              );
            }
          }
          await extensionManager.checkForAllExtensionUpdates(
            (name, state) => {
              updateStates[name] = state;
            },
            deadline.signal,
            async (task) =>
              await ctrl.preparationQueue.run(task, {
                signal: deadline.signal,
              }),
          );
          const states = updateStates;
          res.status(200).json({ states });
        } catch (err) {
          sendBridgeError(res, err, { route: `POST ${base}/check-updates` });
        } finally {
          if (timer) clearTimeout(timer);
          releaseOperationSlot?.();
        }
      },
    );

    app.post(`${base}/refresh`, mutate({ strict: true }), async (req, res) => {
      const ctrl = resolve(req, res, true);
      if (!ctrl) return;
      try {
        if (
          !ctrl.validateExtensionMutationClient(req, res, {
            requireClientId: false,
          })
        ) {
          return;
        }
        const releaseOperationSlot = ctrl.acquireOperationSlot(res);
        if (!releaseOperationSlot) return;
        try {
          const result = await ctrl.refreshExtensionsForAllSessions();
          res.status(200).json(result);
        } finally {
          releaseOperationSlot();
        }
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
            !ctrl.validateExtensionMutationClient(req, res, {
              requireClientId: false,
            })
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
                async (onCommitted) =>
                  await extensionManager.enableExtension(
                    extension.name,
                    scope,
                    ctrl.boundWorkspace,
                    onCommitted,
                  ),
              );
              return { status: 'enabled', name: extension.name };
            },
            {
              ...(scope === SettingScope.User
                ? globalReconciliationOptions()
                : workspaceReconciliationOptions()),
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
            !ctrl.validateExtensionMutationClient(req, res, {
              requireClientId: false,
            })
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
                async (onCommitted) =>
                  await extensionManager.disableExtension(
                    extension.name,
                    scope,
                    ctrl.boundWorkspace,
                    onCommitted,
                  ),
              );
              return { status: 'disabled', name: extension.name };
            },
            {
              ...(scope === SettingScope.User
                ? globalReconciliationOptions()
                : workspaceReconciliationOptions()),
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
            !ctrl.validateExtensionMutationClient(req, res, {
              requireClientId: false,
            })
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
                const wrapped = new Error(
                  `Update check failed for extension "${extension.name}": ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  { cause: error },
                ) as Error & { code?: string };
                if (
                  error &&
                  typeof error === 'object' &&
                  typeof (error as { code?: unknown }).code === 'string'
                ) {
                  wrapped.code = (error as { code: string }).code;
                }
                throw wrapped;
              }
              if (preparedResult.upToDate) {
                throw new Error(`Extension "${extension.name}" has no update`);
              }
              try {
                const committed = await context!.commit(
                  async (onCommitted) =>
                    await extensionManager.commitPreparedExtension(
                      preparedResult.prepared,
                      onCommitted,
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
              createManager: (operationId) =>
                ctrl.createExtensionManager(
                  undefined,
                  undefined,
                  extensionInteractionHandlers(ctrl, operationId),
                ),
              deadlineMs: EXTENSION_INTERACTIVE_PREPARE_DEADLINE_MS,
              ...globalReconciliationOptions(),
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
          !ctrl.validateExtensionMutationClient(req, res, {
            requireClientId: false,
          })
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
              async (onCommitted) =>
                await extensionManager.uninstallExtension(
                  extension.name,
                  false,
                  ctrl.boundWorkspace,
                  onCommitted,
                ),
            );
            return { status: 'uninstalled', name: extension.name };
          },
          {
            ...globalReconciliationOptions(),
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
      refreshRuntimes?:
        | readonly WorkspaceRuntime[]
        | (() => readonly WorkspaceRuntime[]);
      skipRefresh?: boolean;
      deadlineMs?: number;
    } = {},
  ): void => {
    if (
      !primaryController.validateExtensionMutationClient(req, res, {
        requireClientId: false,
        bridges: mutationClientBridges(options.refreshRuntimes),
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
        onRuntimeReconciled,
        reserveRuntimeReconciliation,
        ...options,
      },
    );
  };

  app.get('/extensions', async (_req, res) => {
    try {
      const manager = primaryController.createExtensionManager(
        boundWorkspace,
        true,
      );
      const snapshot = await manager.refreshCacheWithSnapshot();
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
            async (onCommitted) =>
              await extensionManager.setExtensionDefaultActivation(
                extensionId,
                state,
                onCommitted,
              ),
          );
          return {
            status: state === 'enabled' ? 'enabled' : 'disabled',
            name: extension.name,
          };
        },
        {
          ...(workspaceRegistry
            ? { refreshRuntimes: () => workspaceRegistry.list() }
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
          const metadata = await parseInstallSource(source, {
            networkPolicy: 'public',
          });
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
            async (onCommitted) =>
              await extensionManager.commitPreparedExtension(
                prepared,
                onCommitted,
              ),
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
          ? { refreshRuntimes: () => workspaceRegistry.list() }
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
          const states: Record<string, string> = Object.create(null);
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
            extension.installMetadata?.type !== 'archive-url' &&
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
              status: 'checked',
              name: extension.name,
              updated: false,
              reason: 'up_to_date',
            };
          }
          try {
            const committed = await context!.commit(
              async (onCommitted) =>
                await extensionManager.commitPreparedExtension(
                  preparedResult.prepared,
                  onCommitted,
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
            ? { refreshRuntimes: () => workspaceRegistry.list() }
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
        !primaryController.validateExtensionMutationClient(req, res, {
          requireClientId: false,
          bridges: mutationClientBridges(),
        })
      ) {
        return;
      }
      try {
        const manager = primaryController.createExtensionManager(
          boundWorkspace,
          true,
        );
        const snapshot = await manager.getExtensionStoreSnapshot();
        const policy = snapshot.extensions[extensionId];
        if (!policy) {
          res.status(204).end();
          return;
        }
        sendOperation(
          req,
          res,
          route,
          manager,
          'uninstall',
          { name: policy.name },
          async (extensionManager, _signal, context) => {
            await context!.commit(
              async (onCommitted) =>
                await extensionManager.uninstallExtensionById(
                  extensionId,
                  false,
                  undefined,
                  onCommitted,
                ),
            );
            return { status: 'uninstalled', name: policy.name };
          },
          {
            ...(workspaceRegistry
              ? { refreshRuntimes: () => workspaceRegistry.list() }
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
        const snapshot = await manager.refreshCacheWithSnapshot();
        const extensions = manager.getLoadedExtensions().map((extension) => {
          const activation = manager.getExtensionActivationFromSnapshot(
            extension.id,
            snapshot,
            runtime.workspaceCwd,
          );
          return {
            extensionId: extension.id,
            name: extension.name,
            version: extension.version,
            defaultActivation: activation.default,
            workspaceActivation:
              activation.workspace === 'inherit' ? null : activation.workspace,
            effectiveActivation: activation.effective,
            activationSource: activation.source,
          };
        });
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
              async (onCommitted) =>
                await extensionManager.setExtensionWorkspaceActivation(
                  extensionId,
                  runtime.workspaceCwd,
                  state,
                  onCommitted,
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
            const snapshot = await context!.commit(
              async (onCommitted) =>
                await extensionManager.clearExtensionWorkspaceActivation(
                  extensionId,
                  runtime.workspaceCwd,
                  onCommitted,
                ),
            );
            const activation =
              extensionManager.getExtensionActivationFromSnapshot(
                extensionId,
                snapshot,
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
