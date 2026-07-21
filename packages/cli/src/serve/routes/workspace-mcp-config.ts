/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { matchesAnyServerPattern } from '@qwen-code/qwen-code-core';
import type { Application, Request, Response } from 'express';
import {
  redactMcpServersSetting,
  restoreRedactedMcpServersSetting,
} from '../../config/mcp-server-secrets.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  getNestedProperty,
  getSettingDefinition,
  validateSettingValue,
} from '../../utils/settingsUtils.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { WorkspaceDrainingError } from '../acp-session-bridge.js';
import type { SendBridgeError } from '../server/error-response.js';
import { validateMcpRuntimeServerName } from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';

const mcpServerMutationQueues = new Map<string, Promise<void>>();

class McpServerExcludedByPatternError extends Error {
  constructor(readonly patterns: readonly string[]) {
    super(`MCP server is excluded by pattern: ${patterns.join(', ')}`);
  }
}

export interface McpServerSettingMutation {
  operation: 'set' | 'remove';
  name: string;
}

interface WorkspaceMcpConfigRouteDeps {
  boundWorkspace: string;
  workspaceRuntime: WorkspaceRuntime;
  workspaceRegistry?: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  persistSetting: (
    workspace: string,
    scope: SettingScope,
    key: string,
    value: unknown,
  ) => Promise<void>;
  broadcastSettingsChanged: (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => void;
}

interface WorkspaceQualifiedMcpConfigRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: WorkspaceMcpConfigRouteDeps['mutate'];
  safeBody: WorkspaceMcpConfigRouteDeps['safeBody'];
  persistSetting: WorkspaceMcpConfigRouteDeps['persistSetting'];
  invalidateServeFeaturesCache: () => void;
  sendBridgeError: SendBridgeError;
}

function sendDrainingError(
  res: Response,
  error: unknown,
  route: string,
  sendBridgeError: SendBridgeError,
): boolean {
  if (!(error instanceof WorkspaceDrainingError)) return false;
  sendBridgeError(res, error, { route });
  return true;
}

function updateMcpEnabledConfiguration(
  workspaceCwd: string,
  serverName: string,
  enabled: boolean,
  writableScopes: readonly SettingScope[],
): Array<{ scope: SettingScope; value: string[] }> {
  const settings = loadSettings(workspaceCwd);
  const changes: Array<{ scope: SettingScope; value: string[] }> = [];
  if (enabled) {
    const allScopes = [
      SettingScope.SystemDefaults,
      SettingScope.System,
      SettingScope.User,
      ...(settings.isTrusted === false ||
      settings.workspaceSettingsActive === false
        ? []
        : [SettingScope.Workspace]),
    ];
    const blockingPatterns = [
      ...new Set(
        allScopes.flatMap((scope) =>
          (settings.forScope(scope).settings.mcp?.excluded ?? []).filter(
            (pattern) =>
              matchesAnyServerPattern(serverName, [pattern]) &&
              (pattern !== serverName || !writableScopes.includes(scope)),
          ),
        ),
      ),
    ];
    if (blockingPatterns.length > 0) {
      throw new McpServerExcludedByPatternError(blockingPatterns);
    }
    for (const scope of writableScopes) {
      const excluded = settings.forScope(scope).settings.mcp?.excluded ?? [];
      const next = excluded.filter((pattern) => pattern !== serverName);
      if (next.length !== excluded.length) {
        settings.setValue(scope, 'mcp.excluded', next);
        changes.push({ scope, value: next });
      }
    }
    return changes;
  }
  const userSettings = settings.forScope(SettingScope.User).settings;
  const workspaceSettings = settings.forScope(SettingScope.Workspace).settings;
  const preferredScope =
    workspaceSettings.mcpServers?.[serverName] !== undefined
      ? SettingScope.Workspace
      : userSettings.mcpServers?.[serverName] !== undefined
        ? SettingScope.User
        : SettingScope.Workspace;
  const scope = writableScopes.includes(preferredScope)
    ? preferredScope
    : writableScopes[0];
  if (!scope) return changes;
  const excluded = settings.forScope(scope).settings.mcp?.excluded ?? [];
  if (!matchesAnyServerPattern(serverName, excluded)) {
    settings.setValue(scope, 'mcp.excluded', [...excluded, serverName]);
    changes.push({ scope, value: [...excluded, serverName] });
  }
  return changes;
}

function registerMcpEnablementRoutes(
  app: Application,
  base: string,
  mutate: WorkspaceMcpConfigRouteDeps['mutate'],
  resolveRuntime: (req: Request, res: Response) => WorkspaceRuntime | null,
  writableScopes: readonly SettingScope[],
  onConfigurationChanged: (
    runtime: WorkspaceRuntime,
    changes: ReadonlyArray<{ scope: SettingScope; value: string[] }>,
  ) => void,
  affectedRuntimes: (
    runtime: WorkspaceRuntime,
    changes: ReadonlyArray<{ scope: SettingScope; value: string[] }>,
  ) => readonly WorkspaceRuntime[],
  sendBridgeError: SendBridgeError,
): void {
  for (const action of ['enable', 'disable'] as const) {
    app.post(
      `${base}/config/mcp/:server/${action}`,
      mutate({ strict: true }),
      async (req, res) => {
        const runtime = resolveRuntime(req, res);
        if (!runtime) return;
        const serverName = req.params['server'];
        if (!validateMcpRuntimeServerName(serverName, res)) return;
        try {
          const result = await getWorkspaceRuntimeCoordinator(
            runtime,
          ).runManagementOperation(async () => {
            const changes = updateMcpEnabledConfiguration(
              runtime.workspaceCwd,
              serverName,
              action === 'enable',
              writableScopes,
            );
            const changed = changes.length > 0;
            if (changed) onConfigurationChanged(runtime, changes);
            return {
              changed,
              activation: scheduleMcpConfiguration(
                affectedRuntimes(runtime, changes),
              ),
            };
          });
          res.status(200).json({
            serverName,
            action,
            ok: true,
            ...result,
          });
        } catch (error) {
          if (
            sendDrainingError(
              res,
              error,
              `POST ${base}/config/mcp/:server/${action}`,
              sendBridgeError,
            )
          ) {
            return;
          }
          if (error instanceof McpServerExcludedByPatternError) {
            res.status(409).json({
              error: error.message,
              code: 'mcp_excluded_by_pattern',
              patterns: error.patterns,
            });
            return;
          }
          res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
            code: 'persist_error',
          });
        }
      },
    );
  }
}

function settingValues(loaded: ReturnType<typeof loadSettings>, key: string) {
  const definition = getSettingDefinition(key);
  if (!definition) return undefined;
  const effective = getNestedProperty(
    loaded.merged as Record<string, unknown>,
    key,
  );
  const user = getNestedProperty(
    loaded.user.settings as Record<string, unknown>,
    key,
  );
  const workspace = getNestedProperty(
    loaded.workspace.settings as Record<string, unknown>,
    key,
  );
  return {
    effective: effective === undefined ? definition.default : effective,
    user,
    workspace,
  };
}

function buildMcpConfigStatus(workspaceCwd: string) {
  const loaded = loadSettings(workspaceCwd);
  const serverValues = settingValues(loaded, 'mcpServers');
  const excludedValues = settingValues(loaded, 'mcp.excluded');
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (redactMcpServersSetting(value) as Record<string, unknown>)
      : {};
  const effective = asRecord(serverValues?.effective);
  const user = asRecord(serverValues?.user);
  const workspace = asRecord(serverValues?.workspace);
  const excludedPatterns = Array.isArray(excludedValues?.effective)
    ? excludedValues.effective.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const excludedPatternsByScope = {
    user: Array.isArray(excludedValues?.user)
      ? excludedValues.user.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    workspace: Array.isArray(excludedValues?.workspace)
      ? excludedValues.workspace.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  };
  const serverNames = new Set([
    ...Object.keys(effective),
    ...Object.keys(user),
    ...Object.keys(workspace),
  ]);
  const disabledServers = [...serverNames]
    .filter((name) => matchesAnyServerPattern(name, excludedPatterns))
    .sort();
  return {
    v: 1 as const,
    effective,
    user,
    workspace,
    disabledServers,
    disabledServerScopes: Object.fromEntries(
      disabledServers.map((name) => [
        name,
        (['user', 'workspace'] as const).filter((scope) =>
          matchesAnyServerPattern(name, excludedPatternsByScope[scope]),
        ),
      ]),
    ),
  };
}

export function prepareMcpServersSettingWrite(
  workspace: string,
  scope: SettingScope,
  value: unknown,
  mutation?: McpServerSettingMutation,
): { persistedValue: unknown; publicValue: unknown } {
  const existing =
    loadSettings(workspace).forScope(scope).settings.mcpServers ?? {};
  let nextValue = value;
  if (mutation) {
    const servers = { ...existing };
    if (mutation.operation === 'set') {
      servers[mutation.name] = value as (typeof servers)[string];
    } else {
      delete servers[mutation.name];
    }
    nextValue = servers;
  }
  const persistedValue = restoreRedactedMcpServersSetting(nextValue, existing);
  return {
    persistedValue,
    publicValue: redactMcpServersSetting(persistedValue),
  };
}

export function parseMcpServerMutation(
  key: string,
  value: unknown,
): McpServerSettingMutation | undefined {
  if (value === undefined) return undefined;
  if (key !== 'mcpServers' || typeof value !== 'object' || value === null) {
    throw new Error('mcpServerMutation is only valid for mcpServers');
  }
  const operation = (value as Record<string, unknown>)['operation'];
  const name = (value as Record<string, unknown>)['name'];
  if (
    (operation !== 'set' && operation !== 'remove') ||
    typeof name !== 'string' ||
    !name.trim()
  ) {
    throw new Error('mcpServerMutation requires a valid operation and name');
  }
  return { operation, name };
}

export async function withMcpServerMutationLock<T>(
  workspace: string,
  scope: SettingScope,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${workspace}\0${scope}`;
  const previous = mcpServerMutationQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  mcpServerMutationQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (mcpServerMutationQueues.get(key) === tail) {
      mcpServerMutationQueues.delete(key);
    }
  }
}

export function scheduleMcpConfiguration(
  runtimes: readonly WorkspaceRuntime[],
): 'deferred' | 'reconciling' {
  let reconciling = false;
  for (const runtime of runtimes) {
    try {
      if (
        getWorkspaceRuntimeCoordinator(runtime).reconcileMcpConfiguration() ===
        'reconciling'
      ) {
        reconciling = true;
      }
    } catch {
      // Durable configuration is already committed; activation is best-effort.
    }
  }
  return reconciling ? 'reconciling' : 'deferred';
}

export function registerWorkspaceMcpConfigRoutes(
  app: Application,
  deps: WorkspaceMcpConfigRouteDeps,
): void {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    persistSetting,
    broadcastSettingsChanged,
  } = deps;

  registerMcpEnablementRoutes(
    app,
    '/workspace',
    mutate,
    () => deps.workspaceRuntime,
    [SettingScope.User],
    (_runtime, changes) => {
      for (const change of changes) {
        broadcastSettingsChanged(
          'mcp.excluded',
          change.value,
          change.scope === SettingScope.User ? 'user' : 'workspace',
          undefined,
        );
      }
    },
    (runtime, changes) =>
      changes.some((change) => change.scope === SettingScope.User)
        ? (deps.workspaceRegistry?.listManaged() ?? [runtime])
        : [runtime],
    deps.sendBridgeError,
  );

  app.get('/workspace/config/mcp/servers', (_req, res) => {
    try {
      res.status(200).json(buildMcpConfigStatus(boundWorkspace));
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspace/config/mcp/servers error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load MCP server configuration',
        code: 'internal_error',
      });
    }
  });

  app.put(
    '/workspace/config/mcp/servers/:name',
    mutate({ strict: true }),
    async (req, res) => {
      const name = req.params['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      const body = safeBody(req);
      const scope = body['scope'];
      const config = body['config'];
      if (scope !== 'user') {
        res.status(400).json({
          error: 'scope must be user',
          code: 'invalid_scope',
        });
        return;
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        res.status(400).json({
          error: 'config is required and must be an object',
          code: 'invalid_mcp_server_config',
        });
        return;
      }
      const settingScope = SettingScope.User;
      const definition = getSettingDefinition('mcpServers');
      if (!definition) return;
      let publicValue: unknown;
      try {
        await withMcpServerMutationLock(
          boundWorkspace,
          settingScope,
          async () => {
            const prepared = prepareMcpServersSettingWrite(
              boundWorkspace,
              settingScope,
              config,
              { operation: 'set', name },
            );
            const validationError = validateSettingValue(
              definition,
              prepared.persistedValue,
            );
            if (validationError) {
              const error = new Error(validationError) as Error & {
                code?: string;
              };
              error.code = 'invalid_mcp_server_config';
              throw error;
            }
            publicValue = prepared.publicValue;
            await persistSetting(
              boundWorkspace,
              settingScope,
              'mcpServers',
              prepared.persistedValue,
            );
          },
        );
      } catch (err) {
        if (
          err instanceof Error &&
          (err as Error & { code?: string }).code ===
            'invalid_mcp_server_config'
        ) {
          res.status(400).json({
            error: err.message,
            code: (err as Error & { code: string }).code,
          });
          return;
        }
        res.status(500).json({
          error: 'Failed to persist MCP server configuration',
          code: 'persist_error',
        });
        return;
      }
      broadcastSettingsChanged('mcpServers', publicValue, scope, undefined);
      const activation = scheduleMcpConfiguration(
        deps.workspaceRegistry?.listManaged() ?? [deps.workspaceRuntime],
      );
      const publicServers =
        publicValue &&
        typeof publicValue === 'object' &&
        !Array.isArray(publicValue)
          ? (publicValue as Record<string, unknown>)
          : {};
      res.status(200).json({
        name,
        scope,
        config: publicServers[name],
        activation,
      });
    },
  );

  app.delete(
    '/workspace/config/mcp/servers/:name',
    mutate({ strict: true }),
    async (req, res) => {
      const name = req.params['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      const scope = req.query['scope'];
      if (scope !== 'user') {
        res.status(400).json({
          error: 'scope must be user',
          code: 'invalid_scope',
        });
        return;
      }
      const settingScope = SettingScope.User;
      let publicValue: unknown;
      try {
        await withMcpServerMutationLock(
          boundWorkspace,
          settingScope,
          async () => {
            const prepared = prepareMcpServersSettingWrite(
              boundWorkspace,
              settingScope,
              {},
              { operation: 'remove', name },
            );
            publicValue = prepared.publicValue;
            await persistSetting(
              boundWorkspace,
              settingScope,
              'mcpServers',
              prepared.persistedValue,
            );
          },
        );
      } catch {
        res.status(500).json({
          error: 'Failed to persist MCP server configuration',
          code: 'persist_error',
        });
        return;
      }
      broadcastSettingsChanged('mcpServers', publicValue, scope, undefined);
      const activation = scheduleMcpConfiguration(
        deps.workspaceRegistry?.listManaged() ?? [deps.workspaceRuntime],
      );
      res.status(200).json({ name, scope, activation });
    },
  );
}

export function registerWorkspaceQualifiedMcpConfigRoutes(
  app: Application,
  deps: WorkspaceQualifiedMcpConfigRouteDeps,
): void {
  registerMcpEnablementRoutes(
    app,
    '/workspaces/:workspace',
    deps.mutate,
    (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return null;
      return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
    },
    [SettingScope.Workspace],
    (runtime, changes) => {
      deps.invalidateServeFeaturesCache();
      for (const change of changes) {
        runtime.bridge.publishWorkspaceEvent({
          type: 'settings_changed',
          data: {
            key: 'mcp.excluded',
            value: change.value,
            scope: change.scope === SettingScope.User ? 'user' : 'workspace',
          },
        });
      }
    },
    (runtime) => [runtime],
    deps.sendBridgeError,
  );

  app.get('/workspaces/:workspace/config/mcp/servers', (req, res) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    try {
      res.status(200).json(buildMcpConfigStatus(runtime.workspaceCwd));
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspaces/:workspace/config/mcp/servers error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load MCP server configuration',
        code: 'internal_error',
      });
    }
  });

  app.put(
    '/workspaces/:workspace/config/mcp/servers/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const name = req.params['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      const body = deps.safeBody(req);
      if (body['scope'] !== 'workspace') {
        res.status(400).json({
          error: 'scope must be workspace',
          code: 'invalid_scope',
        });
        return;
      }
      const config = body['config'];
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        res.status(400).json({
          error: 'config is required and must be an object',
          code: 'invalid_mcp_server_config',
        });
        return;
      }
      const definition = getSettingDefinition('mcpServers');
      if (!definition) return;
      let publicValue: unknown;
      try {
        await getWorkspaceRuntimeCoordinator(runtime).runManagementOperation(
          async () =>
            await withMcpServerMutationLock(
              runtime.workspaceCwd,
              SettingScope.Workspace,
              async () => {
                const prepared = prepareMcpServersSettingWrite(
                  runtime.workspaceCwd,
                  SettingScope.Workspace,
                  config,
                  { operation: 'set', name },
                );
                const validationError = validateSettingValue(
                  definition,
                  prepared.persistedValue,
                );
                if (validationError) {
                  const error = new Error(validationError) as Error & {
                    code?: string;
                  };
                  error.code = 'invalid_mcp_server_config';
                  throw error;
                }
                publicValue = prepared.publicValue;
                await deps.persistSetting(
                  runtime.workspaceCwd,
                  SettingScope.Workspace,
                  'mcpServers',
                  prepared.persistedValue,
                );
              },
            ),
        );
      } catch (err) {
        if (
          err instanceof Error &&
          (err as Error & { code?: string }).code ===
            'invalid_mcp_server_config'
        ) {
          res.status(400).json({
            error: err.message,
            code: 'invalid_mcp_server_config',
          });
          return;
        }
        if (
          sendDrainingError(
            res,
            err,
            'PUT /workspaces/:workspace/config/mcp/servers/:name',
            deps.sendBridgeError,
          )
        ) {
          return;
        }
        res.status(500).json({
          error: 'Failed to persist MCP server configuration',
          code: 'persist_error',
        });
        return;
      }
      deps.invalidateServeFeaturesCache();
      runtime.bridge.publishWorkspaceEvent({
        type: 'settings_changed',
        data: { key: 'mcpServers', value: publicValue, scope: 'workspace' },
      });
      const publicServers =
        publicValue &&
        typeof publicValue === 'object' &&
        !Array.isArray(publicValue)
          ? (publicValue as Record<string, unknown>)
          : {};
      const activation = scheduleMcpConfiguration([runtime]);
      res.status(200).json({
        name,
        scope: 'workspace',
        config: publicServers[name],
        activation,
      });
    },
  );

  app.delete(
    '/workspaces/:workspace/config/mcp/servers/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const name = req.params['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      if (req.query['scope'] !== 'workspace') {
        res.status(400).json({
          error: 'scope must be workspace',
          code: 'invalid_scope',
        });
        return;
      }
      let publicValue: unknown;
      try {
        await getWorkspaceRuntimeCoordinator(runtime).runManagementOperation(
          async () =>
            await withMcpServerMutationLock(
              runtime.workspaceCwd,
              SettingScope.Workspace,
              async () => {
                const prepared = prepareMcpServersSettingWrite(
                  runtime.workspaceCwd,
                  SettingScope.Workspace,
                  {},
                  { operation: 'remove', name },
                );
                publicValue = prepared.publicValue;
                await deps.persistSetting(
                  runtime.workspaceCwd,
                  SettingScope.Workspace,
                  'mcpServers',
                  prepared.persistedValue,
                );
              },
            ),
        );
      } catch (error) {
        if (
          sendDrainingError(
            res,
            error,
            'DELETE /workspaces/:workspace/config/mcp/servers/:name',
            deps.sendBridgeError,
          )
        ) {
          return;
        }
        res.status(500).json({
          error: 'Failed to persist MCP server configuration',
          code: 'persist_error',
        });
        return;
      }
      deps.invalidateServeFeaturesCache();
      runtime.bridge.publishWorkspaceEvent({
        type: 'settings_changed',
        data: { key: 'mcpServers', value: publicValue, scope: 'workspace' },
      });
      const activation = scheduleMcpConfiguration([runtime]);
      res.status(200).json({
        name,
        scope: 'workspace',
        activation,
      });
    },
  );
}
