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
  GitPullFailure,
  gitCommit,
  isValidRefName,
  isValidCheckoutRef,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import { safeBody } from '../server/request-helpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  resolveContainedCwd,
  resolveContainedCwdOrFail,
  resolveTrustedRuntime,
  sendGenerationClosedError,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';

const GIT_ERROR_MESSAGE_MAX = 512;

// Redact the workspace path and the git root (which may be an ancestor of
// cwd when the workspace is a sub-directory or a symlink), then cap the
// length once, on every response — including the unclassified 500
// fall-through. Raw git output embeds absolute paths (e.g. a wedged
// `.git/index.lock`) that must never reach the client.
function redactGitPaths(detail: string, cwd: string): string {
  const gitRoot = findGitRoot(cwd);
  let message = detail.split(cwd).join('<workspace>');
  if (gitRoot && gitRoot !== cwd) {
    message = message.split(gitRoot).join('<workspace>');
  }
  return message;
}

function redactGitMessage(detail: string, cwd: string): string {
  return redactGitPaths(detail, cwd).slice(0, GIT_ERROR_MESSAGE_MAX);
}

export function sendGitError(
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
    // Empty parts are dropped so a genuine single-line message always sits
    // at line 1: the anchored shapes below match line 1 (or the documented
    // two-line lock chain) ONLY, because a config-chosen value (a URL or a
    // fetch refspec) can carry a real newline and inject a line-initial
    // prefix of the attacker's choice deeper in the text.
    detail = [e.stdout, e.stderr]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join('\n');
  } else {
    detail = err instanceof Error ? err.message : String(err);
  }

  // Classification reads the FULL redacted detail: slicing before
  // matching would cut a long lock line's second line off before its
  // `could not …` prefix (a deeply nested workspace path pushes the
  // two-line lock chain past 512 chars) and misread a config-write
  // failure as an unclassified 500. Only the client-visible message is
  // bounded.
  const fullMessage = redactGitPaths(detail, cwd);
  const message = fullMessage.slice(0, GIT_ERROR_MESSAGE_MAX);

  // git's remote config-write failures echo the name as `remote.<name>`
  // (no space) and the URL verbatim. Every remote-shape branch below is
  // anchored to git's own message START (line 1 of the composed detail),
  // because a config-chosen name or URL can carry any keyword — `a remote
  // b already exists`, `no such remote`, even `could not remove config
  // section` — and a config-chosen VALUE can carry a real newline, so any
  // deeper line is attacker-controllable. A lock surfaces as git's own
  // two-line chain (`could not lock config file …` followed by the write
  // failure); everything else git reports in these shapes is single-line.
  if (
    /^(?:error|fatal): could not (?:remove config section |set 'remote\.|unset 'branch\.)/i.test(
      fullMessage,
    ) ||
    /^(?:error|fatal): could not lock config file [^\n]*\n(?:error|fatal): could not (?:remove config section |set 'remote\.|unset 'branch\.)/i.test(
      fullMessage,
    )
  ) {
    res.status(409).json({ error: 'git_config_write_failed', message });
    return;
  }
  if (/^(?:error|fatal): remote .+ already exists\.?\s*$/i.test(fullMessage)) {
    res.status(409).json({ error: 'remote_already_exists', message });
    return;
  }
  if (/^(?:error|fatal): No such remote: /i.test(fullMessage)) {
    res.status(404).json({ error: 'no_such_remote', message });
    return;
  }
  // Our own removal-verification throw (a plain Error, no git prefix): a
  // remote NAMED after this text must not be claimed by it.
  if (/^remote still configured after removal$/i.test(fullMessage)) {
    res.status(409).json({ error: 'remote_still_configured', message });
    return;
  }
  // git dies parsing a configured fetch refspec before mutating anything:
  // the row stays, nothing was destroyed, and the cause is nameable.
  if (/^(?:error|fatal): invalid refspec/i.test(fullMessage)) {
    res.status(409).json({ error: 'remote_config_unparsable', message });
    return;
  }
  // Our own add pre-flight refusal (a plain Error, no git prefix): the
  // name exists in an inherited scope git's duplicate check cannot see.
  if (/^remote already configured in an inherited scope$/i.test(fullMessage)) {
    res.status(409).json({ error: 'remote_shadows_inherited', message });
    return;
  }
  if (
    /not a git repository/i.test(fullMessage) ||
    /invalid reference/i.test(fullMessage)
  ) {
    res.status(404).json({ error: 'not_a_git_repository', message });
    return;
  }
  if (/dirty|uncommitted|would be overwritten/i.test(fullMessage)) {
    res.status(409).json({ error: 'dirty_working_tree', message });
    return;
  }
  if (/already exists/i.test(fullMessage)) {
    res.status(409).json({ error: 'branch_already_exists', message });
    return;
  }
  if (/nothing to commit/i.test(fullMessage)) {
    res.status(400).json({ error: 'nothing_to_commit', message });
    return;
  }
  if (/detached HEAD/i.test(fullMessage)) {
    res.status(409).json({ error: 'detached_head', message });
    return;
  }
  if (/no upstream|no tracking information/i.test(fullMessage)) {
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
  if (body['stash'] !== undefined && typeof body['stash'] !== 'boolean') {
    res
      .status(400)
      .json({ error: 'invalid_stash', message: 'stash must be a boolean' });
    return;
  }
  if (body['force'] !== undefined && typeof body['force'] !== 'boolean') {
    res
      .status(400)
      .json({ error: 'invalid_force', message: 'force must be a boolean' });
    return;
  }
  const rebase = body['rebase'] === true;
  const fetchOnly = body['fetchOnly'] === true;
  const stash = body['stash'] === true;
  const force = body['force'] === true;
  if (stash && force) {
    res.status(400).json({
      error: 'invalid_stash_force',
      message: 'stash and force are mutually exclusive',
    });
    return;
  }
  if (fetchOnly && (stash || force)) {
    res.status(400).json({
      error: 'invalid_fetch_only_combination',
      message: 'fetchOnly cannot be combined with stash or force',
    });
    return;
  }
  try {
    const result = await gitPull(cwd, { rebase, fetchOnly, stash, force }, env);
    // A successful stash pull can still carry git's notice about a failed
    // restore, which embeds absolute paths like any other git output.
    res
      .status(200)
      .json({ ...result, output: redactGitPaths(result.output, cwd) });
  } catch (err) {
    if (err instanceof GitPullFailure) {
      // A typed refusal or a failure the core already recovered from: the
      // repository is in a known state and the code tells the client what
      // it can offer next.
      res
        .status(409)
        .json({ error: err.code, message: redactGitMessage(err.message, cwd) });
      return;
    }
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
    void handleBranches(
      res,
      resolveContainedCwd(req, runtime.workspaceCwd),
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
      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
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
      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
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
      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
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
      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
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
      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
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
