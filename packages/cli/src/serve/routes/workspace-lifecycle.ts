/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  parseAndValidateWorkspaceClientId,
} from '../server/request-helpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

interface RegisterWorkspaceLifecycleRoutesDeps {
  boundWorkspace: string;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  invalidateServeFeaturesCache: () => void;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

export function registerWorkspaceLifecycleRoutes(
  app: Application,
  deps: RegisterWorkspaceLifecycleRoutesDeps,
): void {
  const {
    boundWorkspace,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
    invalidateServeFeaturesCache,
    parseAndValidateClientId,
  } = deps;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);

  app.post('/workspace/init', mutate({ strict: true }), async (req, res) => {
    const body = safeBody(req);
    const force = body['force'];
    if (force !== undefined && typeof force !== 'boolean') {
      res.status(400).json({
        error: '`force` must be a boolean when provided',
        code: 'invalid_force_flag',
      });
      return;
    }
    const clientId = parseAndValidateClientId(req, res);
    if (clientId === null) return;
    try {
      const ctx = buildWorkspaceCtx('POST /workspace/init', clientId);
      const result = await workspace.initWorkspace(ctx, {
        force: force === true,
      });
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /workspace/init' });
    }
  });

  app.post('/workspace/reload', mutate({ strict: true }), async (req, res) => {
    const clientId = parseAndValidateClientId(req, res);
    if (clientId === null) return;
    try {
      const ctx = buildWorkspaceCtx('POST /workspace/reload', clientId);
      const result = await workspace.reload(ctx);
      invalidateServeFeaturesCache();
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /workspace/reload' });
    }
  });
}

export function registerWorkspaceQualifiedLifecycleRoutes(
  app: Application,
  deps: Pick<
    RegisterWorkspaceLifecycleRoutesDeps,
    'mutate' | 'safeBody' | 'sendBridgeError' | 'invalidateServeFeaturesCache'
  > & {
    workspaceRegistry: WorkspaceRegistry;
  },
): void {
  app.post(
    '/workspaces/:workspace/init',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const body = deps.safeBody(req);
      const force = body['force'];
      if (force !== undefined && typeof force !== 'boolean') {
        res.status(400).json({
          error: '`force` must be a boolean when provided',
          code: 'invalid_force_flag',
        });
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const route = 'POST /workspaces/:workspace/init';
      try {
        const ctx = createBuildWorkspaceCtx(runtime.workspaceCwd)(
          route,
          clientId,
        );
        const result = await runtime.workspaceService.initWorkspace(ctx, {
          force: force === true,
        });
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  app.post(
    '/workspaces/:workspace/reload',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const route = 'POST /workspaces/:workspace/reload';
      try {
        const ctx = createBuildWorkspaceCtx(runtime.workspaceCwd)(
          route,
          clientId,
        );
        const result = await runtime.workspaceService.reload(ctx);
        deps.invalidateServeFeaturesCache();
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );
}
