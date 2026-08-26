/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import {
  fetchGitBranches,
  findGitRoot,
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
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  resolveSessionManagedGitCwd,
  resolveTrustedRuntime,
  sendGenerationClosedError,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';

const GIT_ERROR_MESSAGE_MAX = 512;

function sendGitError(
  res: Response,
  err: unknown,
  route: string,
  sendBridgeError: SendBridgeError,
  cwd: string,
): void {
  // Classify on the path-redacted message (derived from stdout + stderr),
  // not err.message, which embeds the full command line and would
  // false-positive on flags like --set-upstream present in every push
  // invocation. Testing the redacted form also avoids false positives
  // when the workspace path itself contains a keyword (e.g. "dirty").
  let detail: string;
  if (err && typeof err === 'object' && ('stdout' in err || 'stderr' in err)) {
    const e = err as { stdout?: string; stderr?: string };
    detail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  } else {
    detail = err instanceof Error ? err.message : String(err);
  }

  // Redact the workspace path and the git root (which may be an ancestor
  // of cwd when the workspace is a sub-directory or a symlink), then cap the
  // length once, on every response — including the unclassified 500
  // fall-through. Raw git output embeds absolute paths (e.g. a wedged
  // `.git/index.lock`) that must never reach the client.
  const gitRoot = findGitRoot(cwd);
  let message = detail.split(cwd).join('<workspace>');
  if (gitRoot && gitRoot !== cwd) {
    message = message.split(gitRoot).join('<workspace>');
  }
  message = message.slice(0, GIT_ERROR_MESSAGE_MAX);

  if (
    /not a git repository/i.test(message) ||
    /invalid reference/i.test(message)
  ) {
    res.status(404).json({ error: 'not_a_git_repository', message });
    return;
  }
  if (/dirty|uncommitted|would be overwritten/i.test(message)) {
    res.status(409).json({ error: 'dirty_working_tree', message });
    return;
  }
  if (/already exists/i.test(message)) {
    res.status(409).json({ error: 'branch_already_exists', message });
    return;
  }
  if (/nothing to commit/i.test(message)) {
    res.status(400).json({ error: 'nothing_to_commit', message });
    return;
  }
  if (/detached HEAD/i.test(message)) {
    res.status(409).json({ error: 'detached_head', message });
    return;
  }
  if (/no upstream|no tracking information/i.test(message)) {
    res.status(400).json({ error: 'no_upstream', message });
    return;
  }
  // Unclassified failure: keep the operator log line but forward a redacted
  // message so the raw git output never reaches the client.
  sendBridgeError(res, new Error(message), { route });
}

async function handleBranches(
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  assertGenerationOpen?: () => void,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  try {
    assertGenerationOpen?.();
    const result = await fetchGitBranches(cwd, env);
    assertGenerationOpen?.();
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
    if (sendGenerationClosedError(res, err)) return;
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

async function handleCheckout(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  env?: Readonly<Record<string, string | undefined>>,
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
    const result = await gitCheckout(cwd, ref.trim(), env);
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

async function handleCreateBranch(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const body = safeBody(req);
  const name = body['name'];
  if (
    typeof name !== 'string' ||
    !isValidRefName(name) ||
    name.startsWith('-')
  ) {
    res
      .status(400)
      .json({ error: 'invalid_branch_name', message: 'Invalid branch name' });
    return;
  }
  const rawStartPoint = body['startPoint'];
  if (rawStartPoint !== undefined && typeof rawStartPoint !== 'string') {
    res.status(400).json({
      error: 'invalid_start_point',
      message: 'startPoint must be a string',
    });
    return;
  }
  const startPoint =
    typeof rawStartPoint === 'string'
      ? rawStartPoint.trim() || undefined
      : undefined;
  if (startPoint !== undefined && !isValidCheckoutRef(startPoint)) {
    res
      .status(400)
      .json({ error: 'invalid_start_point', message: 'Invalid start point' });
    return;
  }
  try {
    const result = await gitCreateBranch(cwd, name, startPoint, env);
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

async function handlePush(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const body = safeBody(req);
  if (
    body['setUpstream'] !== undefined &&
    typeof body['setUpstream'] !== 'boolean'
  ) {
    res.status(400).json({
      error: 'invalid_set_upstream',
      message: 'setUpstream must be a boolean',
    });
    return;
  }
  if (body['force'] !== undefined && typeof body['force'] !== 'boolean') {
    res
      .status(400)
      .json({ error: 'invalid_force', message: 'force must be a boolean' });
    return;
  }
  const setUpstream = body['setUpstream'] === true;
  const force = body['force'] === true;
  try {
    const result = await gitPush(cwd, { setUpstream, force }, env);
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

async function handlePull(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const body = safeBody(req);
  if (body['rebase'] !== undefined && typeof body['rebase'] !== 'boolean') {
    res
      .status(400)
      .json({ error: 'invalid_rebase', message: 'rebase must be a boolean' });
    return;
  }
  if (
    body['fetchOnly'] !== undefined &&
    typeof body['fetchOnly'] !== 'boolean'
  ) {
    res.status(400).json({
      error: 'invalid_fetch_only',
      message: 'fetchOnly must be a boolean',
    });
    return;
  }
  const rebase = body['rebase'] === true;
  const fetchOnly = body['fetchOnly'] === true;
  try {
    const result = await gitPull(cwd, { rebase, fetchOnly }, env);
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

async function handleCommit(
  req: Request,
  res: Response,
  cwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const body = safeBody(req);
  const message = body['message'];
  if (typeof message !== 'string' || !message.trim()) {
    res
      .status(400)
      .json({ error: 'missing_message', message: 'message is required' });
    return;
  }
  if (body['all'] !== undefined && typeof body['all'] !== 'boolean') {
    res
      .status(400)
      .json({ error: 'invalid_all', message: 'all must be a boolean' });
    return;
  }
  const all = body['all'] === true;
  try {
    const result = await gitCommit(cwd, message.trim(), { all }, env);
    res.status(200).json(result);
  } catch (err) {
    sendGitError(res, err, route, sendBridgeError, cwd);
  }
}

export function registerWorkspaceGitBranchRoutes(
  app: Application,
  deps: {
    boundWorkspace: string;
    sendBridgeError: SendBridgeError;
    isWorkspaceTrusted?: () => boolean;
    captureGenerationAssertion?: () => (() => void) | undefined;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
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
      deps.captureGenerationAssertion?.(),
    );
  });
  app.post(
    '/workspace/git/checkout',
    deps.mutate({ strict: true }),
    (req, res) => {
      if (deps.isWorkspaceTrusted?.() === false) {
        sendUntrustedWorkspaceResponse(res);
        return;
      }
      try {
        deps.captureGenerationAssertion?.()?.();
      } catch (err) {
        deps.sendBridgeError(res, err, {
          route: 'POST /workspace/git/checkout',
        });
        return;
      }
      void handleCheckout(
        req,
        res,
        deps.boundWorkspace,
        deps.sendBridgeError,
        'POST /workspace/git/checkout',
      );
    },
  );
  app.post(
    '/workspace/git/branch',
    deps.mutate({ strict: true }),
    (req, res) => {
      if (deps.isWorkspaceTrusted?.() === false) {
        sendUntrustedWorkspaceResponse(res);
        return;
      }
      try {
        deps.captureGenerationAssertion?.()?.();
      } catch (err) {
        deps.sendBridgeError(res, err, {
          route: 'POST /workspace/git/branch',
        });
        return;
      }
      void handleCreateBranch(
        req,
        res,
        deps.boundWorkspace,
        deps.sendBridgeError,
        'POST /workspace/git/branch',
      );
    },
  );
  app.post('/workspace/git/push', deps.mutate({ strict: true }), (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    try {
      deps.captureGenerationAssertion?.()?.();
    } catch (err) {
      deps.sendBridgeError(res, err, { route: 'POST /workspace/git/push' });
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
  app.post('/workspace/git/pull', deps.mutate({ strict: true }), (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    try {
      deps.captureGenerationAssertion?.()?.();
    } catch (err) {
      deps.sendBridgeError(res, err, { route: 'POST /workspace/git/pull' });
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
  app.post(
    '/workspace/git/commit',
    deps.mutate({ strict: true }),
    (req, res) => {
      if (deps.isWorkspaceTrusted?.() === false) {
        sendUntrustedWorkspaceResponse(res);
        return;
      }
      try {
        deps.captureGenerationAssertion?.()?.();
      } catch (err) {
        deps.sendBridgeError(res, err, {
          route: 'POST /workspace/git/commit',
        });
        return;
      }
      void handleCommit(
        req,
        res,
        deps.boundWorkspace,
        deps.sendBridgeError,
        'POST /workspace/git/commit',
      );
    },
  );
}

export function registerWorkspaceQualifiedGitBranchRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
  },
): void {
  app.get('/workspaces/:workspace/git/branches', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    const cwd = resolveSessionManagedGitCwd(req, runtime);
    if (cwd === null) {
      res.status(400).json({ error: 'invalid_cwd' });
      return;
    }
    void handleBranches(
      res,
      cwd,
      deps.sendBridgeError,
      'GET /workspaces/:workspace/git/branches',
      () => runtime.generationGuard?.assertOpen(),
      runtime.env.effectiveEnv,
    );
  });
  app.post(
    '/workspaces/:workspace/git/checkout',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, {
          route: 'POST /workspaces/:workspace/git/checkout',
        });
        return;
      }
      const cwd = resolveSessionManagedGitCwd(req, runtime);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }
      void handleCheckout(
        req,
        res,
        cwd,
        deps.sendBridgeError,
        'POST /workspaces/:workspace/git/checkout',
        runtime.env.effectiveEnv,
      );
    },
  );
  app.post(
    '/workspaces/:workspace/git/branch',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, {
          route: 'POST /workspaces/:workspace/git/branch',
        });
        return;
      }
      const cwd = resolveSessionManagedGitCwd(req, runtime);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }
      void handleCreateBranch(
        req,
        res,
        cwd,
        deps.sendBridgeError,
        'POST /workspaces/:workspace/git/branch',
        runtime.env.effectiveEnv,
      );
    },
  );
  app.post(
    '/workspaces/:workspace/git/push',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, {
          route: 'POST /workspaces/:workspace/git/push',
        });
        return;
      }
      const cwd = resolveSessionManagedGitCwd(req, runtime);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }
      void handlePush(
        req,
        res,
        cwd,
        deps.sendBridgeError,
        'POST /workspaces/:workspace/git/push',
        runtime.env.effectiveEnv,
      );
    },
  );
  app.post(
    '/workspaces/:workspace/git/pull',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, {
          route: 'POST /workspaces/:workspace/git/pull',
        });
        return;
      }
      const cwd = resolveSessionManagedGitCwd(req, runtime);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }
      void handlePull(
        req,
        res,
        cwd,
        deps.sendBridgeError,
        'POST /workspaces/:workspace/git/pull',
        runtime.env.effectiveEnv,
      );
    },
  );
  app.post(
    '/workspaces/:workspace/git/commit',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, {
          route: 'POST /workspaces/:workspace/git/commit',
        });
        return;
      }
      const cwd = resolveSessionManagedGitCwd(req, runtime);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }
      void handleCommit(
        req,
        res,
        cwd,
        deps.sendBridgeError,
        'POST /workspaces/:workspace/git/commit',
        runtime.env.effectiveEnv,
      );
    },
  );
}
