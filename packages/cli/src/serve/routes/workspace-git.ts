/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { SendBridgeError } from '../server/error-response.js';
import type { WorkspaceGitState } from '../workspace-git-state.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';

export function registerWorkspaceGitRoutes(
  app: Application,
  deps: {
    boundWorkspace: string;
    bridge: AcpSessionBridge;
    gitState: WorkspaceGitState;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspace/git', async (_req, res) => {
    try {
      res
        .status(200)
        .json(await deps.gitState.getStatus(deps.boundWorkspace, deps.bridge));
    } catch (err) {
      deps.sendBridgeError(res, err, { route: 'GET /workspace/git' });
    }
  });
}

function resolveTrustedRuntime(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
): WorkspaceRuntime | null {
  const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
  if (!runtime) return null;
  return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
}

export function registerWorkspaceQualifiedGitRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    gitState: WorkspaceGitState;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspaces/:workspace/git', async (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    const route = 'GET /workspaces/:workspace/git';
    try {
      res
        .status(200)
        .json(
          await deps.gitState.getStatus(runtime.workspaceCwd, runtime.bridge),
        );
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
