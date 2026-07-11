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

function isUncPath(value: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function normalizePortableAbsolutePath(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return path.win32.normalize(value).toLowerCase();
  }
  return path.resolve(value);
}

export function resolveRegisteredWorkspaceRuntimeByPathSelector(
  registry: WorkspaceRegistry,
  selector: string,
): WorkspaceRuntime | undefined {
  const exact = registry.getByWorkspaceCwd(selector);
  if (exact) return exact;

  if (path.isAbsolute(selector) && !isUncPath(selector)) {
    try {
      const canonicalSelector = canonicalizeWorkspace(selector);
      const canonicalMatch = registry.getByWorkspaceCwd(canonicalSelector);
      if (canonicalMatch) return canonicalMatch;
      for (const runtime of registry.list()) {
        if (canonicalizeWorkspace(runtime.workspaceCwd) === canonicalSelector) {
          return runtime;
        }
      }
    } catch {
      // Fall through to lexical matching; unresolved selectors still return
      // workspace_mismatch without probing UNC/network paths.
    }
  }

  const normalizedSelector = normalizePortableAbsolutePath(selector);
  return registry
    .list()
    .find(
      (runtime) =>
        normalizePortableAbsolutePath(runtime.workspaceCwd) ===
        normalizedSelector,
    );
}

export function resolveManagedWorkspaceRuntimeByPathSelector(
  registry: WorkspaceRegistry,
  selector: string,
): WorkspaceRuntime | undefined {
  const exact = registry.getManagedByWorkspaceCwd(selector);
  if (exact) return exact;

  if (path.isAbsolute(selector) && !isUncPath(selector)) {
    try {
      const canonicalSelector = canonicalizeWorkspace(selector);
      const canonicalMatch =
        registry.getManagedByWorkspaceCwd(canonicalSelector);
      if (canonicalMatch) return canonicalMatch;
      for (const runtime of registry.listManaged()) {
        if (canonicalizeWorkspace(runtime.workspaceCwd) === canonicalSelector) {
          return runtime;
        }
      }
    } catch {
      // Fall through to lexical matching for unavailable paths.
    }
  }

  const normalizedSelector = normalizePortableAbsolutePath(selector);
  return registry
    .listManaged()
    .find(
      (runtime) =>
        normalizePortableAbsolutePath(runtime.workspaceCwd) ===
        normalizedSelector,
    );
}

export function resolveWorkspaceRuntimeFromParam(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
  paramName = 'workspace',
): WorkspaceRuntime | null {
  const selector = req.params[paramName] ?? '';
  const byId = registry.getByWorkspaceId(selector);
  if (byId) return byId;

  if (!isPortableAbsolutePath(selector)) {
    res.status(400).json({
      error: `\`:${paramName}\` must decode to a workspace id or absolute path`,
      code: 'workspace_mismatch',
    });
    return null;
  }

  const runtime = resolveRegisteredWorkspaceRuntimeByPathSelector(
    registry,
    selector,
  );
  if (!runtime) {
    sendWorkspaceMismatch(res, registry);
    return null;
  }
  return runtime;
}

export function requireTrustedWorkspaceRuntime(
  runtime: WorkspaceRuntime,
  res: Response,
): boolean {
  if (runtime.trusted) return true;
  sendUntrustedWorkspaceResponse(res);
  return false;
}

export function sendUntrustedWorkspaceResponse(
  res: Response,
  extra?: { sessionId?: string; workspaceCwd?: string; workspaceId?: string },
): void {
  res.status(403).json({
    error: 'Workspace is not trusted.',
    code: 'untrusted_workspace',
    ...extra,
  });
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
): void {
  const runtimes = registry.list();
  res.status(400).json({
    error:
      'Workspace mismatch: the requested workspace is not registered with this daemon.',
    code: 'workspace_mismatch',
    workspaceCount: runtimes.length,
  });
}
