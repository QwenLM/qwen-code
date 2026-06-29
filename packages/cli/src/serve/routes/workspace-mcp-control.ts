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
  validateMcpRuntimeServerName,
} from '../server/request-helpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';

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

  app.post(
    '/workspace/mcp/:server/restart',
    mutate({ strict: true }),
    async (req, res) => {
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
        const ctx = buildWorkspaceCtx(
          'POST /workspace/mcp/:server/restart',
          clientId,
        );
        const result = await workspace.restartMcpServer(
          ctx,
          serverName,
          entryIndex !== undefined ? { entryIndex } : undefined,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/:server/restart',
        });
      }
    },
  );

  for (const [routeAction, bridgeAction] of [
    ['enable', 'enable'],
    ['disable', 'disable'],
    ['authenticate', 'authenticate'],
    ['clear-auth', 'clear-auth'],
  ] as const) {
    app.post(
      `/workspace/mcp/:server/${routeAction}`,
      mutate({ strict: true }),
      async (req, res) => {
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
          const result = await bridge.manageMcpServer(
            serverName,
            bridgeAction,
            clientId,
          );
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
        const result = await bridge.addRuntimeMcpServer(
          name,
          config as Record<string, unknown>,
          clientId,
        );
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
        const result = await bridge.removeRuntimeMcpServer(name, clientId);
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/mcp/servers/:name',
        });
      }
    },
  );
}
