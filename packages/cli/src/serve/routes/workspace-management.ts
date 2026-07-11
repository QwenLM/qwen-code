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
import { MAX_REGISTERED_WORKSPACES } from '../workspace-inputs.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  workspaceRegistrationId,
  type WorkspaceRegistrationStore,
} from '../workspace-registration-store.js';

// Upper bound on total registered workspaces (startup + dynamic). Each
// registration allocates a full runtime (bridge, channel factory, sub-session
// launcher), so an unbounded POST /workspaces would let an authenticated
// client exhaust memory / file descriptors. Forgetting persistence does not
// unload an active runtime, so this remains the runtime backpressure.
export interface WorkspaceManagementRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  createWorkspaceRuntime?: (cwd: string) => Promise<WorkspaceRuntime>;
  workspaceRegistrationStore?: WorkspaceRegistrationStore;
}

export function registerWorkspaceManagementRoutes(
  app: Application,
  deps: WorkspaceManagementRouteDeps,
): void {
  const {
    workspaceRegistry,
    mutate,
    safeBody,
    createWorkspaceRuntime,
    workspaceRegistrationStore,
  } = deps;
  // Canonical cwds with a registration in flight, so two concurrent POSTs for
  // the same directory can't both pass the duplicate check and both build
  // runtime infrastructure before one add() throws.
  const inFlight = new Set<string>();

  app.post(
    '/workspaces',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const body = safeBody(req);
      const cwd = body['cwd'];
      const persist = body['persist'] ?? false;
      if (typeof cwd !== 'string' || cwd.trim().length === 0) {
        res.status(400).json({
          error: '`cwd` must be a non-empty string',
          code: 'invalid_path',
        });
        return;
      }
      if (typeof persist !== 'boolean') {
        res.status(400).json({
          error: '`persist` must be a boolean',
          code: 'invalid_persist_flag',
        });
        return;
      }
      if (persist && !workspaceRegistrationStore) {
        res.status(501).json({
          error: 'Persistent workspace registration is not available',
          code: 'persistence_not_available',
        });
        return;
      }
      if (!createWorkspaceRuntime && !persist) {
        res.status(501).json({
          error: 'Dynamic workspace registration is not available',
          code: 'not_implemented',
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
      const existingRuntime = workspaceRegistry.getByWorkspaceCwd(canonical);
      if (existingRuntime && persist && !existingRuntime.primary) {
        try {
          await workspaceRegistrationStore!.add(canonical);
          res.status(200).json({
            id: existingRuntime.workspaceId,
            cwd: existingRuntime.workspaceCwd,
            primary: existingRuntime.primary,
            trusted: existingRuntime.trusted,
            persisted: true,
          });
        } catch (err) {
          writeStderrLine(
            `qwen serve: failed to persist existing workspace registration: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          res.status(500).json({
            error: 'Failed to persist workspace registration',
            code: 'workspace_persist_failed',
          });
        }
        return;
      }
      if (existingRuntime || inFlight.has(canonical)) {
        res.status(409).json({
          error: 'Workspace already registered',
          code: 'workspace_exists',
        });
        return;
      }
      if (!createWorkspaceRuntime) {
        res.status(501).json({
          error: 'Dynamic workspace registration is not available',
          code: 'not_implemented',
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
      let persistenceFailed = false;
      try {
        const runtime = await createWorkspaceRuntime(canonical);
        let persistedRecordAdded = false;
        try {
          if (persist) {
            try {
              persistedRecordAdded =
                await workspaceRegistrationStore!.add(canonical);
            } catch (err) {
              persistenceFailed = true;
              throw err;
            }
          }
          workspaceRegistry.add(runtime);
        } catch (err) {
          if (persistedRecordAdded) {
            try {
              await workspaceRegistrationStore!.removeById(
                workspaceRegistrationId(canonical),
              );
            } catch (rollbackErr) {
              writeStderrLine(
                `qwen serve: failed to roll back workspace persistence after runtime registration failure: ${
                  rollbackErr instanceof Error
                    ? rollbackErr.message
                    : String(rollbackErr)
                }`,
              );
            }
          }
          await runtime.bridge.shutdown().catch(() => undefined);
          throw err;
        }
        res.status(201).json({
          id: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          primary: runtime.primary,
          trusted: runtime.trusted,
          ...(persist ? { persisted: true } : {}),
        });
      } catch (err) {
        // Log the full error server-side but return a generic message so the
        // response can't leak internal filesystem paths / implementation detail.
        writeStderrLine(
          `qwen serve: POST /workspaces failed for ${canonical}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (persistenceFailed) {
          res.status(500).json({
            error: 'Failed to persist workspace registration',
            code: 'workspace_persist_failed',
          });
        } else {
          res.status(500).json({
            error: 'Failed to register workspace',
            code: 'runtime_creation_failed',
          });
        }
      } finally {
        inFlight.delete(canonical);
      }
    },
  );

  app.get('/workspace-registrations', async (_req, res) => {
    if (!workspaceRegistrationStore) {
      res.status(501).json({
        error: 'Persistent workspace registration is not available',
        code: 'persistence_not_available',
      });
      return;
    }
    try {
      const snapshot = await workspaceRegistrationStore.read();
      res.json({
        schemaVersion: snapshot.schemaVersion,
        primaryWorkspace: snapshot.primaryWorkspace,
        entries: snapshot.workspaces.map((cwd) => {
          const runtime = workspaceRegistry.getByWorkspaceCwd(cwd);
          return {
            id: workspaceRegistrationId(cwd),
            cwd,
            active: runtime !== undefined,
            persisted: true,
          };
        }),
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: failed to read workspace registrations: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to read workspace registrations',
        code: 'workspace_registration_store_unavailable',
      });
    }
  });

  app.delete(
    '/workspace-registrations/:id',
    mutate({ strict: true }),
    async (req, res) => {
      if (!workspaceRegistrationStore) {
        res.status(501).json({
          error: 'Persistent workspace registration is not available',
          code: 'persistence_not_available',
        });
        return;
      }
      try {
        const registrationId = String(req.params['id']);
        const active = workspaceRegistry
          .list()
          .some(
            (runtime) =>
              workspaceRegistrationId(runtime.workspaceCwd) === registrationId,
          );
        const removed =
          await workspaceRegistrationStore.removeById(registrationId);
        if (!removed) {
          res.status(404).json({
            error: 'Workspace registration not found',
            code: 'workspace_registration_not_found',
          });
          return;
        }
        res.json({
          removed: true,
          active,
          restartRequired: active,
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: failed to forget workspace registration: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to forget workspace registration',
          code: 'workspace_persist_failed',
        });
      }
    },
  );
}
