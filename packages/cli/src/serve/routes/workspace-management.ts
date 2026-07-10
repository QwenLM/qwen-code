/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Application, Request, Response } from 'express';
import { isWithinRoot } from '@qwen-code/qwen-code-core';
import { MAX_WORKSPACE_PATH_LENGTH } from '@qwen-code/acp-bridge/workspacePaths';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

// Upper bound on total registered workspaces (startup + dynamic). Each
// registration allocates a full runtime (bridge, channel factory, sub-session
// launcher), so an unbounded POST /workspaces would let an authenticated
// client exhaust memory / file descriptors. There is no DELETE yet, so this is
// the sole backpressure.
const MAX_REGISTERED_WORKSPACES = 25;

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

      // Canonicalize with the OS-native syscall, the same call startup
      // registration uses (canonicalizeWorkspace -> realpathSync.native). The
      // POSIX JS realpath() can differ on case-insensitive filesystems
      // (APFS/NTFS), which would let the same physical directory register under
      // two distinct canonical strings and defeat the duplicate check.
      let canonical: string;
      try {
        canonical = realpathSync.native(resolve(cwd));
      } catch {
        res.status(400).json({
          error: 'Path does not exist or is not accessible',
          code: 'invalid_path',
        });
        return;
      }

      try {
        const s = await stat(canonical);
        if (!s.isDirectory()) {
          res.status(400).json({
            error: 'Path is not a directory',
            code: 'invalid_path',
          });
          return;
        }
      } catch {
        res.status(400).json({
          error: 'Path does not exist or is not accessible',
          code: 'invalid_path',
        });
        return;
      }

      // The duplicate / in-flight / nesting checks and `inFlight.add` below run
      // synchronously (no `await` between them), so concurrent POSTs for the
      // same canonical cwd can't race past registration. Error messages stay
      // generic and never echo a resolved path (which could reveal symlink
      // targets or another workspace's location).
      if (
        workspaceRegistry.getByWorkspaceCwd(canonical) ||
        inFlight.has(canonical)
      ) {
        res.status(409).json({
          error: 'Workspace already registered',
          code: 'workspace_exists',
        });
        return;
      }

      // Nesting guard checks registered workspaces AND in-flight registrations,
      // so two concurrent POSTs for parent/child paths (e.g. /project and
      // /project/sub) can't both pass while neither is in the registry yet.
      const boundCwds = [
        ...workspaceRegistry.list().map((r) => r.workspaceCwd),
        ...inFlight,
      ];
      for (const existing of boundCwds) {
        if (
          existing !== canonical &&
          (isWithinRoot(canonical, existing) ||
            isWithinRoot(existing, canonical))
        ) {
          res.status(409).json({
            error: 'Workspace path nests with an existing workspace',
            code: 'workspace_nested',
          });
          return;
        }
      }

      if (
        workspaceRegistry.list().length + inFlight.size >=
        MAX_REGISTERED_WORKSPACES
      ) {
        res.status(409).json({
          error: 'Workspace registration limit reached',
          code: 'workspace_limit_reached',
        });
        return;
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
