/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  validateMcpRuntimeServerName,
} from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  getWorkspaceRuntimeCoordinator,
  normalizeWorkspaceRuntimeTimeout,
} from '../workspace-runtime-coordinator.js';

interface RegisterWorkspaceRuntimeRoutesDeps {
  workspaceRuntime: WorkspaceRuntime;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
}

type ResolveRuntime = (req: Request, res: Response) => WorkspaceRuntime | null;

function validateServerName(req: Request, res: Response): string | undefined {
  const serverName = req.params['server'];
  return validateMcpRuntimeServerName(serverName, res) ? serverName : undefined;
}

function registerFor(
  app: Application,
  base: string,
  resolveRuntime: ResolveRuntime,
  deps: Pick<
    RegisterWorkspaceRuntimeRoutesDeps,
    'mutate' | 'safeBody' | 'sendBridgeError'
  >,
): void {
  const { mutate, safeBody, sendBridgeError } = deps;

  app.post(
    `${base}/runtime/ensure`,
    mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveRuntime(req, res);
      if (!runtime) return;
      const route = `POST ${base}/runtime/ensure`;
      if (Object.keys(safeBody(req)).length > 0) {
        res.status(400).json({
          error: 'Workspace runtime ensure does not accept parameters',
          code: 'workspace_runtime_ensure_takes_no_parameters',
        });
        return;
      }
      try {
        res
          .status(200)
          .json(await getWorkspaceRuntimeCoordinator(runtime).ensure());
      } catch (error) {
        sendBridgeError(res, error, { route });
      }
    },
  );

  app.get(`${base}/runtime/status`, (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    res.status(200).json(getWorkspaceRuntimeCoordinator(runtime).status());
  });

  app.get(`${base}/runtime/extensions`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const route = `GET ${base}/runtime/extensions`;
    try {
      res.status(200).json(await runtime.bridge.getWorkspaceExtensionsStatus());
    } catch (error) {
      sendBridgeError(res, error, { route });
    }
  });

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
      sendBridgeError(res, error, { route });
    }
  });

  app.get(`${base}/runtime/mcp/:server/tools`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const serverName = validateServerName(req, res);
    if (!serverName) return;
    const route = `GET ${base}/runtime/mcp/:server/tools`;
    try {
      res
        .status(200)
        .json(await runtime.bridge.getWorkspaceMcpToolsStatus(serverName));
    } catch (error) {
      sendBridgeError(res, error, { route });
    }
  });

  app.get(`${base}/runtime/mcp/:server/resources`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const serverName = validateServerName(req, res);
    if (!serverName) return;
    const route = `GET ${base}/runtime/mcp/:server/resources`;
    try {
      res
        .status(200)
        .json(await runtime.bridge.getWorkspaceMcpResourcesStatus(serverName));
    } catch (error) {
      sendBridgeError(res, error, { route });
    }
  });

  app.post(
    `${base}/runtime/mcp/reload`,
    mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveRuntime(req, res);
      if (!runtime) return;
      const route = `POST ${base}/runtime/mcp/reload`;
      const body = safeBody(req);
      const timeoutMs = normalizeWorkspaceRuntimeTimeout(body['timeoutMs']);
      if (timeoutMs === undefined) {
        res.status(400).json({
          error: '`timeoutMs` must be an integer between 1 and 120000',
          code: 'invalid_timeout',
        });
        return;
      }
      try {
        const coordinator = getWorkspaceRuntimeCoordinator(runtime);
        coordinator.reconcileMcpConfiguration();
        res.status(200).json(await coordinator.prepare(['mcp'], timeoutMs));
      } catch (error) {
        sendBridgeError(res, error, { route });
      }
    },
  );

  app.post(
    `${base}/runtime/mcp/:server/restart`,
    mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveRuntime(req, res);
      if (!runtime) return;
      const serverName = validateServerName(req, res);
      if (!serverName) return;
      const route = `POST ${base}/runtime/mcp/:server/restart`;
      try {
        res
          .status(200)
          .json(
            await getWorkspaceRuntimeCoordinator(runtime).runMcpRuntimeMutation(
              async () =>
                await runtime.workspaceService.restartMcpServer(
                  createBuildWorkspaceCtx(runtime.workspaceCwd)(route),
                  serverName,
                ),
            ),
          );
      } catch (error) {
        sendBridgeError(res, error, { route });
      }
    },
  );

  for (const action of ['approve', 'authenticate', 'clear-auth'] as const) {
    app.post(
      `${base}/runtime/mcp/:server/${action}`,
      mutate({ strict: true }),
      async (req, res) => {
        const runtime = resolveRuntime(req, res);
        if (!runtime) return;
        const serverName = validateServerName(req, res);
        if (!serverName) return;
        const route = `POST ${base}/runtime/mcp/:server/${action}`;
        try {
          const coordinator = getWorkspaceRuntimeCoordinator(runtime);
          res
            .status(200)
            .json(
              await coordinator.runMcpOperation(
                serverName,
                action,
                (operationId, deadlineAt) =>
                  deadlineAt === undefined
                    ? runtime.bridge.manageMcpServer(
                        serverName,
                        action,
                        undefined,
                        operationId,
                      )
                    : runtime.bridge.manageMcpServer(
                        serverName,
                        action,
                        undefined,
                        operationId,
                        deadlineAt,
                      ),
              ),
            );
        } catch (error) {
          sendBridgeError(res, error, { route });
        }
      },
    );
  }

  app.get(`${base}/runtime/operations/:operationId`, (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const operationId = req.params['operationId'];
    const operation = operationId
      ? getWorkspaceRuntimeCoordinator(runtime).operationStatus(operationId)
      : undefined;
    if (!operation) {
      res.status(404).json({
        error: `Workspace runtime operation "${operationId ?? ''}" not found`,
        code: 'workspace_runtime_operation_not_found',
      });
      return;
    }
    res.status(200).json(operation);
  });

  app.get(`${base}/runtime/operations`, (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    res.status(200).json({
      v: STATUS_SCHEMA_VERSION,
      operations: getWorkspaceRuntimeCoordinator(runtime).activeOperations(),
    });
  });

  app.get(`${base}/runtime/skills`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const route = `GET ${base}/runtime/skills`;
    try {
      res
        .status(200)
        .json(
          await runtime.workspaceService.getWorkspaceSkillsStatus(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(route),
          ),
        );
    } catch (error) {
      sendBridgeError(res, error, { route });
    }
  });

  app.get(`${base}/runtime/tools`, async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const route = `GET ${base}/runtime/tools`;
    try {
      res.status(200).json(await runtime.bridge.getWorkspaceToolsStatus());
    } catch (error) {
      sendBridgeError(res, error, { route });
    }
  });
}

export function registerWorkspaceRuntimeRoutes(
  app: Application,
  deps: RegisterWorkspaceRuntimeRoutesDeps,
): void {
  registerFor(
    app,
    '/workspace',
    (_req, res) =>
      requireTrustedWorkspaceRuntime(deps.workspaceRuntime, res)
        ? deps.workspaceRuntime
        : null,
    deps,
  );
}

export function registerWorkspaceQualifiedRuntimeRoutes(
  app: Application,
  deps: Pick<
    RegisterWorkspaceRuntimeRoutesDeps,
    'mutate' | 'safeBody' | 'sendBridgeError'
  > & { workspaceRegistry: WorkspaceRegistry },
): void {
  registerFor(
    app,
    '/workspaces/:workspace',
    (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return null;
      return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
    },
    deps,
  );
}
