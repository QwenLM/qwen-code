/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Application, Request, Response } from 'express';
import { isWithinRoot } from '@qwen-code/qwen-code-core';
import { MAX_WORKSPACE_PATH_LENGTH } from '@qwen-code/acp-bridge/workspacePaths';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
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
  // Canonical cwds with a registration in flight, so two concurrent POSTs for
  // the same directory can't both pass the duplicate check and both build
  // runtime infrastructure before one add() throws.
  const inFlight = new Set<string>();

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

      if (!isAbsolute(cwd)) {
        res.status(400).json({
          error: '`cwd` must be an absolute path',
          code: 'invalid_path',
        });
        return;
      }

      // Bound the input before any filesystem work, matching the limit other
      // workspace routes enforce (memory-amplification guard).
      if (cwd.length > MAX_WORKSPACE_PATH_LENGTH) {
        res.status(400).json({
          error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
          code: 'invalid_path',
        });
        return;
      }

      // Canonicalize like startup registration does (run-qwen-serve uses
      // realpathSync.native): resolve symlinks so an alias such as
      // `/tmp/link -> /real/project` cannot slip past the string-based
      // duplicate / nesting checks and register one physical directory twice.
      let canonical: string;
      try {
        canonical = await realpath(resolve(cwd));
      } catch {
        res.status(400).json({
          error: `Path does not exist: ${cwd}`,
          code: 'invalid_path',
        });
        return;
      }

      try {
        const s = await stat(canonical);
        if (!s.isDirectory()) {
          res.status(400).json({
            error: `Path is not a directory: ${canonical}`,
            code: 'invalid_path',
          });
          return;
        }
      } catch {
        res.status(400).json({
          error: `Path does not exist: ${canonical}`,
          code: 'invalid_path',
        });
        return;
      }

      // The duplicate / in-flight / nesting checks and `inFlight.add` below run
      // synchronously (no `await` between them), so concurrent POSTs for the
      // same canonical cwd can't race past registration.
      if (
        workspaceRegistry.getByWorkspaceCwd(canonical) ||
        inFlight.has(canonical)
      ) {
        res.status(409).json({
          error: `Workspace already registered: ${canonical}`,
          code: 'workspace_exists',
        });
        return;
      }

      for (const existing of workspaceRegistry.list()) {
        if (
          isWithinRoot(canonical, existing.workspaceCwd) ||
          isWithinRoot(existing.workspaceCwd, canonical)
        ) {
          res.status(409).json({
            error: `Workspace path is nested with existing workspace: ${existing.workspaceCwd}`,
            code: 'workspace_nested',
          });
          return;
        }
      }

      inFlight.add(canonical);
      try {
        const runtime = await createWorkspaceRuntime(canonical);
        workspaceRegistry.add(runtime);
        res.status(201).json({
          id: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          primary: runtime.primary,
          trusted: runtime.trusted,
        });
      } catch (err) {
        // Log the full error server-side but return a generic message so the
        // response can't leak internal filesystem paths / implementation detail.
        writeStderrLine(
          `qwen serve: POST /workspaces failed for ${canonical}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to register workspace',
          code: 'runtime_creation_failed',
        });
      } finally {
        inFlight.delete(canonical);
      }
    },
  );
}
