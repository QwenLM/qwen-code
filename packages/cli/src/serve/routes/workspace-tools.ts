/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  MAX_TOOL_NAME_LENGTH,
} from '../server/request-helpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';

interface RegisterWorkspaceToolsRoutesDeps {
  boundWorkspace: string;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

export function registerWorkspaceToolsRoutes(
  app: Application,
  deps: RegisterWorkspaceToolsRoutesDeps,
): void {
  const {
    boundWorkspace,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId,
  } = deps;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);

  app.post(
    '/workspace/tools/:name/enable',
    mutate({ strict: true }),
    async (req, res) => {
      const rawToolName = req.params['name'];
      if (!rawToolName || typeof rawToolName !== 'string') {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      const toolName = rawToolName.trim();
      if (toolName.length === 0) {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      if (toolName.length > MAX_TOOL_NAME_LENGTH) {
        res.status(400).json({
          error: `Tool name exceeds ${MAX_TOOL_NAME_LENGTH}-character limit`,
          code: 'invalid_tool_name',
        });
        return;
      }
      const body = safeBody(req);
      const enabled = body['enabled'];
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          error: '`enabled` is required and must be a boolean',
          code: 'invalid_enabled_flag',
        });
        return;
      }
      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;
      try {
        const ctx = buildWorkspaceCtx(
          'POST /workspace/tools/:name/enable',
          clientId,
        );
        const result = await workspace.setWorkspaceToolEnabled(
          ctx,
          toolName,
          enabled,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/tools/:name/enable',
        });
      }
    },
  );
}
