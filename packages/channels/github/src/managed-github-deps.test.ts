/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type IncomingMessage } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedGithubDeps } from './managed-github-deps.js';
import type {
  GithubSendFailure,
  GithubSettings,
} from './managed-github-adapter.js';

const SETTINGS: GithubSettings = {
  token: 'ghp_secret_token',
  baseUrl: 'http://127.0.0.1:0', // replaced per test
  pollInterval: 60_000,
};

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

async function fakeGithub(
  handler: (
    method: string,
    url: string,
    body: unknown,
  ) => Answer | Promise<Answer>,
) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method!, url: req.url!, body });
      void Promise.resolve(handler(req.method!, req.url!, body)).then(
        (answer) => {
          res.writeHead(answer.status, {
            'content-type': 'application/json',
            ...answer.headers,
          });
          res.end(JSON.stringify(answer.body ?? {}));
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function clientFor(
  handler: (
    method: string,
    url: string,
    body: unknown,
  ) => Answer | Promise<Answer>,
) {
  const github = await fakeGithub(handler);
  cleanups.push(github.close);
  const deps = createManagedGithubDeps();
  const client = await deps.createClient({
    ...SETTINGS,
    baseUrl: github.baseUrl,
  });
  cleanups.push(async () => client.disconnect());
  return { client, github };
}

describe('managed GitHub deps against a fake GitHub endpoint', () => {
  it('resolves the bot identity and redacts a credential failure', async () => {
    const ok = await clientFor(() => ({
      status: 200,
      body: { login: 'bot-user' },
    }));
    expect(await ok.client.resolveIdentity()).toBe('bot-user');

    const bad = await clientFor(() => ({
      status: 401,
      body: { message: 'Bad credentials' },
    }));
    const failure = await bad.client.resolveIdentity().catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure.message)).toMatch(/identity resolution failed/);
    expect(String(failure.message)).not.toContain(SETTINGS.token);
  });

  it('paginates notifications, passes since and reads the poll floor', async () => {
    const { client, github } = await clientFor((method, url) => {
      const page = new URL(url, 'http://x').searchParams.get('page') ?? '1';
      if (page === '1') {
        return {
          status: 200,
          headers: {
            'x-poll-interval': '90',
            link: `<${github.baseUrl}/notifications?page=2>; rel="next"`,
          },
          body: [
            {
              id: 1,
              reason: 'mention',
              updated_at: '2026-11-16T10:00:00Z',
              subject: {
                title: 'One',
                url: `${github.baseUrl}/repos/o/r/issues/1`,
                type: 'Issue',
              },
            },
          ],
        };
      }
      return {
        status: 200,
        body: [
          {
            id: 2,
            reason: 'comment',
            updated_at: '2026-11-16T10:01:00Z',
            subject: { title: 'Two', url: null, type: 'Issue' },
          },
        ],
      };
    });
    const notifications = await client.listNotifications(
      '2026-11-16T09:59:00Z',
    );
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toEqual({
      id: '1',
      reason: 'mention',
      updated_at: '2026-11-16T10:00:00Z',
      subject: {
        title: 'One',
        url: `${github.baseUrl}/repos/o/r/issues/1`,
        type: 'Issue',
      },
    });
    expect(notifications[1]!.subject.url).toBeUndefined();
    expect(github.requests[0]!.url).toContain('since=2026-11-16T09%3A59%3A00Z');
    expect(client.pollIntervalFloorMs()).toBe(90_000);
  });

  it('lists comments with the since window and marks a thread read', async () => {
    const { client, github } = await clientFor((method, _url) => {
      if (method === 'PATCH') return { status: 205 };
      return {
        status: 200,
        body: [
          {
            id: 101,
            node_id: 'IC_101',
            body: '@bot-user hi',
            created_at: '2026-11-16T09:59:00Z',
            user: { login: 'Alice' },
          },
        ],
      };
    });
    const comments = await client.listComments(
      'Owner',
      'Repo',
      7,
      '2026-11-16T09:59:00Z',
    );
    expect(comments).toEqual([
      {
        id: 101,
        node_id: 'IC_101',
        body: '@bot-user hi',
        created_at: '2026-11-16T09:59:00Z',
        user: { login: 'Alice' },
      },
    ]);
    expect(github.requests[0]!.url).toContain(
      '/repos/Owner/Repo/issues/7/comments',
    );
    expect(github.requests[0]!.url).toContain('since=');
    await client.markThreadRead('123');
    expect(github.requests[1]).toMatchObject({
      method: 'PATCH',
      url: '/notifications/threads/123',
    });
  });

  it('posts a comment and returns the real platform id', async () => {
    const { client, github } = await clientFor(() => ({
      status: 201,
      body: { id: 9001 },
    }));
    expect(await client.postComment('Owner', 'Repo', 7, 'reply text')).toEqual({
      id: 9001,
    });
    expect(github.requests[0]).toMatchObject({
      method: 'POST',
      url: '/repos/Owner/Repo/issues/7/comments',
      body: { body: 'reply text' },
    });
  });

  const refusalCases: Array<{
    label: string;
    status: number;
    headers: Record<string, string>;
    definitive: boolean;
    body?: unknown;
  }> = [
    { label: 'validation', status: 422, headers: {}, definitive: true },
    { label: 'gone thread', status: 404, headers: {}, definitive: true },
    { label: 'credential', status: 401, headers: {}, definitive: true },
    {
      label: 'permission',
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999' },
      definitive: true,
    },
    {
      label: 'primary rate limit',
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
      definitive: false,
    },
    {
      label: 'secondary rate limit',
      status: 403,
      headers: { 'x-ratelimit-remaining': '50' },
      definitive: false,
      body: { message: 'You have exceeded a secondary rate limit' },
    },
    {
      label: 'too many requests',
      status: 429,
      headers: { 'retry-after': '30' },
      definitive: false,
    },
    { label: 'server error', status: 500, headers: {}, definitive: false },
  ];
  it.each(refusalCases)(
    'classifies a $label send refusal (definitive=$definitive)',
    async ({ status, headers, definitive, body }) => {
      const { client } = await clientFor(() => ({
        status,
        headers,
        body: body ?? { message: 'refused' },
      }));
      const failure = (await client
        .postComment('Owner', 'Repo', 7, 'reply')
        .catch((error) => error)) as GithubSendFailure;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.definitive).toBe(definitive);
      if (headers['retry-after'] === '30') {
        // The cooldown is an absolute deadline; a few ms elapse between the
        // request and the assertion.
        expect(client.pollIntervalFloorMs()).toBeGreaterThanOrEqual(29_000);
      }
    },
  );

  it('classifies a network failure as ambiguous', async () => {
    const github = await fakeGithub(() => ({ status: 200, body: {} }));
    const deps = createManagedGithubDeps();
    const client = await deps.createClient({
      ...SETTINGS,
      baseUrl: github.baseUrl,
    });
    await github.close();
    const failure = (await client
      .postComment('Owner', 'Repo', 7, 'reply')
      .catch((error) => error)) as GithubSendFailure;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.definitive).toBe(false);
    client.disconnect();
  });

  it('caps the poll floor at the 32-bit timer limit on every hint path', async () => {
    // Above 2^31-1 ms Node clamps the delay to ~1 ms, turning a rate-limit
    // cooldown into a retry storm; the Legacy channel caps the same hints.
    // Each far-future hint is asserted at EXACTLY the cap, not merely below
    // it: an upper bound alone would also pass if the hint were ignored and
    // the floor stayed 0, so the exact value pins honoring AND capping.
    const retryAfter = await clientFor(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '10000000000' },
      body: { message: 'rate limited' },
    }));
    await retryAfter.client
      .postComment('Owner', 'Repo', 7, 'reply')
      .catch(() => undefined);
    expect(retryAfter.client.pollIntervalFloorMs()).toBe(2_147_483_647);

    const farReset = Math.floor(Date.now() / 1000) + 100_000_000;
    const reset = await clientFor(() => ({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(farReset),
      },
      body: { message: 'rate limited' },
    }));
    await reset.client
      .postComment('Owner', 'Repo', 7, 'reply')
      .catch(() => undefined);
    expect(reset.client.pollIntervalFloorMs()).toBe(2_147_483_647);

    const pollHeader = await clientFor(() => ({
      status: 200,
      headers: { 'x-poll-interval': '10000000000' },
      body: [],
    }));
    await pollHeader.client.listNotifications('2026-11-16T09:59:00Z');
    expect(pollHeader.client.pollIntervalFloorMs()).toBe(2_147_483_647);
  });

  it('routes GitHub traffic through the egress proxy, never direct', async () => {
    // @octokit/request v9 reads request.fetch, not the pre-fetch request.agent
    // option — an inert agent would go direct and fail in a proxy-only
    // deployment. Prove the wire path: undici's EnvHttpProxyAgent tunnels via
    // CONNECT, so the proxy must observe the tunnel to the target authority
    // and the target answers through it. NO_PROXY is stubbed because the host
    // exempts loopback.
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const target = await fakeGithub(() => ({
      status: 200,
      body: { login: 'tunneled-bot' },
    }));
    const targetPort = Number(new URL(target.baseUrl).port);
    const connects: string[] = [];
    const proxyServer = createServer((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    proxyServer.on('connect', (req, clientSocket, head) => {
      connects.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    const proxyPort = await new Promise<number>((resolve) =>
      proxyServer.listen(0, '127.0.0.1', () =>
        resolve((proxyServer.address() as { port: number }).port),
      ),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          proxyServer.close(() => resolve());
          proxyServer.closeAllConnections();
        }),
    );
    const deps = createManagedGithubDeps(`http://127.0.0.1:${proxyPort}`);
    const client = await deps.createClient({
      ...SETTINGS,
      baseUrl: target.baseUrl,
    });
    cleanups.push(async () => client.disconnect());
    expect(await client.resolveIdentity()).toBe('tunneled-bot');
    // The tunnel went through the proxy to the target authority; a direct
    // request would have left the proxy's CONNECT log empty.
    expect(connects).toEqual([`127.0.0.1:${targetPort}`]);
    expect(target.requests).toHaveLength(1);
  });

  it('destroys the proxy dispatcher on disconnect', async () => {
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const target = await fakeGithub(() => ({
      status: 200,
      body: { login: 'tunneled-bot' },
    }));
    const proxyServer = createServer((_req, res) => {
      res.writeHead(400);
      res.end();
    });
    proxyServer.on('connect', (req, clientSocket, head) => {
      const [host, port] = (req.url ?? '').split(':');
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    const proxyPort = await new Promise<number>((resolve) =>
      proxyServer.listen(0, '127.0.0.1', () =>
        resolve((proxyServer.address() as { port: number }).port),
      ),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          proxyServer.close(() => resolve());
          proxyServer.closeAllConnections();
        }),
    );
    const deps = createManagedGithubDeps(`http://127.0.0.1:${proxyPort}`);
    const client = await deps.createClient({
      ...SETTINGS,
      baseUrl: target.baseUrl,
    });
    expect(await client.resolveIdentity()).toBe('tunneled-bot');
    client.disconnect();
    await expect(client.resolveIdentity()).rejects.toThrow();
  });

  it('refuses a non-numeric notification thread id loudly', async () => {
    const { client } = await clientFor(() => ({ status: 205 }));
    await expect(client.markThreadRead('not-numeric')).rejects.toThrow(
      /not numeric/,
    );
  });

  it('lets a rate-limit cooldown expire instead of pinning the loop', async () => {
    // The hint is an absolute deadline, not a never-expiring duration: one
    // skewed reset or bogus retry-after must not silence polling for weeks.
    const { client } = await clientFor(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '3600' },
      body: { message: 'rate limited' },
    }));
    await client
      .postComment('Owner', 'Repo', 7, 'reply')
      .catch(() => undefined);
    expect(client.pollIntervalFloorMs()).toBeGreaterThanOrEqual(3_599_000);
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 3_600_001);
    try {
      expect(client.pollIntervalFloorMs()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    // The X-Poll-Interval duration floor is independent of the clock.
    const polled = await clientFor(() => ({
      status: 200,
      headers: { 'x-poll-interval': '60' },
      body: [],
    }));
    await polled.client.listNotifications('2026-11-16T09:59:00Z');
    const spy2 = vi.spyOn(Date, 'now').mockReturnValue(realNow + 86_400_000);
    try {
      expect(polled.client.pollIntervalFloorMs()).toBe(60_000);
    } finally {
      spy2.mockRestore();
    }
  });

  it('serializes managed instances of one state directory with a lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-github-lock-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const deps = createManagedGithubDeps();
    const release = await deps.lock(dir, () => {});
    await expect(deps.lock(dir, () => {})).rejects.toThrow();
    await release();
    const second = await deps.lock(dir, () => {});
    await second();
  });

  it('reads the PR baseline and maps a computing mergeability to undefined', async () => {
    const { client, github } = await clientFor(() => ({
      status: 200,
      body: {
        head: { sha: 'sha-a' },
        mergeable: true,
        mergeable_state: 'clean',
        state: 'open',
      },
    }));
    expect(await client.getPullRequest('Owner', 'Repo', 9)).toEqual({
      headSha: 'sha-a',
      mergeable: true,
      mergeableState: 'clean',
      state: 'open',
    });
    expect(github.requests[0]!.url).toContain('/repos/Owner/Repo/pulls/9');

    const computing = await clientFor(() => ({
      status: 200,
      body: {
        head: { sha: 'sha-a' },
        mergeable: null,
        mergeable_state: 'unknown',
        state: 'open',
      },
    }));
    expect(
      await computing.client.getPullRequest('Owner', 'Repo', 9),
    ).toMatchObject({ mergeable: null, mergeableState: undefined });

    // Empty strings normalize to absent: the state validator refuses an
    // empty baseline field, so the writer must never persist one.
    const empty = await clientFor(() => ({
      status: 200,
      body: {
        head: { sha: '' },
        mergeable: false,
        mergeable_state: '',
        state: 'open',
      },
    }));
    expect(await empty.client.getPullRequest('Owner', 'Repo', 9)).toMatchObject(
      { headSha: undefined, mergeableState: undefined },
    );
  });

  it('aggregates a failing check run and skips the decided combined status', async () => {
    const { client, github } = await clientFor((_method, url) => {
      if (url.includes('/check-runs')) {
        return {
          status: 200,
          body: {
            total_count: 2,
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'failure' },
              { name: 'lint', status: 'completed', conclusion: 'success' },
            ],
          },
        };
      }
      return { status: 200, body: { state: 'success', total_count: 1 } };
    });
    expect(await client.getCiStatus('Owner', 'Repo', 'sha-a')).toEqual({
      aggregate: 'failing',
      failedChecks: ['build'],
      namesIncomplete: false,
    });
    // A failure decides the aggregate: the combined status is never fetched.
    expect(github.requests.map((r) => r.url)).toEqual([
      expect.stringContaining('/repos/Owner/Repo/commits/sha-a/check-runs'),
    ]);
  });

  it('flags the failed-check list incomplete when the early stop leaves unread pages', async () => {
    // Page 1 carries a failure and a next-page link: the aggregate is decided
    // and paging stops, but the names handed to the agent are only page 1's.
    const withNext = await clientFor((_method, url) => {
      if (url.includes('/check-runs')) {
        return {
          status: 200,
          headers: {
            link: '<https://api.github.com/repositories/1/check-runs?page=2>; rel="next"',
          },
          body: {
            total_count: 150,
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'failure' },
            ],
          },
        };
      }
      return { status: 200, body: { state: 'success', total_count: 0 } };
    });
    expect(
      await withNext.client.getCiStatus('Owner', 'Repo', 'sha-a'),
    ).toMatchObject({ aggregate: 'failing', namesIncomplete: true });
    // No next page: the single page is the whole list, so no marker.
    const noNext = await clientFor((_method, url) => {
      if (url.includes('/check-runs')) {
        return {
          status: 200,
          body: {
            total_count: 1,
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'failure' },
            ],
          },
        };
      }
      return { status: 200, body: { state: 'success', total_count: 0 } };
    });
    expect(
      await noNext.client.getCiStatus('Owner', 'Repo', 'sha-a'),
    ).toMatchObject({ aggregate: 'failing', namesIncomplete: false });
  });

  it('counts cancelled and stale runs as failing (the daemon CI definition)', async () => {
    for (const conclusion of ['cancelled', 'stale', 'startup_failure']) {
      const { client } = await clientFor((_method, url) => {
        if (url.includes('/check-runs')) {
          return {
            status: 200,
            body: {
              total_count: 1,
              check_runs: [{ name: 'run', status: 'completed', conclusion }],
            },
          };
        }
        return { status: 200, body: { state: 'success', total_count: 0 } };
      });
      expect(
        (await client.getCiStatus('Owner', 'Repo', 'sha-a')).aggregate,
      ).toBe('failing');
    }
  });

  it('aggregates pending, passing and none across checks and combined status', async () => {
    const cases: Array<{
      label: string;
      runs: Array<{ status: string; conclusion?: string | null }>;
      combined: { state: string; total_count: number };
      aggregate: string;
    }> = [
      {
        label: 'in-flight run',
        runs: [{ status: 'in_progress' }],
        combined: { state: 'success', total_count: 0 },
        aggregate: 'pending',
      },
      {
        label: 'completed without conclusion',
        runs: [{ status: 'completed', conclusion: null }],
        combined: { state: 'success', total_count: 0 },
        aggregate: 'pending',
      },
      {
        label: 'green checks',
        runs: [{ status: 'completed', conclusion: 'success' }],
        combined: { state: 'success', total_count: 0 },
        aggregate: 'passing',
      },
      {
        label: 'neutral and skipped count as passing',
        runs: [
          { status: 'completed', conclusion: 'neutral' },
          { status: 'completed', conclusion: 'skipped' },
        ],
        combined: { state: 'success', total_count: 0 },
        aggregate: 'passing',
      },
      {
        label: 'no CI at all',
        runs: [],
        combined: { state: 'pending', total_count: 0 },
        aggregate: 'none',
      },
      {
        label: 'combined failure decides over green checks',
        runs: [{ status: 'completed', conclusion: 'success' }],
        combined: { state: 'failure', total_count: 2 },
        aggregate: 'failing',
      },
      {
        label: 'combined error decides over green checks',
        runs: [{ status: 'completed', conclusion: 'success' }],
        combined: { state: 'error', total_count: 1 },
        aggregate: 'failing',
      },
      {
        label: 'combined pending keeps the head pending',
        runs: [{ status: 'completed', conclusion: 'success' }],
        combined: { state: 'pending', total_count: 1 },
        aggregate: 'pending',
      },
      {
        label: 'combined success passes a check-less head',
        runs: [],
        combined: { state: 'success', total_count: 1 },
        aggregate: 'passing',
      },
    ];
    for (const { label, runs, combined, aggregate } of cases) {
      const { client } = await clientFor((_method, url) => {
        if (url.includes('/check-runs')) {
          return {
            status: 200,
            body: { total_count: runs.length, check_runs: runs },
          };
        }
        return { status: 200, body: combined };
      });
      expect(
        (await client.getCiStatus('Owner', 'Repo', 'sha-a')).aggregate,
        label,
      ).toBe(aggregate);
    }
  });

  it('stops paging checks once a failure decides the aggregate', async () => {
    const { client, github } = await clientFor((_method, url) => {
      const page = new URL(url, 'http://x').searchParams.get('page') ?? '1';
      if (url.includes('/check-runs') && page === '1') {
        return {
          status: 200,
          headers: {
            link: `<${github.baseUrl}/repos/Owner/Repo/commits/sha-a/check-runs?page=2>; rel="next"`,
          },
          body: {
            total_count: 200,
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'failure' },
            ],
          },
        };
      }
      return {
        status: 200,
        body: { total_count: 0, check_runs: [] },
      };
    });
    expect((await client.getCiStatus('Owner', 'Repo', 'sha-a')).aggregate).toBe(
      'failing',
    );
    expect(
      github.requests.filter((r) => r.url.includes('page=2')),
    ).toHaveLength(0);
  });

  it('caps the reported failed-check names and their length', async () => {
    const { client } = await clientFor((_method, url) => {
      if (url.includes('/check-runs')) {
        return {
          status: 200,
          body: {
            total_count: 7,
            check_runs: Array.from({ length: 7 }, (_, i) => ({
              name: i === 0 ? 'x'.repeat(300) : `check-${i}`,
              status: 'completed',
              conclusion: 'failure',
            })),
          },
        };
      }
      return { status: 200, body: { state: 'success', total_count: 0 } };
    });
    const { failedChecks } = await client.getCiStatus('Owner', 'Repo', 'sha-a');
    expect(failedChecks).toHaveLength(5);
    expect(failedChecks[0]).toHaveLength(200);
  });

  it('rides the poll-floor hook on a rate-limited PR read', async () => {
    const { client } = await clientFor(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
      body: { message: 'rate limited' },
    }));
    const failure = await client
      .getPullRequest('Owner', 'Repo', 9)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { status?: number }).status).toBe(403);
    expect(client.pollIntervalFloorMs()).toBeGreaterThanOrEqual(29_000);
  });
});
