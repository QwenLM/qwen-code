/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { SendBridgeError } from '../server/error-response.js';
import { createBuildWorkspaceCtx } from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';

interface RegisterWorkspaceRuntimeRoutesDeps {
  workspaceRuntime: WorkspaceRuntime;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
}

type ResolveRuntime = (req: Request, res: Response) => WorkspaceRuntime | null;

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
