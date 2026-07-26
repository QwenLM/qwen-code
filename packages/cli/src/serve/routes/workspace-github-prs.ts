/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import {
  GITHUB_PR_ERROR_MESSAGE_MAX,
  fetchGitHubPullRequests,
  type FetchGitHubPullRequestsResult,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
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
  ): Promise<FetchGitHubPullRequestsResult> => {
    const now = Date.now();
    const existing = cache.get(workspaceCwd);
    const fresh =
      existing !== undefined &&
      (existing.settledAt === null || now - existing.settledAt < ttlMs);
    if (!fresh) {
      const entry: PrsCacheEntry = {
        promise: fetchGitHubPullRequests(workspaceCwd),
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
      const result = await getPullRequests(runtime.workspaceCwd);
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
}
