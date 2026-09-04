/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  MAX_SERVER_NAME_LENGTH,
  parseAndValidateWorkspaceClientId,
  validateMcpRuntimeServerName,
} from '../server/request-helpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

interface RegisterWorkspaceMcpControlRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
}

interface McpReloadOptions {
  forceReconnectAll?: boolean;
  forceReconnectWhich?: string[];
}

function parseMcpReloadOptions(
  body: Record<string, unknown>,
  res: Response,
): McpReloadOptions | null {
  const forceReconnectAll = body['forceReconnectAll'];
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
  const forceReconnectWhich = body['forceReconnectWhich'];
  if (
    forceReconnectWhich !== undefined &&
    (!Array.isArray(forceReconnectWhich) ||
      forceReconnectWhich.some(
        (serverName) =>
          typeof serverName !== 'string' || serverName.length === 0,
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
      error:
        '`forceReconnectAll` and `forceReconnectWhich` cannot be used together',
      code: 'conflicting_force_reconnect_options',
    });
    return null;
  }
  return {
    forceReconnectAll,
    forceReconnectWhich,
  };
}

export function registerWorkspaceMcpControlRoutes(
  app: Application,
  deps: RegisterWorkspaceMcpControlRoutesDeps,
): void {
  const {
    boundWorkspace,
    bridge,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId,
  } = deps;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);
  const requireTrusted = (res: Response): boolean => {
    if (deps.isWorkspaceTrusted?.() !== false) return true;
    res.status(403).json({
      error: 'Workspace is not trusted.',
      code: 'untrusted_workspace',
    });
    return false;
  };
  const captureTrustedGeneration = (res: Response): (() => void) | null => {
    const assertGenerationOpen =
      deps.captureGenerationAssertion?.() ?? (() => {});
    try {
      assertGenerationOpen();
    } catch {
      res.set('Retry-After', '1');
      res.status(503).json({
        error: 'Workspace runtime is not active.',
        code: 'workspace_runtime_unavailable',
      });
      return null;
    }
    if (!requireTrusted(res)) return null;
    return assertGenerationOpen;
  };

  app.post(
    '/workspace/mcp/initialize',
    mutate({ strict: true }),
    async (_req, res) => {
      const assertGenerationOpen = captureTrustedGeneration(res);
      if (!assertGenerationOpen) return;
      try {
        assertGenerationOpen();
        const result = await bridge.initializeWorkspaceMcp();
        assertGenerationOpen();
        res.status(202).json(result);
      } catch (err) {
        sendBridgeError(res, err, { route: 'POST /workspace/mcp/initialize' });
      }
    },
  );

  app.post(
    '/workspace/mcp/reload',
    mutate({ strict: true }),
    async (req, res) => {
      const assertGenerationOpen = captureTrustedGeneration(res);
      if (!assertGenerationOpen) return;
      const options = parseMcpReloadOptions(safeBody(req), res);
      if (!options) return;
      try {
        assertGenerationOpen();
        const result = await bridge.reloadWorkspaceMcp(options);
        assertGenerationOpen();
        res.status(202).json(result);
      } catch (err) {
        sendBridgeError(res, err, { route: 'POST /workspace/mcp/reload' });
      }
    },
  );

  app.post(
    '/workspace/mcp/:server/restart',
    mutate({ strict: true }),
    async (req, res) => {
      const assertGenerationOpen = captureTrustedGeneration(res);
      if (!assertGenerationOpen) return;
      const serverName = req.params['server'];
      if (!serverName || typeof serverName !== 'string') {
        res.status(400).json({
          error: 'Server name path parameter is required',
          code: 'invalid_server_name',
        });
        return;
      }
      if (serverName.length > MAX_SERVER_NAME_LENGTH) {
        res.status(400).json({
          error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
          code: 'invalid_server_name',
        });
        return;
      }
      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      let entryIndex: number | undefined;
      const rawEntryIndex = req.query['entryIndex'];
      if (rawEntryIndex !== undefined && rawEntryIndex !== '*') {
        const candidate =
          typeof rawEntryIndex === 'string' ? rawEntryIndex : undefined;
        const parsed =
          candidate !== undefined ? Number.parseInt(candidate, 10) : NaN;
        if (
          !Number.isInteger(parsed) ||
          parsed < 0 ||
          String(parsed) !== candidate
        ) {
          res.status(400).json({
            error:
              '`entryIndex` query parameter must be a non-negative integer or "*"',
            code: 'invalid_entry_index',
          });
          return;
        }
        entryIndex = parsed;
      }
      try {
        assertGenerationOpen();
        const ctx = buildWorkspaceCtx(
          'POST /workspace/mcp/:server/restart',
          clientId,
        );
        const result = await workspace.restartMcpServer(
          ctx,
          serverName,
          entryIndex !== undefined ? { entryIndex } : undefined,
        );
        assertGenerationOpen();
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/:server/restart',
        });
      }
    },
  );

  for (const [routeAction, bridgeAction] of [
    ['approve', 'approve'],
    ['enable', 'enable'],
    ['disable', 'disable'],
    ['authenticate', 'authenticate'],
    ['clear-auth', 'clear-auth'],
  ] as const) {
    app.post(
      `/workspace/mcp/:server/${routeAction}`,
      mutate({ strict: true }),
      async (req, res) => {
        const assertGenerationOpen = captureTrustedGeneration(res);
        if (!assertGenerationOpen) return;
        const serverName = req.params['server'];
        if (!serverName || typeof serverName !== 'string') {
          res.status(400).json({
            error: 'Server name path parameter is required',
            code: 'invalid_server_name',
          });
          return;
        }
        if (serverName.length > MAX_SERVER_NAME_LENGTH) {
          res.status(400).json({
            error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
            code: 'invalid_server_name',
          });
          return;
        }
        const clientId = parseAndValidateClientId(req, res);
        if (clientId === null) return;
        try {
          assertGenerationOpen();
          const result = await bridge.manageMcpServer(
            serverName,
            bridgeAction,
            clientId,
          );
          assertGenerationOpen();
          res.status(200).json(result);
        } catch (err) {
          sendBridgeError(res, err, {
            route: `POST /workspace/mcp/:server/${routeAction}`,
          });
        }
      },
    );
  }

  app.post(
    '/workspace/mcp/servers',
    mutate({ strict: true }),
    async (req, res) => {
      const assertGenerationOpen = captureTrustedGeneration(res);
      if (!assertGenerationOpen) return;
      const body = safeBody(req);
      const name = body['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      const config = body['config'];
      if (
        typeof config !== 'object' ||
        config === null ||
        Array.isArray(config)
      ) {
        res.status(400).json({
          error: '`config` must be a non-null object',
          code: 'missing_required_field',
          field: 'config',
        });
        return;
      }
      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      try {
        assertGenerationOpen();
        const result = await bridge.addRuntimeMcpServer(
          name,
          config as Record<string, unknown>,
          clientId,
        );
        assertGenerationOpen();
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/servers',
        });
      }
    },
  );

  app.delete(
    '/workspace/mcp/servers/:name',
    mutate({ strict: true }),
    async (req, res) => {
      const assertGenerationOpen = captureTrustedGeneration(res);
      if (!assertGenerationOpen) return;
      const name = req.params['name'] ?? '';
      if (!validateMcpRuntimeServerName(name, res)) return;
      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      try {
        assertGenerationOpen();
        const result = await bridge.removeRuntimeMcpServer(name, clientId);
        assertGenerationOpen();
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/mcp/servers/:name',
        });
      }
    },
  );
}

function resolveTrustedMcpRuntime(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
): WorkspaceRuntime | null {
  const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
  if (!runtime) return null;
  return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
}

export function registerWorkspaceQualifiedMcpControlRoutes(
  app: Application,
  deps: Pick<
    RegisterWorkspaceMcpControlRoutesDeps,
    'mutate' | 'safeBody' | 'sendBridgeError'
  > & {
    workspaceRegistry: WorkspaceRegistry;
  },
): void {
  app.post(
    '/workspaces/:workspace/mcp/initialize',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveTrustedMcpRuntime(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      const route = 'POST /workspaces/:workspace/mcp/initialize';
      try {
        runtime.generationGuard?.assertOpen();
        const result = await runtime.bridge.initializeWorkspaceMcp();
        runtime.generationGuard?.assertOpen();
        res.status(202).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  app.post(
    '/workspaces/:workspace/mcp/reload',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveTrustedMcpRuntime(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      const options = parseMcpReloadOptions(deps.safeBody(req), res);
      if (!options) return;
      const route = 'POST /workspaces/:workspace/mcp/reload';
      try {
        runtime.generationGuard?.assertOpen();
        const result = await runtime.bridge.reloadWorkspaceMcp(options);
        runtime.generationGuard?.assertOpen();
        res.status(202).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  app.post(
    '/workspaces/:workspace/mcp/:server/restart',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveTrustedMcpRuntime(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      const serverName = req.params['server'];
      if (!serverName || typeof serverName !== 'string') {
        res.status(400).json({
          error: 'Server name path parameter is required',
          code: 'invalid_server_name',
        });
        return;
      }
      if (serverName.length > MAX_SERVER_NAME_LENGTH) {
        res.status(400).json({
          error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
          code: 'invalid_server_name',
        });
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const rawEntryIndex = req.query['entryIndex'];
      let entryIndex: number | undefined;
      if (rawEntryIndex !== undefined && rawEntryIndex !== '*') {
        const candidate =
          typeof rawEntryIndex === 'string' ? rawEntryIndex : undefined;
        const parsed =
          candidate !== undefined ? Number.parseInt(candidate, 10) : NaN;
        if (
          !Number.isInteger(parsed) ||
          parsed < 0 ||
          String(parsed) !== candidate
        ) {
          res.status(400).json({
            error:
              '`entryIndex` query parameter must be a non-negative integer or "*"',
            code: 'invalid_entry_index',
          });
          return;
        }
        entryIndex = parsed;
      }
      const route = 'POST /workspaces/:workspace/mcp/:server/restart';
      try {
        runtime.generationGuard?.assertOpen();
        const ctx = createBuildWorkspaceCtx(runtime.workspaceCwd)(
          route,
          clientId,
        );
        const result = await runtime.workspaceService.restartMcpServer(
          ctx,
          serverName,
          entryIndex !== undefined ? { entryIndex } : undefined,
        );
        runtime.generationGuard?.assertOpen();
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  for (const [routeAction, bridgeAction] of [
    ['approve', 'approve'],
    ['enable', 'enable'],
    ['disable', 'disable'],
    ['authenticate', 'authenticate'],
    ['clear-auth', 'clear-auth'],
  ] as const) {
    app.post(
      `/workspaces/:workspace/mcp/:server/${routeAction}`,
      deps.mutate({ strict: true }),
      async (req, res) => {
        const runtime = resolveTrustedMcpRuntime(
          deps.workspaceRegistry,
          req,
          res,
        );
        if (!runtime) return;
        const serverName = req.params['server'];
        if (!serverName || typeof serverName !== 'string') {
          res.status(400).json({
            error: 'Server name path parameter is required',
            code: 'invalid_server_name',
          });
          return;
        }
        if (serverName.length > MAX_SERVER_NAME_LENGTH) {
          res.status(400).json({
            error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
            code: 'invalid_server_name',
          });
          return;
        }
        const clientId = parseAndValidateWorkspaceClientId(
          req,
          res,
          runtime.bridge,
        );
        if (clientId === null) return;
        const route = `POST /workspaces/:workspace/mcp/:server/${routeAction}`;
        try {
          runtime.generationGuard?.assertOpen();
          const result = await runtime.bridge.manageMcpServer(
            serverName,
            bridgeAction,
            clientId,
          );
          runtime.generationGuard?.assertOpen();
          res.status(200).json(result);
        } catch (err) {
          deps.sendBridgeError(res, err, { route });
        }
      },
    );
  }

  app.post(
    '/workspaces/:workspace/mcp/servers',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveTrustedMcpRuntime(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      const body = deps.safeBody(req);
      const name = body['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      const config = body['config'];
      if (
        typeof config !== 'object' ||
        config === null ||
        Array.isArray(config)
      ) {
        res.status(400).json({
          error: '`config` must be a non-null object',
          code: 'missing_required_field',
          field: 'config',
        });
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      const route = 'POST /workspaces/:workspace/mcp/servers';
      try {
        runtime.generationGuard?.assertOpen();
        const result = await runtime.bridge.addRuntimeMcpServer(
          name,
          config as Record<string, unknown>,
          clientId,
        );
        runtime.generationGuard?.assertOpen();
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  app.delete(
    '/workspaces/:workspace/mcp/servers/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveTrustedMcpRuntime(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      const name = req.params['name'] ?? '';
      if (!validateMcpRuntimeServerName(name, res)) return;
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      const route = 'DELETE /workspaces/:workspace/mcp/servers/:name';
      try {
        runtime.generationGuard?.assertOpen();
        const result = await runtime.bridge.removeRuntimeMcpServer(
          name,
          clientId,
        );
        runtime.generationGuard?.assertOpen();
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );
}
