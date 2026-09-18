/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Application, RequestHandler, Response } from 'express';
import { GitWorktreeService } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { getGitWorkingTreeStatus } from '@qwen-code/qwen-code-core/utils/gitDiff.js';
import {
  listGitWorktrees,
  pruneGitWorktrees,
  removeGitWorktree,
  type GitWorktreeEntry,
} from '@qwen-code/qwen-code-core/utils/git-worktrees.js';
import type { SendBridgeError } from '../server/error-response.js';
import { safeBody } from '../server/request-helpers.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  resolveTrustedRuntime,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';
import { sendGitError } from './workspace-git-branches.js';

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function samePath(a: string, b: string): boolean {
  return realpathOrSelf(a) === realpathOrSelf(b);
}

function managedSlug(
  entry: GitWorktreeEntry,
  managedDir: string,
): string | undefined {
  const relative = path.relative(realpathOrSelf(managedDir), entry.path);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep)[0]
    : undefined;
}

function toWire(
  entry: GitWorktreeEntry,
  runtime: WorkspaceRuntime,
  managedDir: string,
): Record<string, unknown> {
  const slug = managedSlug(entry, managedDir);
  return {
    path: entry.path,
    head: entry.head,
    branch: entry.branch,
    detached: entry.detached,
    bare: entry.bare,
    ...(entry.locked !== undefined ? { locked: entry.locked } : {}),
    ...(entry.prunable !== undefined ? { prunable: entry.prunable } : {}),
    isMain: entry.isMain,
    isWorkspace: samePath(entry.path, runtime.workspaceCwd),
    ...(slug ? { slug } : {}),
  };
}

function sendError(
  res: Response,
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ error, code, ...extra });
}

async function findWorktree(
  runtime: WorkspaceRuntime,
  target: unknown,
): Promise<GitWorktreeEntry | null | undefined> {
  if (typeof target !== 'string' || !target) return undefined;
  const entries = await listGitWorktrees(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  return entries.find((entry) => entry.path === target) ?? null;
}

/**
 * Workspace-scoped: every route resolves inside the selected runtime and
 * lists, inspects, or removes worktrees of that workspace's repository only.
 */
export function registerWorkspaceQualifiedGitWorktreeRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
  },
): void {
  app.get('/workspaces/:workspace/git/worktrees', async (req, res) => {
    const route = 'GET /workspaces/:workspace/git/worktrees';
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    try {
      runtime.generationGuard?.assertOpen();
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      deps.sendBridgeError(res, err, { route });
      return;
    }
    try {
      applyReadHeaders(res);
      const entries = await listGitWorktrees(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
      ).catch(() => null);
      if (!entries) {
        res.status(200).json({
          v: 1,
          workspaceCwd: runtime.workspaceCwd,
          available: false,
          worktrees: [],
        });
        return;
      }
      const managedDir = new GitWorktreeService(
        runtime.workspaceCwd,
      ).getUserWorktreesDir();
      res.status(200).json({
        v: 1,
        workspaceCwd: runtime.workspaceCwd,
        available: true,
        worktrees: entries.map((entry) => toWire(entry, runtime, managedDir)),
      });
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });

  app.get('/workspaces/:workspace/git/worktrees/status', async (req, res) => {
    const route = 'GET /workspaces/:workspace/git/worktrees/status';
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    try {
      runtime.generationGuard?.assertOpen();
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      deps.sendBridgeError(res, err, { route });
      return;
    }
    try {
      applyReadHeaders(res);
      const entry = await findWorktree(runtime, req.query['path']);
      if (entry === undefined) {
        sendError(res, 400, 'invalid_path', 'path query parameter is required');
        return;
      }
      if (entry === null) {
        sendError(
          res,
          404,
          'worktree_not_found',
          'No worktree of this repository has that path',
        );
        return;
      }
      const status = await getGitWorkingTreeStatus(entry.path);
      res.status(200).json(
        status
          ? {
              v: 1,
              path: entry.path,
              available: true,
              branch: status.branch,
              detached: status.detached,
              staged: status.staged,
              unstaged: status.unstaged,
              untracked: status.untracked,
              conflicted: status.conflicted,
              ahead: status.ahead,
              behind: status.behind,
            }
          : { v: 1, path: entry.path, available: false },
      );
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });

  app.post(
    '/workspaces/:workspace/git/worktrees/remove',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const route = 'POST /workspaces/:workspace/git/worktrees/remove';
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, { route });
        return;
      }
      const body = safeBody(req);
      const force = body['force'] === true;
      let entry: GitWorktreeEntry | null | undefined;
      try {
        entry = await findWorktree(runtime, body['path']);
      } catch (err) {
        sendGitError(
          res,
          err,
          route,
          deps.sendBridgeError,
          runtime.workspaceCwd,
        );
        return;
      }
      if (entry === undefined) {
        sendError(res, 400, 'invalid_path', 'path is required');
        return;
      }
      if (entry === null) {
        sendError(
          res,
          404,
          'worktree_not_found',
          'No worktree of this repository has that path',
        );
        return;
      }
      if (entry.isMain || entry.bare) {
        sendError(
          res,
          409,
          'worktree_is_main',
          'The main worktree cannot be removed',
        );
        return;
      }
      if (
        deps.workspaceRegistry
          .listEntries()
          .some((registered) => samePath(registered.workspaceCwd, entry.path))
      ) {
        sendError(
          res,
          409,
          'worktree_is_workspace',
          'This worktree is a registered workspace; remove the workspace first',
        );
        return;
      }
      const liveSessions = runtime.bridge
        .listWorkspaceSessions(runtime.workspaceCwd)
        .filter(
          (session) =>
            session.worktree !== undefined &&
            samePath(session.worktree.path, entry.path),
        ).length;
      if (liveSessions > 0 && !force) {
        sendError(
          res,
          409,
          'worktree_in_use',
          'Sessions are still running in this worktree',
          { sessions: liveSessions },
        );
        return;
      }
      try {
        if (entry.prunable !== undefined) {
          await pruneGitWorktrees(
            runtime.workspaceCwd,
            runtime.env.effectiveEnv,
          );
          res.status(200).json({ removed: true, path: entry.path });
          return;
        }
        if (!force) {
          const status = await getGitWorkingTreeStatus(entry.path);
          if (!status) {
            sendError(
              res,
              409,
              'worktree_status_unknown',
              'The working tree state could not be read',
            );
            return;
          }
          const changes =
            status.staged +
            status.unstaged +
            status.untracked +
            status.conflicted;
          if (changes > 0) {
            sendError(
              res,
              409,
              'worktree_dirty',
              'The worktree has uncommitted changes',
              { changes },
            );
            return;
          }
        }
        await removeGitWorktree(
          runtime.workspaceCwd,
          entry.path,
          { force },
          runtime.env.effectiveEnv,
        );
        res.status(200).json({ removed: true, path: entry.path });
      } catch (err) {
        sendGitError(
          res,
          err,
          route,
          deps.sendBridgeError,
          runtime.workspaceCwd,
        );
      }
    },
  );
}
