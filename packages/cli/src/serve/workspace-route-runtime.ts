/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Request, Response } from 'express';
import { canonicalizeWorkspace } from './acp-session-bridge.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

export interface WorkspaceRouteContext {
  readonly runtime: WorkspaceRuntime;
  readonly routePrefix: string;
}

export function isPortableAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

export function resolveWorkspaceRuntimeFromParam(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
  paramName = 'workspace',
): WorkspaceRuntime | null {
  const rawSelector = req.params[paramName] ?? '';
  let selector: string;
  try {
    selector = decodeURIComponent(rawSelector);
  } catch {
    res.status(400).json({
      error: `\`:${paramName}\` must be valid URL encoding`,
      code: 'workspace_mismatch',
      requestedWorkspace: rawSelector,
    });
    return null;
  }
  const byId = registry.getByWorkspaceId(selector);
  if (byId) return byId;

  if (!isPortableAbsolutePath(selector)) {
    res.status(400).json({
      error: `\`:${paramName}\` must decode to a workspace id or absolute path`,
      code: 'workspace_mismatch',
      requestedWorkspace: selector,
    });
    return null;
  }

  let key: string;
  try {
    key = canonicalizeWorkspace(selector);
  } catch {
    sendWorkspaceMismatch(res, registry, selector);
    return null;
  }

  const runtime =
    registry.getByWorkspaceCwd(key) ??
    registry
      .list()
      .find(
        (candidate) => canonicalizeWorkspace(candidate.workspaceCwd) === key,
      );
  if (!runtime) {
    sendWorkspaceMismatch(res, registry, key);
    return null;
  }
  return runtime;
}

export function requireTrustedWorkspaceRuntime(
  runtime: WorkspaceRuntime,
  res: Response,
): boolean {
  if (runtime.trusted) return true;
  res.status(403).json({
    error: `Workspace "${runtime.workspaceCwd}" is not trusted.`,
    code: 'untrusted_workspace',
    workspaceCwd: runtime.workspaceCwd,
    workspaceId: runtime.workspaceId,
  });
  return false;
}

export function getWorkspaceRouteContext(
  req: Request,
): WorkspaceRouteContext | undefined {
  return (req as { workspaceRouteContext?: WorkspaceRouteContext })
    .workspaceRouteContext;
}

export function setWorkspaceRouteContext(
  req: Request,
  context: WorkspaceRouteContext,
): void {
  (
    req as { workspaceRouteContext?: WorkspaceRouteContext }
  ).workspaceRouteContext = context;
}

export function sendWorkspaceMismatch(
  res: Response,
  registry: WorkspaceRegistry,
  requestedWorkspace: string,
): void {
  const runtimes = registry.list();
  if (runtimes.length > 1) {
    res.status(400).json({
      error: `Workspace mismatch: daemon is bound to ${runtimes.length} workspaces; none matched the requested workspace.`,
      code: 'workspace_mismatch',
      boundWorkspace: registry.primary.workspaceCwd,
      workspaceCount: runtimes.length,
      requestedWorkspace,
    });
    return;
  }
  res.status(400).json({
    error: `Workspace mismatch: daemon is bound to "${registry.primary.workspaceCwd}"`,
    code: 'workspace_mismatch',
    boundWorkspace: registry.primary.workspaceCwd,
    requestedWorkspace,
  });
}
