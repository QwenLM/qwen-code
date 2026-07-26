/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  fetchGitBranches,
  gitCheckout,
  gitCreateBranch,
  gitPush,
  gitPull,
  gitCommit,
  isValidRefName,
  isValidCheckoutRef,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import { safeBody } from '../server/request-helpers.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveContainedCwd,
  resolveWorkspaceRuntimeFromParam,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';

function resolveTrustedRuntime(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
): WorkspaceRuntime | null {
  const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
  if (!runtime) return null;
  return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
}

function sendGitError(
  res: Response,
  err: unknown,
  route: string,
  sendBridgeError: SendBridgeError,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /not a git repository/i.test(msg) ||
    /could not resolve.*to a revision/i.test(msg)
  ) {
    res.status(404).json({ error: 'not_a_git_repository', message: msg });
    return;
  }
  if (/dirty|uncommitted|would be overwritten/i.test(msg)) {
    res.status(409).json({ error: 'dirty_working_tree', message: msg });
    return;
  }
  if (/already exists/i.test(msg)) {
    res.status(409).json({ error: 'branch_already_exists', message: msg });
    return;
  }
  if (/nothing to commit/i.test(msg)) {
    res.status(400).json({ error: 'nothing_to_commit', message: msg });
    return;
  }
  if (/detached HEAD/i.test(msg)) {
    res.status(409).json({ error: 'detached_head', message: msg });
    return;
  }
  if (/no upstream|set-upstream/i.test(msg)) {
    res.status(400).json({ error: 'no_upstream', message: msg });
    return;
  }
  sendBridgeError(res, err, { route });
}

async function handleBranches(
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  try {
    const result = await fetchGitBranches(cwd);
    res.status(200).json({
      v: 1,
      workspaceCwd: cwd,
      available: true,
      local: result.local,
      remote: result.remote,
      tags: result.tags,
      recent: result.recent,
      head: result.head,
      detached: result.detached,
    });
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError);
  }
}

async function handleCheckout(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const body = safeBody(req);
  const ref = body['ref'];
  if (typeof ref !== 'string' || !ref.trim()) {
    res.status(400).json({ error: 'missing_ref', message: 'ref is required' });
    return;
  }
  if (!isValidCheckoutRef(ref)) {
    res
      .status(400)
      .json({ error: 'invalid_ref', message: 'Invalid checkout ref' });
    return;
  }
  try {
    const result = await gitCheckout(cwd, ref.trim());
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError);
  }
}

async function handleCreateBranch(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const body = safeBody(req);
  const name = body['name'];
  if (typeof name !== 'string' || !isValidRefName(name)) {
    res
      .status(400)
      .json({ error: 'invalid_branch_name', message: 'Invalid branch name' });
    return;
  }
  const startPoint =
    typeof body['startPoint'] === 'string' ? body['startPoint'] : undefined;
  if (startPoint !== undefined && !isValidCheckoutRef(startPoint)) {
    res
      .status(400)
      .json({ error: 'invalid_start_point', message: 'Invalid start point' });
    return;
  }
  try {
    const result = await gitCreateBranch(cwd, name, startPoint);
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError);
  }
}

async function handlePush(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const body = safeBody(req);
  const setUpstream = body['setUpstream'] === true;
  const force = body['force'] === true;
  try {
    const result = await gitPush(cwd, { setUpstream, force });
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError);
  }
}

async function handlePull(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const body = safeBody(req);
  const rebase = body['rebase'] === true;
  const fetchOnly = body['fetchOnly'] === true;
  try {
    const result = await gitPull(cwd, { rebase, fetchOnly });
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError);
  }
}

async function handleCommit(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const body = safeBody(req);
  const message = body['message'];
  if (typeof message !== 'string' || !message.trim()) {
    res
      .status(400)
      .json({ error: 'missing_message', message: 'message is required' });
    return;
  }
  const all = body['all'] === true;
  try {
    const result = await gitCommit(cwd, message.trim(), { all });
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError);
  }
}

export function registerWorkspaceGitBranchRoutes(
  app: Application,
  deps: {
    boundWorkspace: string;
    sendBridgeError: SendBridgeError;
    isWorkspaceTrusted?: () => boolean;
  },
): void {
  app.get('/workspace/git/branches', (_req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handleBranches(
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/git/branches',
    );
  });
  app.post('/workspace/git/checkout', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handleCheckout(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'POST /workspace/git/checkout',
    );
  });
  app.post('/workspace/git/branch', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handleCreateBranch(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'POST /workspace/git/branch',
    );
  });
  app.post('/workspace/git/push', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handlePush(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'POST /workspace/git/push',
    );
  });
  app.post('/workspace/git/pull', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handlePull(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'POST /workspace/git/pull',
    );
  });
  app.post('/workspace/git/commit', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    void handleCommit(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'POST /workspace/git/commit',
    );
  });
}

export function registerWorkspaceQualifiedGitBranchRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspaces/:workspace/git/branches', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleBranches(
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/branches',
    );
  });
  app.post('/workspaces/:workspace/git/checkout', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleCheckout(
      req,
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'POST /workspaces/:workspace/git/checkout',
    );
  });
  app.post('/workspaces/:workspace/git/branch', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleCreateBranch(
      req,
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'POST /workspaces/:workspace/git/branch',
    );
  });
  app.post('/workspaces/:workspace/git/push', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handlePush(
      req,
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'POST /workspaces/:workspace/git/push',
    );
  });
  app.post('/workspaces/:workspace/git/pull', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handlePull(
      req,
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'POST /workspaces/:workspace/git/pull',
    );
  });
  app.post('/workspaces/:workspace/git/commit', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleCommit(
      req,
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
      deps.sendBridgeError,
      'POST /workspaces/:workspace/git/commit',
    );
  });
}
