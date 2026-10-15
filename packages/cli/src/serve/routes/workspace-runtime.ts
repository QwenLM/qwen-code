/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { SendBridgeError } from '../server/error-response.js';
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

interface RegisterWorkspaceRuntimeRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
}

type ResolveRuntime = (req: Request, res: Response) => WorkspaceRuntime | null;

function requireRuntimeCoordinator(runtime: WorkspaceRuntime, res: Response) {
  const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
  if (coordinator) return coordinator;
  res.status(501).json({
    error: 'Workspace runtime lifecycle is not supported',
    code: 'workspace_runtime_not_supported',
  });
  return null;
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

  app.post(`${base}/runtime/ensure`, mutate(), async (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const coordinator = requireRuntimeCoordinator(runtime, res);
    if (!coordinator) return;
    const route = `POST ${base}/runtime/ensure`;
    if (Object.keys(safeBody(req)).length > 0) {
      res.status(400).json({
        error: 'Workspace runtime ensure does not accept parameters',
        code: 'workspace_runtime_ensure_takes_no_parameters',
      });
      return;
    }
    try {
      res.status(200).json(await coordinator.ensure());
    } catch (error) {
      sendBridgeError(res, error, { route });
    }
  });

  app.get(`${base}/runtime/status`, (req, res) => {
    const runtime = resolveRuntime(req, res);
    if (!runtime) return;
    const coordinator = requireRuntimeCoordinator(runtime, res);
    if (!coordinator) return;
    res.status(200).json(coordinator.status());
  });
}

export function registerWorkspaceRuntimeRoutes(
  app: Application,
  deps: RegisterWorkspaceRuntimeRoutesDeps,
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
