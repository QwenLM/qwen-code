/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  MAX_SERVER_NAME_LENGTH,
} from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendWorkspaceRuntimeUnavailable,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinatorIfSupported } from '../workspace-runtime-coordinator.js';

interface WorkspaceRuntimeMcpRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
}

type ResolveRuntime = (req: Request, res: Response) => WorkspaceRuntime | null;

function validateRuntimeServerName(
  name: unknown,
  res: Response,
): name is string {
  if (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_SERVER_NAME_LENGTH &&
    name !== '__proto__' &&
    name !== 'constructor' &&
    name !== 'prototype'
  )
    return true;
  res.status(400).json({
    error:
      name === '__proto__' || name === 'constructor' || name === 'prototype'
        ? 'Server name must not be a reserved JS property name'
        : typeof name === 'string' && name.length > 0
          ? `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`
          : 'Server name is required and must be a non-empty string',
    code: 'invalid_server_name',
  });
  return false;
}

function requireRuntimeCoordinator(runtime: WorkspaceRuntime, res: Response) {
  const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
  if (coordinator) return coordinator;
  res.status(501).json({
    error: 'Workspace runtime lifecycle is not supported',
    code: 'workspace_runtime_not_supported',
  });
  return undefined;
}

function parseReloadOptions(body: Record<string, unknown>, res: Response) {
  const forceReconnectAll = body['forceReconnectAll'];
  const forceReconnectWhich = body['forceReconnectWhich'];
  if (
    forceReconnectAll !== undefined &&
    typeof forceReconnectAll !== 'boolean'
  ) {
    res.status(400).json({
      error: '`forceReconnectAll` must be a boolean',
      code: 'invalid_force_reconnect_all_flag',
    });
    return null;
  }
  if (
    forceReconnectWhich !== undefined &&
    (!Array.isArray(forceReconnectWhich) ||
      forceReconnectWhich.some(
        (name) => typeof name !== 'string' || name.length === 0,
      ))
  ) {
    res.status(400).json({
      error: '`forceReconnectWhich` must be an array of server names',
      code: 'invalid_force_reconnect_which',
    });
    return null;
  }
  if (forceReconnectAll === true && forceReconnectWhich !== undefined) {
    res.status(400).json({
      error: 'Reconnect options cannot be combined',
      code: 'conflicting_force_reconnect_options',
    });
    return null;
  }
  return {
    ...(forceReconnectAll === undefined ? {} : { forceReconnectAll }),
    ...(forceReconnectWhich === undefined
      ? {}
      : { forceReconnectWhich: forceReconnectWhich as string[] }),
  };
}

function parseEntryIndex(
  req: Request,
  res: Response,
): number | undefined | null {
  const raw = req.query['entryIndex'];
  if (raw === undefined || raw === '*') return undefined;
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isInteger(value) || value < 0 || String(value) !== raw) {
    res.status(400).json({
      error: '`entryIndex` must be a non-negative integer or "*"',
      code: 'invalid_entry_index',
    });
    return null;
  }
  return value;
}

function registerFor(
  app: Application,
  base: string,
  resolveRuntime: ResolveRuntime,
  deps: WorkspaceRuntimeMcpRoutesDeps,
): void {
  app.get(`${base}/runtime/mcp`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const route = `GET ${base}/runtime/mcp`;
    try {
      res
        .status(200)
        .json(
          await runtime.workspaceService.getWorkspaceMcpStatus(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(route),
          ),
        );
    } catch (error) {
      deps.sendBridgeError(res, error, { route });
    }
  });

  app.get(`${base}/runtime/mcp/:server/tools`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const serverName = req.params['server'];
    if (!validateRuntimeServerName(serverName, res)) return;
    const route = `GET ${base}/runtime/mcp/:server/tools`;
    try {
      res
        .status(200)
        .json(await runtime.bridge.getWorkspaceMcpToolsStatus(serverName));
    } catch (error) {
      deps.sendBridgeError(res, error, { route });
    }
  });

  app.get(`${base}/runtime/mcp/:server/resources`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const serverName = req.params['server'];
    if (!validateRuntimeServerName(serverName, res)) return;
    const route = `GET ${base}/runtime/mcp/:server/resources`;
    try {
      res
        .status(200)
        .json(await runtime.bridge.getWorkspaceMcpResourcesStatus(serverName));
    } catch (error) {
      deps.sendBridgeError(res, error, { route });
    }
  });

  app.post(
    `${base}/runtime/mcp/reload`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveRuntime(req, res);
      if (!runtime) return;
      const coordinator = requireRuntimeCoordinator(runtime, res);
      if (!coordinator) return;
      const options = parseReloadOptions(deps.safeBody(req), res);
      if (!options) return;
      const route = `POST ${base}/runtime/mcp/reload`;
      try {
        const result = await coordinator.runMcpRuntimeMutation(() =>
          runtime.bridge.reloadWorkspaceMcp(options),
        );
        runtime.generationGuard?.assertOpen();
        res.status(200).json(result);
      } catch (error) {
        deps.sendBridgeError(res, error, { route });
      }
    },
  );

  app.post(
    `${base}/runtime/mcp/:server/restart`,
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveRuntime(req, res);
      if (!runtime) return;
      const coordinator = requireRuntimeCoordinator(runtime, res);
      if (!coordinator) return;
      const serverName = req.params['server'];
      if (!validateRuntimeServerName(serverName, res)) return;
      const entryIndex = parseEntryIndex(req, res);
      if (entryIndex === null) return;
      const route = `POST ${base}/runtime/mcp/:server/restart`;
      try {
        const result = await coordinator.runMcpRuntimeMutation(() =>
          runtime.workspaceService.restartMcpServer(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(route),
            serverName,
            entryIndex === undefined ? undefined : { entryIndex },
          ),
        );
        runtime.generationGuard?.assertOpen();
        res.status(200).json(result);
      } catch (error) {
        deps.sendBridgeError(res, error, { route });
      }
    },
  );

  for (const action of ['approve', 'authenticate', 'clear-auth'] as const) {
    app.post(
      `${base}/runtime/mcp/:server/${action}`,
      deps.mutate({ strict: true }),
      async (req, res) => {
        const runtime = resolveRuntime(req, res);
        if (!runtime) return;
        const coordinator = requireRuntimeCoordinator(runtime, res);
        if (!coordinator) return;
        const serverName = req.params['server'];
        if (!validateRuntimeServerName(serverName, res)) return;
        const route = `POST ${base}/runtime/mcp/:server/${action}`;
        try {
          const result = await coordinator.runMcpRuntimeMutation(() =>
            runtime.bridge.manageMcpServer(serverName, action, undefined),
          );
          runtime.generationGuard?.assertOpen();
          res.status(200).json(result);
        } catch (error) {
          deps.sendBridgeError(res, error, { route });
        }
      },
    );
  }
}

export function registerWorkspaceRuntimeMcpRoutes(
  app: Application,
  deps: WorkspaceRuntimeMcpRoutesDeps,
): void {
  registerFor(
    app,
    '/workspace',
    (_req, res) => {
      const entry = deps.workspaceRegistry.primaryEntry;
      const runtime =
        entry.state === 'active' ? entry.current?.runtime : undefined;
      if (!runtime) {
        sendWorkspaceRuntimeUnavailable(res, entry);
        return null;
      }
      return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
    },
    deps,
  );
  registerFor(
    app,
    '/workspaces/:workspace',
    (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      return runtime && requireTrustedWorkspaceRuntime(runtime, res)
        ? runtime
        : null;
    },
    deps,
  );
}
