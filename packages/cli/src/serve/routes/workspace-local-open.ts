/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  LocalPathOpenUnavailableError,
  openPathLocally,
  openTerminalLocally,
} from '../local-path-open.js';
import { safeBody } from '../server/request-helpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { resolveTrustedRuntime } from '../workspace-route-runtime.js';

type LocalOpenTarget = 'folder' | 'terminal';

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
      const target: LocalOpenTarget =
        safeBody(req)['target'] === 'terminal' ? 'terminal' : 'folder';
      try {
        // The opened path is always the resolved registered workspace cwd —
        // never client-supplied beyond the route param.
        if (target === 'terminal') {
          await openTerminal(runtime.workspaceCwd);
        } else {
          await openLocally(runtime.workspaceCwd);
        }
        res
          .status(200)
          .json({ kind: 'workspace-local-open', opened: true, target });
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
