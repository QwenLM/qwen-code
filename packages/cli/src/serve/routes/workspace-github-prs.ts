/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import {
  GITHUB_PR_ERROR_MESSAGE_MAX,
  fetchGitHubPullRequests,
  fetchGitHubPullRequestFiles,
  createGitHubPullRequest,
  getDefaultBranch,
  type FetchGitHubPullRequestsResult,
  type FetchGitHubPullRequestFilesResult,
} from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { SendBridgeError } from '../server/error-response.js';
import { safeBody } from '../server/request-helpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveSessionManagedGitCwdForRoute,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';

const DEFAULT_CACHE_TTL_MS = 60_000;
const debugLogger = createDebugLogger('GITHUB_PRS');

function sanitizeMessage(message: string, workspaceCwd: string): string {
  return message.split(workspaceCwd).join('<workspace>');
}

// The resolved fallback binary can contain spaces (`/Users/John Smith/...`),
// which a whitespace-bounded token sweep cannot own; redacting the exact value
// the producer reported removes it whole.
function redactKnownValue(message: string, value: string | undefined): string {
  return value === undefined || value === ''
    ? message
    : message.split(value).join('<path>');
}

// The resolved gh binary can be an absolute install path (a launchd-shaped
// daemon's PATH does not carry the package-manager bin dir), and Node's spawn
// errors embed it — as can gh's own stderr. Sweep ANY surviving absolute-path
// token, whatever sentence wraps it, AFTER the two known-path replacements so
// they still label their payloads, and BEFORE the caller truncates: the
// display cap must never cut a path before it is redacted.
//
// The negative lookbehind is what keeps the sweep honest about token starts:
// a path glued after `=`, `,`, `[` or a backtick is still a path (`open=/Users/…`
// from gh's own stderr, `` `/Users/…` `` from Node), while `:` and `/` stay
// excluded so `https://…` and a mid-path slash are never re-matched, and `>`
// stays excluded so the `<workspace>/sub` label survives.
function sweepAbsolutePaths(message: string): string {
  return message.replace(
    /(?<![\w~.:/\\<>-])(?:\/|[A-Za-z]:[\\/]|\\\\)[^\s'"<>]*/g,
    '<path>',
  );
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

  // In-flight coalescing for the files route: concurrent requests for the same
  // cwd+number+repo share one `gh` spawn, mirroring the PR-list cache's
  // pending-load reuse. Entries clear once settled so a later open re-reads
  // fresh data rather than a stale snapshot.
  const prFilesInFlight = new Map<
    string,
    Promise<FetchGitHubPullRequestFilesResult>
  >();
  const getPrFiles = (
    cwd: string,
    number: number,
    env?: Readonly<Record<string, string | undefined>>,
    repo?: string,
  ): Promise<FetchGitHubPullRequestFilesResult> => {
    const key = `${cwd}\u0000${number}\u0000${repo ?? ''}`;
    const existing = prFilesInFlight.get(key);
    if (existing) return existing;
    const promise = fetchGitHubPullRequestFiles(cwd, number, env, repo);
    prFilesInFlight.set(key, promise);
    const settle = () => {
      if (prFilesInFlight.get(key) === promise) prFilesInFlight.delete(key);
    };
    promise.then(settle, settle);
    return promise;
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
          // Raw text stays server-side: the wire body is redacted, and the
          // sweep deletes exactly the token an operator needs to tell which
          // binary or config file failed.
          debugLogger.debug('GitHub PR list failed', {
            workspaceCwd: runtime.workspaceCwd,
            gitRoot: result.gitRoot,
            message: result.message,
          });
          // Sanitize workspace paths before truncating so a path straddling
          // the display boundary is redacted rather than cut mid-token.
          const error = sweepAbsolutePaths(
            sanitizeMessage(
              sanitizeMessage(
                redactKnownValue(result.message, result.binary),
                runtime.workspaceCwd,
              ),
              result.gitRoot,
            ),
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

  app.get(
    '/workspaces/:workspace/github/prs/:number/files',
    async (req, res) => {
      const route = 'GET /workspaces/:workspace/github/prs/:number/files';
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return;

      const number = Number(req.params['number']);
      if (!Number.isInteger(number) || number <= 0) {
        res.status(400).json({
          errorKind: 'parse_error',
          error: 'PR number must be a positive integer',
          status: 400,
        });
        return;
      }

      const cwd = await resolveSessionManagedGitCwdForRoute(
        req,
        res,
        runtime,
        route,
        deps.sendBridgeError,
      );
      if (cwd === undefined) return;

      // Optional [host/]owner/repo of the bound PR when it lives in a different
      // repository (or on an Enterprise host) than the session checkout.
      // Distinguish absent (resolve the number in the session's repo) from
      // supplied-but-unusable: a repeated key parses to an array and an empty
      // value is not a slug, so reject both rather than silently dropping them
      // and answering with a same-numbered local PR. The core helper validates
      // the slug before `gh --repo`.
      const rawRepo = req.query['repo'];
      let repo: string | undefined;
      if (rawRepo !== undefined) {
        if (typeof rawRepo !== 'string' || rawRepo === '') {
          res.status(400).json({
            errorKind: 'parse_error',
            error: 'repo must be a non-empty [host/]owner/repo slug',
            status: 400,
          });
          return;
        }
        repo = rawRepo;
      }

      applyReadHeaders(res);
      try {
        const result = await getPrFiles(
          cwd,
          number,
          runtime.env.effectiveEnv,
          repo,
        );
        switch (result.kind) {
          case 'ok':
            res.status(200).json({
              v: 1,
              workspaceCwd: runtime.workspaceCwd,
              available: true,
              ...result.files,
            });
            return;
          case 'not_a_repo':
            res.status(200).json({
              v: 1,
              workspaceCwd: runtime.workspaceCwd,
              available: false,
              files: [],
              hiddenCount: 0,
              additions: 0,
              deletions: 0,
              headSha: '',
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
            // A malformed slug is a caller error, not a gh failure: the core
            // helper refuses it before any process starts. Classify by the
            // machine-readable reason, not the prose — a reword of the message
            // must not silently turn this into a retryable 502.
            if (result.reason === 'invalid_repo') {
              res.status(400).json({
                errorKind: 'parse_error',
                error: 'repo must be a valid [host/]owner/repo slug',
                status: 400,
              });
              return;
            }
            debugLogger.debug('GitHub PR files failed', {
              workspaceCwd: runtime.workspaceCwd,
              gitRoot: result.gitRoot,
              message: result.message,
            });
            const error = sweepAbsolutePaths(
              sanitizeMessage(
                sanitizeMessage(
                  redactKnownValue(result.message, result.binary),
                  runtime.workspaceCwd,
                ),
                result.gitRoot,
              ),
            ).slice(0, GITHUB_PR_ERROR_MESSAGE_MAX);
            res.status(502).json({
              error,
              code: 'github_pr_files_failed',
              status: 502,
            });
            return;
          }
          default:
            throw new Error(
              `unexpected fetchGitHubPullRequestFiles result: ${JSON.stringify(result)}`,
            );
        }
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

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

      const cwd = await resolveSessionManagedGitCwdForRoute(
        req,
        res,
        runtime,
        route,
        deps.sendBridgeError,
      );
      if (cwd === undefined) return;

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
            // Raw text stays server-side; the wire body is redacted.
            debugLogger.debug('GitHub PR create failed', {
              workspaceCwd: runtime.workspaceCwd,
              gitRoot: result.gitRoot,
              message: result.message,
            });
            // Sanitize both the workspace cwd and the git root (gh runs at the
            // git root, which may be a parent of the workspace) before truncating.
            res.status(502).json({
              error: sweepAbsolutePaths(
                sanitizeMessage(
                  sanitizeMessage(
                    redactKnownValue(result.message, result.binary),
                    runtime.workspaceCwd,
                  ),
                  result.gitRoot,
                ),
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
