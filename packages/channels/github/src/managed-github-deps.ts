/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Octokit } from '@octokit/rest';
import type {
  ManagedGithubAdapterDeps,
  ManagedGithubClient,
  GithubSettings,
  GithubSendFailure,
} from './managed-github-adapter.js';

// H5f of #12827: the production dependencies of the managed GitHub adapter.
// Token auth and configurable baseUrl mirror the Legacy channel; the egress
// proxy does NOT mirror the Legacy `request.agent` line — @octokit/request v9
// is fetch-era and never reads that option (the Legacy channel is saved only
// by its launcher's global dispatcher). Instead a per-client undici dispatcher
// rides the honoured `request.fetch` hook, scoped to GitHub traffic so the
// control-plane HTTP stays direct — the DingTalk deps' decision. The
// send-failure classification mirrors the Legacy publication audit's
// at-most-once semantics on the managed receipt vocabulary: a provably-unwritten
// definitive refusal is `rejected`, everything ambiguous (rate limits, 5xx,
// network) is `unknown` for the lease reconciler to settle.

const SECONDARY_RATE_LIMIT_MESSAGE = /secondary rate limit|abuse detection/i;
// Mirror the Legacy guard (GithubAdapter.ts MAX_TIMER_DELAY_MS): a hint above
// Node's 32-bit timer limit is clamped to ~1 ms, turning a rate-limit cooldown
// into an immediate retry storm against the already-limited endpoint.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface GithubRequestError {
  status?: number;
  message?: unknown;
  response?: { headers?: Record<string, string | number> };
}

function parseRateLimitCount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  return typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : undefined;
}

function rateLimitRemaining(err: unknown): number | undefined {
  return parseRateLimitCount(
    (err as GithubRequestError).response?.headers?.['x-ratelimit-remaining'],
  );
}

/**
 * A 403 or 429 carrying one of GitHub's rate-limit signals: an exhausted
 * budget, `retry-after`, or the secondary-limit wording. Same shape as the
 * Legacy classifier; no single signal is required.
 */
function isRateLimitAnswer(err: unknown): boolean {
  const e = err as GithubRequestError;
  return (
    (e.status === 403 || e.status === 429) &&
    (rateLimitRemaining(err) === 0 ||
      e.response?.headers?.['retry-after'] !== undefined ||
      SECONDARY_RATE_LIMIT_MESSAGE.test(String(e.message)))
  );
}

/**
 * How long a rate-limit answer asks to wait: a positive `retry-after`, or a
 * future `x-ratelimit-reset` when the budget is exhausted.
 */
function rateLimitWaitHintMs(err: unknown): number | undefined {
  const headers = (err as GithubRequestError)?.response?.headers;
  if (!headers) return undefined;
  const retryAfter = Number(headers['retry-after'] ?? NaN);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (rateLimitRemaining(err) !== 0) return undefined;
  const untilReset = Number(headers['x-ratelimit-reset']) * 1000 - Date.now();
  return Number.isFinite(untilReset) && untilReset > 0 ? untilReset : undefined;
}

/**
 * The send verdict. Definitive (provably unwritten, permanent): credential
 * failure, a gone or inaccessible thread, a validation refusal, a legal
 * block. A rate-limit answer is provably unwritten but transient, so it
 * follows the DingTalk transient→unknown rule instead of terminating the
 * reply. 5xx, network failures and anything unclassified stay unknown.
 */
function isDefinitiveSendRefusal(err: unknown): boolean {
  const status = (err as GithubRequestError).status;
  if (status === 401 || status === 404 || status === 410) return true;
  if (status === 422 || status === 451) return true;
  if (status === 403) return !isRateLimitAnswer(err);
  return false;
}

/**
 * Per-thread read verdicts a retry cannot heal: the thread is gone or the
 * token lost access (the Legacy classifyThreadFailure "permanent" arm).
 * 401/408/429 and rate-limit answers stay transient — they are shared or
 * retryable, and dropping threads on them would consume notifications while
 * the real problem is global.
 */
export function isDefinitiveGithubReadFailure(err: unknown): boolean {
  const status = (err as GithubRequestError).status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 408 &&
    // 429 is a rate limit by status alone: GitHub (or a proxy in front of it)
    // may send it without retry-after or budget headers. The Legacy
    // classifyThreadFailure treats it as shared unconditionally; dropping a
    // thread on a bare 429 would consume notifications during a global limit.
    status !== 429 &&
    !isRateLimitAnswer(err)
  );
}

function sendFailure(message: string, definitive: boolean): GithubSendFailure {
  const failure = new Error(message) as GithubSendFailure;
  failure.definitive = definitive;
  return failure;
}

async function createClient(
  settings: GithubSettings,
  proxy?: string,
): Promise<ManagedGithubClient> {
  let dispatcher: import('undici').Dispatcher | undefined;
  if (proxy) {
    // Read the constructor off the default namespace: in the bundled CLI a
    // dynamic import of the CJS undici package is default-only, so a named
    // destructure would bind undefined (the DingTalk deps use this shape).
    const { default: undici } = await import('undici');
    dispatcher = new undici.EnvHttpProxyAgent({
      httpProxy: proxy,
      httpsProxy: proxy,
    });
  }
  const octokit = new Octokit({
    auth: settings.token,
    baseUrl: settings.baseUrl,
    ...(dispatcher
      ? {
          request: {
            fetch: (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
              fetch(url, {
                ...init,
                dispatcher,
              } as RequestInit),
          },
        }
      : {}),
  });
  // Two separate quantities, as in the Legacy channel: a duration floor from
  // X-Poll-Interval, and an absolute cooldown deadline from rate-limit hints.
  // Storing the hint as a never-expiring duration would let one skewed
  // x-ratelimit-reset or bogus retry-after pin the tick loop for weeks.
  let pollFloorMs = 0;
  let waitUntilMs = 0;
  octokit.hook.wrap('request', async (request, options) => {
    try {
      const response = await request(options);
      const poll = Number(response.headers['x-poll-interval']);
      if (Number.isFinite(poll) && poll > 0) pollFloorMs = poll * 1000;
      return response;
    } catch (error) {
      const wait = rateLimitWaitHintMs(error);
      if (wait !== undefined) {
        waitUntilMs = Math.max(waitUntilMs, Date.now() + wait);
      }
      throw error;
    }
  });
  return {
    resolveIdentity: async () => {
      try {
        const { data } = await octokit.rest.users.getAuthenticated();
        return data.login;
      } catch {
        // Never echo the provider error: it can carry request detail. The
        // first connect must still surface the failure (a bad token creates
        // no usable client).
        throw new Error(
          'GitHub identity resolution failed; check the token and network.',
        );
      }
    },
    listNotifications: async (since) => {
      const notifications = await octokit.paginate(
        octokit.rest.activity.listNotificationsForAuthenticatedUser,
        { since, per_page: 100 },
      );
      return notifications.map((notification) => ({
        id: String(notification.id),
        reason: notification.reason,
        updated_at: notification.updated_at,
        subject: {
          title: notification.subject.title ?? undefined,
          url: notification.subject.url ?? undefined,
          type: notification.subject.type,
        },
      }));
    },
    listComments: async (owner, repo, issueNumber, since) => {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        { owner, repo, issue_number: issueNumber, since, per_page: 100 },
      );
      return comments.map((comment) => ({
        id: comment.id,
        node_id: comment.node_id,
        body: comment.body,
        created_at: comment.created_at,
        user: comment.user ? { login: comment.user.login } : null,
      }));
    },
    markThreadRead: async (threadId) => {
      const id = Number(threadId);
      if (!Number.isSafeInteger(id)) {
        // Fail loudly rather than putting NaN in the URL.
        throw new Error(
          `GitHub notification thread id is not numeric: ${threadId}`,
        );
      }
      await octokit.rest.activity.markThreadAsRead({ thread_id: id });
    },
    postComment: async (owner, repo, issueNumber, body) => {
      try {
        const { data } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body,
        });
        return { id: data.id };
      } catch (error) {
        const status = (error as GithubRequestError).status;
        throw sendFailure(
          `GitHub comment send failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}.`,
          isDefinitiveSendRefusal(error),
        );
      }
    },
    pollIntervalFloorMs: () =>
      Math.min(
        Math.max(pollFloorMs, waitUntilMs - Date.now(), 0),
        MAX_TIMER_DELAY_MS,
      ),
    disconnect: () => {
      dispatcher?.destroy();
    },
  };
}

/** The production dependencies of the managed GitHub adapter. */
export function createManagedGithubDeps(
  proxy?: string,
): ManagedGithubAdapterDeps {
  return {
    createClient: (settings) => createClient(settings, proxy),
    lock: async (directory, onCompromised) => {
      const { default: lockfile } = await import('proper-lockfile');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return lockfile.lock(directory, { retries: 0, onCompromised });
    },
  };
}
