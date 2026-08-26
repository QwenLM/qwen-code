/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { getGitWorkingTreeStatus } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { SendBridgeError } from '../server/error-response.js';
import type { WorkspaceGitState } from '../workspace-git-state.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { parseCallerSuppliedSessionId } from '../../config/session-id.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  isBranchWorktreeCreationSupported,
  resolveBranchWorktreeBaseCheckout,
} from '../branch-worktree-preparation.js';
import {
  resolveSessionManagedGitCwd,
  resolveTrustedRuntime,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';

export function registerWorkspaceGitRoutes(
  app: Application,
  deps: {
    boundWorkspace: string;
    bridge: AcpSessionBridge;
    gitState: WorkspaceGitState;
    sendBridgeError: SendBridgeError;
    isWorkspaceTrusted?: () => boolean;
    captureGenerationAssertion?: () => (() => void) | undefined;
  },
): void {
  app.get('/workspace/git', async (req, res) => {
    const assertGenerationOpen = deps.captureGenerationAssertion?.();
    try {
      assertGenerationOpen?.();
    } catch (err) {
      deps.sendBridgeError(res, err, { route: 'GET /workspace/git' });
      return;
    }
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    try {
      const wait = req.query['wait'] === '1';
      const status = await deps.gitState.getStatus(
        deps.boundWorkspace,
        deps.bridge,
        {
          wait,
        },
      );
      assertGenerationOpen?.();
      res.status(200).json(status);
    } catch (err) {
      deps.sendBridgeError(res, err, { route: 'GET /workspace/git' });
    }
  });
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
    try {
      runtime.generationGuard?.assertOpen();
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
      return;
    }
    const gitCwd = resolveSessionManagedGitCwd(req, runtime);
    if (gitCwd === null) {
      res.status(400).json({
        error: 'invalid_cwd',
        message: 'The supplied cwd is not owned by this session',
      });
      return;
    }
    let worktreeSupported: boolean | undefined;
    const parsedSessionId = parseCallerSuppliedSessionId(
      req.query['sessionId'],
    );
    if (parsedSessionId.kind === 'valid') {
      const sessionId = parsedSessionId.sessionId;
      try {
        const base = await resolveBranchWorktreeBaseCheckout({
          workspaceCwd: runtime.workspaceCwd,
          sessionId,
          snapshot: runtime.bridge.getSessionExecutionSnapshot(sessionId),
          sidecarPath:
            createWorkspaceRuntimeSessionService(
              runtime,
            ).getWorktreeSessionPath(sessionId),
        });
        worktreeSupported =
          base !== null && (await isBranchWorktreeCreationSupported(base));
      } catch {
        worktreeSupported = false;
      }
    }
    try {
      if (gitCwd !== runtime.workspaceCwd) {
        // Worktree cwd: call getGitWorkingTreeStatus directly to avoid
        // creating a watcher entry in WorkspaceGitState (which would leak
        // one fs watcher per worktree path, never disposed).
        const status = await getGitWorkingTreeStatus(gitCwd).catch(() => null);
        runtime.generationGuard?.assertOpen();
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
                ...(worktreeSupported !== undefined
                  ? { worktreeSupported }
                  : {}),
              }
            : {
                v: 2,
                workspaceCwd: gitCwd,
                branch: null,
                ...(worktreeSupported !== undefined
                  ? { worktreeSupported }
                  : {}),
              },
        );
      } else {
        const wait = req.query['wait'] === '1';
        const status = await deps.gitState.getStatus(gitCwd, runtime.bridge, {
          wait,
        });
        runtime.generationGuard?.assertOpen();
        res.status(200).json({
          ...status,
          ...(worktreeSupported !== undefined ? { worktreeSupported } : {}),
        });
      }
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
