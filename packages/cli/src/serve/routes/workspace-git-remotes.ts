/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import {
  fetchGitRemotes,
  gitRemoteAdd,
  gitRemoteRemove,
  isRemovableRemoteName,
  isValidRemoteName,
  isValidRemoteUrl,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import { safeBody } from '../server/request-helpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  resolveContainedCwd,
  resolveContainedCwdOrFail,
  resolveTrustedRuntime,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import { sendGitError } from './workspace-git-branches.js';

async function handleRemotes(
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  assertGenerationOpen?: () => void,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  try {
    assertGenerationOpen?.();
    const remotes = await fetchGitRemotes(cwd, env);
    assertGenerationOpen?.();
    res.status(200).json({ v: 1, workspaceCwd: cwd, available: true, remotes });
  } catch (err) {
    if (sendGenerationClosedError(res, err)) return;
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

// Both mutations answer with the fresh remote list: `git remote -v` costs
// milliseconds server-side and saves the client a second round trip before
// it can re-render.
async function handleRemoteAdd(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const body = safeBody(req);
  const name = body['name'];
  if (typeof name !== 'string' || !isValidRemoteName(name)) {
    res
      .status(400)
      .json({ error: 'invalid_remote_name', message: 'Invalid remote name' });
    return;
  }
  const url = body['url'];
  if (typeof url !== 'string' || !isValidRemoteUrl(url.trim())) {
    res
      .status(400)
      .json({ error: 'invalid_remote_url', message: 'Invalid remote URL' });
    return;
  }
  try {
    const remotes = await gitRemoteAdd(cwd, name, url, env);
    res.status(200).json({ v: 1, workspaceCwd: cwd, remotes });
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

async function handleRemoteRemove(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const body = safeBody(req);
  const name = body['name'];
  if (typeof name !== 'string' || !isRemovableRemoteName(name)) {
    res
      .status(400)
      .json({ error: 'invalid_remote_name', message: 'Invalid remote name' });
    return;
  }
  try {
    const remotes = await gitRemoteRemove(cwd, name, env);
    res.status(200).json({ v: 1, workspaceCwd: cwd, remotes });
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

// Scoped-only by design (same precedent as the GitHub-PRs routes): the sole
// consumer is the Web Shell, which always addresses a workspace by cwd.
export function registerWorkspaceQualifiedGitRemotesRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
  },
): void {
  app.get('/workspaces/:workspace/git/remotes', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleRemotes(
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/remotes',
      () => runtime.generationGuard?.assertOpen(),
      runtime.env.effectiveEnv,
    );
  });
  app.post(
    '/workspaces/:workspace/git/remote',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, {
          route: 'POST /workspaces/:workspace/git/remote',
        });
        return;
      }
      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }
      void handleRemoteAdd(
        req,
        res,
        cwd,
        deps.sendBridgeError,
        'POST /workspaces/:workspace/git/remote',
        runtime.env.effectiveEnv,
      );
    },
  );
  app.post(
    '/workspaces/:workspace/git/remote/remove',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, {
          route: 'POST /workspaces/:workspace/git/remote/remove',
        });
        return;
      }
      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }
      void handleRemoteRemove(
        req,
        res,
        cwd,
        deps.sendBridgeError,
        'POST /workspaces/:workspace/git/remote/remove',
        runtime.env.effectiveEnv,
      );
    },
  );
}
