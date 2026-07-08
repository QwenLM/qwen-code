/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  MAX_SERVER_NAME_LENGTH,
} from '../server/request-helpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';

const MAX_ACP_PREHEAT_TIMEOUT_MS = 60_000;

interface RegisterWorkspaceStatusRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  sendBridgeError: SendBridgeError;
}

export function registerWorkspaceStatusRoutes(
  app: Application,
  deps: RegisterWorkspaceStatusRoutesDeps,
): void {
  const { boundWorkspace, bridge, workspace, mutate, sendBridgeError } = deps;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);

  app.get('/workspace/mcp', async (_req, res) => {
    try {
      const ctx = buildWorkspaceCtx('GET /workspace/mcp');
      res.status(200).json(await workspace.getWorkspaceMcpStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/mcp' });
    }
  });

  app.get('/workspace/mcp/:server/tools', async (req, res) => {
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
    try {
      res.status(200).json(await bridge.getWorkspaceMcpToolsStatus(serverName));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/mcp/:server/tools' });
    }
  });

  app.get('/workspace/mcp/:server/resources', async (req, res) => {
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
    try {
      res
        .status(200)
        .json(await bridge.getWorkspaceMcpResourcesStatus(serverName));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /workspace/mcp/:server/resources',
      });
    }
  });

  app.get('/workspace/skills', async (_req, res) => {
    try {
      const ctx = buildWorkspaceCtx('GET /workspace/skills');
      res.status(200).json(await workspace.getWorkspaceSkillsStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/skills' });
    }
  });

  app.post(
    '/workspace/acp/preheat',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        const ctx = buildWorkspaceCtx('POST /workspace/acp/preheat');
        const timeoutMsRaw = req.query['timeoutMs'];
        const timeoutMs =
          typeof timeoutMsRaw === 'string' && timeoutMsRaw.trim()
            ? Number(timeoutMsRaw)
            : undefined;
        if (
          timeoutMs !== undefined &&
          (!Number.isFinite(timeoutMs) ||
            !Number.isInteger(timeoutMs) ||
            timeoutMs <= 0 ||
            timeoutMs > MAX_ACP_PREHEAT_TIMEOUT_MS)
        ) {
          res.status(400).json({
            error:
              '`timeoutMs` must be a positive integer no greater than 60000',
            code: 'invalid_timeout',
          });
          return;
        }
        res.status(200).json(
          await workspace.preheatAcpChild(ctx, {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          }),
        );
      } catch (err) {
        sendBridgeError(res, err, { route: 'POST /workspace/acp/preheat' });
      }
    },
  );

  app.get('/workspace/acp/status', async (_req, res) => {
    try {
      const ctx = buildWorkspaceCtx('GET /workspace/acp/status');
      res.status(200).json(await workspace.getWorkspaceAcpStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/acp/status' });
    }
  });

  app.get('/workspace/tools', async (_req, res) => {
    try {
      res.status(200).json(await bridge.getWorkspaceToolsStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/tools' });
    }
  });

  app.get('/workspace/providers', async (_req, res) => {
    try {
      const ctx = buildWorkspaceCtx('GET /workspace/providers');
      res.status(200).json(await workspace.getWorkspaceProvidersStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/providers' });
    }
  });
}

export function registerWorkspaceDiagnosticStatusRoutes(
  app: Application,
  deps: RegisterWorkspaceStatusRoutesDeps,
): void {
  const { boundWorkspace, workspace, sendBridgeError } = deps;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);
  // TODO(#4175 PR 24 — PermissionMediator audit log): emit an
  // `audit.diagnostic_read` event from these two routes so a security
  // operator can correlate "who read what when". Read-only diagnostic
  // surfaces are reconnaissance vectors (env: secret-var presence;
  // preflight: workspace path + CLI entry + Node version) and the absence
  // of audit emission here is a deliberate scope deferral, not an
  // oversight — the audit topic does not yet exist; PR 24 lands the
  // shared `bridge.emitAudit` infrastructure that this and PR 18's
  // `fs.access` events will both use.
  app.get('/workspace/env', async (_req, res) => {
    try {
      const ctx = buildWorkspaceCtx('GET /workspace/env');
      res.status(200).json(await workspace.getWorkspaceEnvStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/env' });
    }
  });

  app.get('/workspace/preflight', async (_req, res) => {
    try {
      const ctx = buildWorkspaceCtx('GET /workspace/preflight');
      res.status(200).json(await workspace.getWorkspacePreflightStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/preflight' });
    }
  });

  // GET /workspace/hooks — read-only hook configuration status.
  app.get('/workspace/hooks', async (_req, res) => {
    try {
      const ctx = buildWorkspaceCtx('GET /workspace/hooks');
      res.status(200).json(await workspace.getWorkspaceHooksStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/hooks' });
    }
  });
}
