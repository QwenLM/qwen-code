/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import {
  GITHUB_PR_ERROR_MESSAGE_MAX,
  fetchGitHubPullRequests,
  createGitHubPullRequest,
  getDefaultBranch,
  type FetchGitHubPullRequestsResult,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import { safeBody } from '../server/request-helpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveContainedCwdOrFail,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';

const DEFAULT_CACHE_TTL_MS = 60_000;

function sanitizeMessage(message: string, workspaceCwd: string): string {
  return message.split(workspaceCwd).join('<workspace>');
}

export function registerWorkspaceQualifiedGitHubPrsRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
    /** Coalescing/refresh window for the cached PR list. Defaults to 60s. */
    cacheTtlMs?: number;
  },
): void {
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // Closure-scoped, per-workspace PR cache (one daemon per process). `gh pr
  // list` with CI rollup is the slow part (multi-second GitHub round-trips),
  // and the panel is glanceable, so a short TTL turns repeat opens instant.
  // A pending load is reused regardless of age, so concurrent opens share one
  // `gh` spawn even when it outlives the TTL; the window starts once the load
  // settles. Only `ok` results are cached — `cli_unavailable` / `failed` /
  // `not_a_repo` clear the entry so the next open retries (gh may since have
  // been installed or authed, or the workspace may have become a repo).
  interface PrsCacheEntry {
    promise: Promise<FetchGitHubPullRequestsResult>;
    settledAt: number | null;
  }
  const cache = new Map<string, PrsCacheEntry>();

  const getPullRequests = (
    workspaceCwd: string,
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<FetchGitHubPullRequestsResult> => {
    const now = Date.now();
    const existing = cache.get(workspaceCwd);
    const fresh =
      existing !== undefined &&
      (existing.settledAt === null || now - existing.settledAt < ttlMs);
    if (!fresh) {
      const entry: PrsCacheEntry = {
        promise: fetchGitHubPullRequests(workspaceCwd, env),
        settledAt: null,
      };
      cache.set(workspaceCwd, entry);
      entry.promise.then(
        (result) => {
          if (cache.get(workspaceCwd) !== entry) return;
          if (result.kind === 'ok') entry.settledAt = Date.now();
          else cache.delete(workspaceCwd);
        },
        () => {
          if (cache.get(workspaceCwd) === entry) cache.delete(workspaceCwd);
        },
      );
    }
    return cache.get(workspaceCwd)!.promise;
  };

  app.get('/workspaces/:workspace/github/prs', async (req, res) => {
    const route = 'GET /workspaces/:workspace/github/prs';
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;

    applyReadHeaders(res);
    try {
      const result = await getPullRequests(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
      );
      switch (result.kind) {
        case 'ok':
          res.status(200).json({
            v: 1,
            workspaceCwd: runtime.workspaceCwd,
            available: true,
            pullRequests: result.pullRequests,
          });
          return;
        case 'not_a_repo':
          res.status(200).json({
            v: 1,
            workspaceCwd: runtime.workspaceCwd,
            available: false,
            pullRequests: [],
          });
          return;
        case 'cli_unavailable':
          res.status(502).json({
            error:
              'The GitHub CLI (gh) is not installed on the daemon host; install it and run `gh auth login`.',
            code: 'github_cli_unavailable',
            status: 502,
          });
          return;
        case 'failed': {
          // Sanitize workspace paths before truncating so a path straddling
          // the display boundary is redacted rather than cut mid-token.
          const error = sanitizeMessage(
            sanitizeMessage(result.message, runtime.workspaceCwd),
            result.gitRoot,
          ).slice(0, GITHUB_PR_ERROR_MESSAGE_MAX);
          res.status(502).json({
            error,
            code: 'github_prs_failed',
            status: 502,
          });
          return;
        }
        default:
          throw new Error(
            `unexpected fetchGitHubPullRequests result: ${JSON.stringify(result)}`,
          );
      }
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });

  app.post(
    '/workspaces/:workspace/github/prs/create',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const route = 'POST /workspaces/:workspace/github/prs/create';
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
      try {
        runtime.generationGuard?.assertOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        deps.sendBridgeError(res, err, { route });
        return;
      }

      const body = safeBody(req);
      const title = body['title'];
      if (typeof title !== 'string' || !title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      for (const field of ['body', 'base', 'head'] as const) {
        if (body[field] !== undefined && typeof body[field] !== 'string') {
          res.status(400).json({ error: `${field} must be a string` });
          return;
        }
      }
      const prBody =
        typeof body['body'] === 'string' ? body['body'] : undefined;
      const base = typeof body['base'] === 'string' ? body['base'] : undefined;
      const head = typeof body['head'] === 'string' ? body['head'] : undefined;

      const cwd = resolveContainedCwdOrFail(req, runtime.workspaceCwd);
      if (cwd === null) {
        res.status(400).json({
          error: 'invalid_cwd',
          message: 'The supplied cwd is invalid or outside the workspace',
        });
        return;
      }

      try {
        const result = await createGitHubPullRequest(
          cwd,
          {
            title: title.trim(),
            body: prBody,
            base,
            head,
          },
          runtime.env.effectiveEnv,
        );
        switch (result.kind) {
          case 'ok':
            res.status(201).json({ url: result.url, number: result.number });
            return;
          case 'not_a_repo':
            res.status(404).json({ error: 'not_a_git_repository' });
            return;
          case 'cli_unavailable':
            res.status(502).json({
              error: 'gh CLI not available',
              code: 'github_cli_unavailable',
            });
            return;
          case 'failed':
            // Sanitize both the workspace cwd and the git root (gh runs at the
            // git root, which may be a parent of the workspace) before truncating.
            res.status(502).json({
              error: sanitizeMessage(
                sanitizeMessage(result.message, runtime.workspaceCwd),
                result.gitRoot,
              ).slice(0, GITHUB_PR_ERROR_MESSAGE_MAX),
              code: 'github_pr_create_failed',
            });
            return;
          default:
            res.status(500).json({ error: 'unexpected result' });
            return;
        }
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  app.get('/workspaces/:workspace/github/default-branch', async (req, res) => {
    const route = 'GET /workspaces/:workspace/github/default-branch';
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;

    applyReadHeaders(res);
    try {
      runtime.generationGuard?.assertOpen();
      const branch = await getDefaultBranch(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
      );
      runtime.generationGuard?.assertOpen();
      res.status(200).json({ branch: branch ?? 'origin/main' });
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      deps.sendBridgeError(res, err, { route });
    }
  });
}
