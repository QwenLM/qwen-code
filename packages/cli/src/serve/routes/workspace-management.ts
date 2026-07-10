/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Application, Request, Response } from 'express';
import { isWithinRoot } from '@qwen-code/qwen-code-core';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface WorkspaceManagementRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  createWorkspaceRuntime?: (cwd: string) => Promise<WorkspaceRuntime>;
}

export function registerWorkspaceManagementRoutes(
  app: Application,
  deps: WorkspaceManagementRouteDeps,
): void {
  const { workspaceRegistry, mutate, safeBody, createWorkspaceRuntime } = deps;

  app.post(
    '/workspaces',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      if (!createWorkspaceRuntime) {
        res.status(501).json({
          error: 'Dynamic workspace registration is not available',
          code: 'not_implemented',
        });
        return;
      }

      const body = safeBody(req);
      const cwd = body['cwd'];
      if (typeof cwd !== 'string' || cwd.trim().length === 0) {
        res.status(400).json({
          error: '`cwd` must be a non-empty string',
          code: 'invalid_path',
        });
        return;
      }

      const resolved = resolve(cwd);
      if (!isAbsolute(resolved)) {
        res.status(400).json({
          error: '`cwd` must be an absolute path',
          code: 'invalid_path',
        });
        return;
      }

      // Check path exists and is a directory.
      try {
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          res.status(400).json({
            error: `Path is not a directory: ${resolved}`,
            code: 'invalid_path',
          });
          return;
        }
      } catch {
        res.status(400).json({
          error: `Path does not exist: ${resolved}`,
          code: 'invalid_path',
        });
        return;
      }

      // Check for duplicate.
      if (workspaceRegistry.getByWorkspaceCwd(resolved)) {
        res.status(409).json({
          error: `Workspace already registered: ${resolved}`,
          code: 'workspace_exists',
        });
        return;
      }

      // Check for nesting against existing workspaces.
      for (const existing of workspaceRegistry.list()) {
        if (
          isWithinRoot(resolved, existing.workspaceCwd) ||
          isWithinRoot(existing.workspaceCwd, resolved)
        ) {
          res.status(409).json({
            error: `Workspace path is nested with existing workspace: ${existing.workspaceCwd}`,
            code: 'workspace_nested',
          });
          return;
        }
      }

      try {
        const runtime = await createWorkspaceRuntime(resolved);
        workspaceRegistry.add(runtime);
        res.status(201).json({
          id: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          primary: runtime.primary,
          trusted: runtime.trusted,
        });
      } catch (err) {
        res.status(500).json({
          error: `Failed to create workspace runtime: ${err instanceof Error ? err.message : String(err)}`,
          code: 'runtime_creation_failed',
        });
      }
    },
  );
}
