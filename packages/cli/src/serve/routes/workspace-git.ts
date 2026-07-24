/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGitWorkingTreeStatus } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { SendBridgeError } from '../server/error-response.js';
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
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspace/git', async (req, res) => {
    try {
      const wait = req.query['wait'] === '1';
      res.status(200).json(
        await deps.gitState.getStatus(deps.boundWorkspace, deps.bridge, {
          wait,
        }),
      );
    } catch (err) {
      deps.sendBridgeError(res, err, { route: 'GET /workspace/git' });
    }
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
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    gitState: WorkspaceGitState;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspaces/:workspace/git', async (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    const route = 'GET /workspaces/:workspace/git';
    // Optional ?cwd= override for worktree sessions whose working directory
    // differs from the workspace root. Canonicalize both paths with realpath
    // to prevent symlink escape, then validate containment.
    const rawCwd = req.query['cwd'];
    let gitCwd = runtime.workspaceCwd;
    if (typeof rawCwd === 'string' && rawCwd.length > 0) {
      try {
        const resolved = fs.realpathSync(path.resolve(rawCwd));
        const root = fs.realpathSync(runtime.workspaceCwd);
        const rel = path.relative(root, resolved);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          gitCwd = resolved;
        }
      } catch {
        // Path doesn't exist or can't be resolved — use workspace root.
      }
    }
    try {
      if (gitCwd !== runtime.workspaceCwd) {
        // Worktree cwd: call getGitWorkingTreeStatus directly to avoid
        // creating a watcher entry in WorkspaceGitState (which would leak
        // one fs watcher per worktree path, never disposed).
        const status = await getGitWorkingTreeStatus(gitCwd).catch(() => null);
        res.status(200).json(
          status
            ? {
                v: 2,
                workspaceCwd: gitCwd,
                branch: status.branch ?? null,
                detached: status.detached,
                staged: status.staged,
                unstaged: status.unstaged,
                untracked: status.untracked,
                conflicted: status.conflicted,
                hasUpstream: status.hasUpstream,
                ahead: status.ahead,
                behind: status.behind,
                stashCount: status.stashCount,
                ...(status.operation ? { operation: status.operation } : {}),
                computedAt: Date.now(),
              }
            : { v: 2, workspaceCwd: gitCwd, branch: null },
        );
      } else {
        const wait = req.query['wait'] === '1';
        res
          .status(200)
          .json(
            await deps.gitState.getStatus(gitCwd, runtime.bridge, { wait }),
          );
      }
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
