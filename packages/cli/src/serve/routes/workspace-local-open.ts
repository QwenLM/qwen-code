/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import type { Application, Request, RequestHandler, Response } from 'express';
import {
  getAutoMemoryRoot,
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

type LocalOpenTarget = 'folder' | 'terminal' | 'auto-memory';
type AutoMemoryOpenScope = 'project' | 'user';

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
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
      try {
        // The opened path is always resolved on the daemon — never
        // client-supplied beyond the route params.
        let targetPath = runtime.workspaceCwd;
        if (target === 'auto-memory') {
          targetPath =
            autoMemoryScope === 'user'
              ? getUserAutoMemoryRoot()
              : getAutoMemoryRoot(runtime.workspaceCwd);
          let dirStat;
          try {
            dirStat = await fs.stat(targetPath);
          } catch (err) {
            if (isEnoent(err)) {
              res.status(404).json({
                error: 'Auto-memory directory does not exist yet',
                code: 'auto_memory_dir_not_found',
                scope: autoMemoryScope,
              });
              return;
            }
            throw err;
          }
          if (!dirStat.isDirectory()) {
            res.status(400).json({
              error: 'Auto-memory path is not a directory',
              code: 'auto_memory_dir_not_directory',
              scope: autoMemoryScope,
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
