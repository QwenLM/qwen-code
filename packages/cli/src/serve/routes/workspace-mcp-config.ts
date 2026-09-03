/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { matchesAnyServerPattern } from '@qwen-code/qwen-code-core/config/mcp-server-config.js';
import type { Application, Request, RequestHandler, Response } from 'express';
import { redactMcpServersSetting } from '../../config/mcp-server-secrets.js';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  getSettingDefinition,
  validateSettingValue,
} from '../../config/settingsUtils.js';
import type { SendBridgeError } from '../server/error-response.js';
import { validateMcpRuntimeServerName } from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceEntryFromParam,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';
import {
  prepareSettingWrite,
  withMcpServerMutationLock,
} from './workspace-settings.js';

interface McpConfigRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  persistSetting: (
    workspace: string,
    scope: SettingScope,
    key: string,
    value: unknown,
    assertGenerationOpen?: () => void,
  ) => Promise<void>;
  sendBridgeError: SendBridgeError;
  invalidateServeFeaturesCache: () => void;
  broadcastSettingsChanged: (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => void;
}

type McpConfigScope = 'user' | 'workspace';

interface McpConfigTarget {
  workspaceCwd: string;
  runtime?: WorkspaceRuntime;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (redactMcpServersSetting(value) as Record<string, unknown>)
    : {};
}

function buildMcpConfigStatus(workspaceCwd: string) {
  const settings = loadSettings(workspaceCwd, {
    skipLoadEnvironment: true,
  });
  const effective = asRecord(settings.merged.mcpServers);
  const user = asRecord(settings.user.settings.mcpServers);
  const workspace = asRecord(settings.workspace.settings.mcpServers);
  return {
    v: 1 as const,
    effective,
    user,
    workspace,
  };
}

function affectedRuntimes(
  registry: WorkspaceRegistry,
  target: McpConfigTarget,
  scope: McpConfigScope,
): readonly WorkspaceRuntime[] {
  return scope === 'user'
    ? registry.listManaged().filter((runtime) => runtime.trusted)
    : target.runtime
      ? [target.runtime]
      : [];
}

function scheduleMcpConfiguration(
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
      // Durable configuration is already committed.
    }
  }
  return reconciling ? 'reconciling' : 'deferred';
}

function runManagementOperation<T>(
  target: McpConfigTarget,
  operation: () => Promise<T>,
): Promise<T> {
  return target.runtime
    ? getWorkspaceRuntimeCoordinator(target.runtime).runManagementOperation(
        operation,
      )
    : operation();
}

function registerFor(
  app: Application,
  base: string,
  scope: McpConfigScope,
  resolveReadTarget: (req: Request, res: Response) => McpConfigTarget | null,
  resolveMutationTarget: (
    req: Request,
    res: Response,
  ) => McpConfigTarget | null,
  deps: McpConfigRoutesDeps,
): void {
  const settingScope =
    scope === 'user' ? SettingScope.User : SettingScope.Workspace;

  app.get(`${base}/config/mcp/servers`, (req, res) => {
    const target = resolveReadTarget(req, res);
    if (!target) return;
    try {
      res.status(200).json(buildMcpConfigStatus(target.workspaceCwd));
    } catch (error) {
      deps.sendBridgeError(res, error, {
        route: `GET ${base}/config/mcp/servers`,
      });
    }
  });

  app.put(
    `${base}/config/mcp/servers/:name`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const target = resolveMutationTarget(req, res);
      if (!target) return;
      const name = req.params['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      const body = deps.safeBody(req);
      if (body['scope'] !== scope) {
        res.status(400).json({
          error: `scope must be ${scope}`,
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
      try {
        const result = await runManagementOperation(target, async () => {
          let publicValue: unknown;
          await withMcpServerMutationLock(
            target.workspaceCwd,
            settingScope,
            async () => {
              const prepared = prepareSettingWrite(
                target.workspaceCwd,
                settingScope,
                'mcpServers',
                config,
                { operation: 'set', name },
              );
              const definition = getSettingDefinition('mcpServers');
              const validationError = definition
                ? validateSettingValue(definition, prepared.persistedValue)
                : undefined;
              if (validationError) {
                const error = new Error(validationError) as Error & {
                  code?: string;
                };
                error.code = 'invalid_mcp_server_config';
                throw error;
              }
              await deps.persistSetting(
                target.workspaceCwd,
                settingScope,
                'mcpServers',
                prepared.persistedValue,
                target.runtime?.generationGuard?.assertOpen,
              );
              publicValue = prepared.publicValue;
            },
          );
          const servers = asRecord(publicValue);
          return {
            config: servers[name],
            publicValue,
            activation: scheduleMcpConfiguration(
              affectedRuntimes(deps.workspaceRegistry, target, scope),
            ),
          };
        });
        publishConfiguration(
          target,
          scope,
          'mcpServers',
          result.publicValue,
          deps,
        );
        res.status(200).json({
          name,
          scope,
          config: result.config,
          activation: result.activation,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { code?: string }).code ===
            'invalid_mcp_server_config'
        ) {
          res.status(400).json({
            error: error.message,
            code: 'invalid_mcp_server_config',
          });
          return;
        }
        deps.sendBridgeError(res, error, {
          route: `PUT ${base}/config/mcp/servers/:name`,
        });
      }
    },
  );

  app.delete(
    `${base}/config/mcp/servers/:name`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const target = resolveMutationTarget(req, res);
      if (!target) return;
      const name = req.params['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      if (req.query['scope'] !== scope) {
        res.status(400).json({
          error: `scope must be ${scope}`,
          code: 'invalid_scope',
        });
        return;
      }
      try {
        const result = await runManagementOperation(target, async () => {
          let publicValue: unknown;
          await withMcpServerMutationLock(
            target.workspaceCwd,
            settingScope,
            async () => {
              const prepared = prepareSettingWrite(
                target.workspaceCwd,
                settingScope,
                'mcpServers',
                {},
                { operation: 'remove', name },
              );
              await deps.persistSetting(
                target.workspaceCwd,
                settingScope,
                'mcpServers',
                prepared.persistedValue,
                target.runtime?.generationGuard?.assertOpen,
              );
              publicValue = prepared.publicValue;
            },
          );
          return {
            publicValue,
            activation: scheduleMcpConfiguration(
              affectedRuntimes(deps.workspaceRegistry, target, scope),
            ),
          };
        });
        publishConfiguration(
          target,
          scope,
          'mcpServers',
          result.publicValue,
          deps,
        );
        res.status(200).json({ name, scope, activation: result.activation });
      } catch (error) {
        deps.sendBridgeError(res, error, {
          route: `DELETE ${base}/config/mcp/servers/:name`,
        });
      }
    },
  );

  for (const action of ['enable', 'disable'] as const) {
    app.post(
      `${base}/config/mcp/:server/${action}`,
      deps.mutate({ strict: true }),
      async (req, res) => {
        const target = resolveMutationTarget(req, res);
        if (!target) return;
        const serverName = req.params['server'];
        if (!validateMcpRuntimeServerName(serverName, res)) return;
        try {
          const result = await runManagementOperation(target, async () => {
            let changed = false;
            let next: string[] = [];
            let blocking: string[] = [];
            await withMcpServerMutationLock(
              target.workspaceCwd,
              settingScope,
              async () => {
                const settings = loadSettings(target.workspaceCwd, {
                  skipLoadEnvironment: true,
                });
                const existing =
                  settings.forScope(settingScope).settings.mcp?.excluded ?? [];
                if (action === 'enable') {
                  const blockingScopes = [
                    SettingScope.SystemDefaults,
                    SettingScope.System,
                    SettingScope.User,
                    ...(settingScope === SettingScope.Workspace
                      ? [SettingScope.Workspace]
                      : []),
                  ];
                  blocking = blockingScopes.flatMap((candidateScope) =>
                    (
                      settings.forScope(candidateScope).settings.mcp
                        ?.excluded ?? []
                    ).filter(
                      (pattern) =>
                        matchesAnyServerPattern(serverName, [pattern]) &&
                        (candidateScope !== settingScope ||
                          pattern !== serverName),
                    ),
                  );
                  if (blocking.length > 0) return;
                }
                next =
                  action === 'enable'
                    ? existing.filter((pattern) => pattern !== serverName)
                    : existing.includes(serverName)
                      ? existing
                      : [...existing, serverName];
                changed = next.length !== existing.length;
                if (changed) {
                  await deps.persistSetting(
                    target.workspaceCwd,
                    settingScope,
                    'mcp.excluded',
                    next,
                    target.runtime?.generationGuard?.assertOpen,
                  );
                }
              },
            );
            if (blocking.length > 0) {
              res.status(409).json({
                error: `MCP server is excluded by pattern: ${blocking.join(', ')}`,
                code: 'mcp_excluded_by_pattern',
                patterns: blocking,
              });
              return null;
            }
            return {
              changed,
              value: next,
              activation: changed
                ? scheduleMcpConfiguration(
                    affectedRuntimes(deps.workspaceRegistry, target, scope),
                  )
                : ('applied' as const),
            };
          });
          if (!result) return;
          if (result.changed) {
            publishConfiguration(
              target,
              scope,
              'mcp.excluded',
              result.value,
              deps,
            );
          }
          res.status(200).json({
            serverName,
            action,
            ok: true,
            changed: result.changed,
            activation: result.activation,
          });
        } catch (error) {
          deps.sendBridgeError(res, error, {
            route: `POST ${base}/config/mcp/:server/${action}`,
          });
        }
      },
    );
  }
}

function publishConfiguration(
  target: McpConfigTarget,
  scope: McpConfigScope,
  key: string,
  value: unknown,
  deps: McpConfigRoutesDeps,
): void {
  deps.invalidateServeFeaturesCache();
  if (scope === 'user') {
    try {
      deps.broadcastSettingsChanged(key, value, scope, undefined);
    } catch {
      // Durable configuration is already committed.
    }
    for (const candidate of deps.workspaceRegistry.listManaged()) {
      if (candidate.workspaceCwd === target.workspaceCwd) continue;
      try {
        candidate.bridge.publishWorkspaceEvent({
          type: 'settings_changed',
          data: { key, value, scope },
        });
      } catch {
        // Durable configuration is already committed.
      }
    }
    return;
  }
  try {
    target.runtime?.bridge.publishWorkspaceEvent({
      type: 'settings_changed',
      data: { key, value, scope },
    });
  } catch {
    // Durable configuration is already committed.
  }
}

export function registerWorkspaceMcpConfigRoutes(
  app: Application,
  deps: McpConfigRoutesDeps,
): void {
  registerFor(
    app,
    '/workspace',
    'user',
    () => ({ workspaceCwd: deps.workspaceRegistry.primaryEntry.workspaceCwd }),
    () => ({ workspaceCwd: deps.workspaceRegistry.primaryEntry.workspaceCwd }),
    deps,
  );
  registerFor(
    app,
    '/workspaces/:workspace',
    'workspace',
    (req, res) => {
      const entry = resolveWorkspaceEntryFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      return entry ? { workspaceCwd: entry.workspaceCwd } : null;
    },
    (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      return runtime && requireTrustedWorkspaceRuntime(runtime, res)
        ? { workspaceCwd: runtime.workspaceCwd, runtime }
        : null;
    },
    deps,
  );
}
