/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Application, Request, RequestHandler, Response } from 'express';
import {
  getAutoMemoryRoot,
  getProjectAutoMemoryRoots,
  getUserAutoMemoryRoot,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  LocalPathOpenUnavailableError,
  openPathLocally,
  openTerminalLocally,
} from '../local-path-open.js';
import { safeBody } from '../server/request-helpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { resolveTrustedRuntime } from '../workspace-route-runtime.js';
import {
  AutoMemoryEnvOverrideError,
  admitAutoMemoryProjectRoot,
  runWithAutoMemoryRuntime,
} from '../workspace-auto-memory.js';

type LocalOpenTarget = 'folder' | 'terminal' | 'auto-memory';
type AutoMemoryOpenScope = 'project' | 'user';

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * The directory the auto-memory open target opens. User scope: the shared
 * user root. Project scope: the project roots the listing walks
 * (`projectDirs`, same admission check) — `requestedDir` selects one of
 * them and must match exactly (null when it does not); without it the
 * first walked root is opened, falling back to the configured root so an
 * absent directory still answers 404.
 */
async function resolveAutoMemoryOpenTarget(
  workspaceCwd: string,
  scope: AutoMemoryOpenScope,
  trusted: boolean,
  requestedDir: unknown,
): Promise<string | null> {
  if (scope === 'user') return getUserAutoMemoryRoot();
  const admitted: string[] = [];
  for (const root of getProjectAutoMemoryRoots(workspaceCwd, trusted)) {
    if ((await admitAutoMemoryProjectRoot(root)).state === 'admitted') {
      admitted.push(root);
    }
  }
  if (typeof requestedDir === 'string' && requestedDir.length > 0) {
    return (
      admitted.find(
        (root) => path.resolve(root) === path.resolve(requestedDir),
      ) ?? null
    );
  }
  if (admitted.length > 0) return admitted[0];
  // Nothing walked: fall back to the configured root so the caller's stat
  // answers 404 (absent) or 500 (unstat'able) — but never open a root the
  // listing refused (a symlink would open its target).
  const configured = getAutoMemoryRoot(workspaceCwd);
  return (await admitAutoMemoryProjectRoot(configured)).state === 'refused'
    ? null
    : configured;
}

export function registerWorkspaceLocalOpenRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
    /** Test/embed override for the OS handoff; production uses the util. */
    openPathLocally?: (path: string) => Promise<void>;
    /** Test/embed override for the OS handoff; production uses the util. */
    openTerminalLocally?: (path: string) => Promise<void>;
  },
): void {
  const openLocally = deps.openPathLocally ?? openPathLocally;
  const openTerminal = deps.openTerminalLocally ?? openTerminalLocally;

  app.post(
    '/workspaces/:workspace/open',
    deps.mutate(),
    async (req: Request, res: Response) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      const body = safeBody(req);
      const target: LocalOpenTarget =
        body['target'] === 'terminal'
          ? 'terminal'
          : body['target'] === 'auto-memory'
            ? 'auto-memory'
            : 'folder';
      const autoMemoryScope: AutoMemoryOpenScope =
        body['autoMemoryScope'] === 'user' ? 'user' : 'project';
      const requestedDir = body['autoMemoryDir'];
      try {
        // The opened path is always resolved on the daemon — never
        // client-supplied beyond the route params and the body enums; an
        // `autoMemoryDir` only SELECTS one of the daemon-resolved roots.
        let targetPath = runtime.workspaceCwd;
        if (target === 'auto-memory') {
          // Resolve the roots on THIS runtime's memory axes (session
          // storage base dir + memory project scope) — what its sessions
          // write, not the daemon's ambient scope.
          let resolvedTarget: string | null;
          try {
            resolvedTarget = await runWithAutoMemoryRuntime(runtime, () =>
              resolveAutoMemoryOpenTarget(
                runtime.workspaceCwd,
                autoMemoryScope,
                runtime.trusted,
                requestedDir,
              ),
            );
          } catch (err) {
            if (!(err instanceof AutoMemoryEnvOverrideError)) throw err;
            res.status(409).json({
              error: err.message,
              code: err.code,
              key: err.key,
            });
            return;
          }
          if (resolvedTarget === null) {
            res.status(400).json({
              error:
                'Auto-memory directory is not one of the walked memory roots',
              code: 'auto_memory_dir_not_admitted',
              scope: autoMemoryScope,
            });
            return;
          }
          targetPath = resolvedTarget;
          let dirStat;
          try {
            dirStat = await fs.stat(targetPath);
          } catch (err) {
            const code = (err as { code?: unknown }).code;
            // ENOTDIR (a regular file occupies an ancestor component, e.g.
            // a checked-in `.qwen` file) and ELOOP (a symlink loop) mean the
            // root cannot exist at all — the same "does not exist yet"
            // state as ENOENT, not a daemon fault.
            if (isEnoent(err) || code === 'ENOTDIR' || code === 'ELOOP') {
              res.status(404).json({
                error: 'Auto-memory directory does not exist yet',
                code: 'auto_memory_dir_not_found',
                scope: autoMemoryScope,
              });
              return;
            }
            // An existing-but-unstat'able root (EACCES and friends) is a
            // daemon-side fault, not a client error; answer it directly
            // instead of shadowing the local-open failure codes below.
            // `errno` carries Node's string error CODE (e.g. 'EACCES'),
            // not libuv's numeric errno; 'UNKNOWN' when the error has none.
            res.status(500).json({
              error: 'Auto-memory directory is not accessible',
              code: 'auto_memory_dir_stat_failed',
              scope: autoMemoryScope,
              errno: typeof code === 'string' ? code : 'UNKNOWN',
            });
            return;
          }
          if (!dirStat.isDirectory()) {
            // A regular file where the memory root belongs is daemon-host
            // state the request cannot fix — a daemon-side fault, like
            // the unstat'able root above.
            res.status(500).json({
              error: 'Auto-memory path is not a directory',
              code: 'auto_memory_dir_not_directory',
              scope: autoMemoryScope,
              path: targetPath,
            });
            return;
          }
        }
        if (target === 'terminal') {
          await openTerminal(targetPath);
        } else {
          await openLocally(targetPath);
        }
        res.status(200).json({
          kind: 'workspace-local-open',
          opened: true,
          target,
          ...(target === 'auto-memory' ? { scope: autoMemoryScope } : {}),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof LocalPathOpenUnavailableError) {
          writeStderrLine(`qwen serve: local path open unavailable: ${detail}`);
          res.status(501).json({
            error: 'Local path open is unavailable',
            code: 'local_path_open_unavailable',
          });
          return;
        }
        writeStderrLine(`qwen serve: local path open failed: ${detail}`);
        res.status(500).json({
          error: 'Failed to open workspace locally',
          code: 'local_path_open_failed',
        });
      }
    },
  );
}
