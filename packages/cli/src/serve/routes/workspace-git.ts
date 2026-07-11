/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
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
  },
): void {
  app.get('/workspace/git', async (_req, res) => {
    res
      .status(200)
      .json(await deps.gitState.getStatus(deps.boundWorkspace, deps.bridge));
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
  deps: { workspaceRegistry: WorkspaceRegistry; gitState: WorkspaceGitState },
): void {
  app.get('/workspaces/:workspace/git', async (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    res
      .status(200)
      .json(
        await deps.gitState.getStatus(runtime.workspaceCwd, runtime.bridge),
      );
  });
}
