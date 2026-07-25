/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubPullRequests } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceQualifiedGitHubPrsRoutes } from './workspace-github-prs.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  fetchGitHubPullRequests: vi.fn(),
}));

const fetchGitHubPullRequestsMock = vi.mocked(fetchGitHubPullRequests);

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted: boolean,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    bridge: { publishWorkspaceEvent: vi.fn() } as unknown as AcpSessionBridge,
  } as WorkspaceRuntime;
}

function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return createWorkspaceRegistry(runtimes);
}

function mount(deps: { cacheTtlMs?: number } = {}) {
  const app = express();
  registerWorkspaceQualifiedGitHubPrsRoutes(app, {
    workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
    sendBridgeError,
    ...deps,
  });
  return app;
}

const PR = {
  number: 42,
  title: 'Add a thing',
  url: 'https://github.com/o/r/pull/42',
  author: 'octocat',
  headRefName: 'feat/thing',
  state: 'open' as const,
  reviewDecision: 'approved' as const,
  checks: 'passing' as const,
  updatedAt: 1_800_000_000,
};

describe('workspace GitHub PR routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists pull requests for the selected trusted workspace', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [PR],
    });
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const secondary = runtime('secondary', '/work/secondary', true);
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([primary, secondary]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/secondary/github/prs');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/secondary',
      available: true,
      pullRequests: [PR],
    });
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledWith('/work/secondary');
  });

  it('returns available:false when the workspace is not a git repository', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      available: false,
      pullRequests: [],
    });
  });

  it('rejects an untrusted workspace before calling gh', async () => {
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([
        runtime('primary', '/work/main', true),
        runtime('untrusted', '/work/untrusted', false),
      ]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/untrusted/github/prs');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown workspace before calling gh', async () => {
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/missing/github/prs');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('workspace_mismatch');
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
  });

  it('maps a missing gh binary to github_cli_unavailable', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('github_cli_unavailable');
  });

  it('maps gh failures to github_prs_failed and sanitizes workspace paths', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message: 'fatal: /work/main is not a GitHub remote',
      gitRoot: '/work/main',
    });
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      error: 'fatal: <workspace> is not a GitHub remote',
      code: 'github_prs_failed',
    });
    expect(response.body.error).not.toContain('/work/main');
  });

  it('sanitizes a path straddling the display cap before truncating', async () => {
    const gitRoot = '/work/main';
    // Place the git root across the 512-char display boundary; the route must
    // redact it before truncating, not cut it off mid-token.
    const message = 'e'.repeat(505) + gitRoot + ' denied';
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message,
      gitRoot,
    });
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('github_prs_failed');
    expect(response.body.error).not.toContain(gitRoot);
    expect(response.body.error.length).toBeLessThanOrEqual(512);
  });

  it('falls back to the bridge error mapper on unexpected throws', async () => {
    fetchGitHubPullRequestsMock.mockRejectedValue(new Error('boom'));
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('boom');
  });
});

describe('workspace GitHub PR routes — caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves a cached ok result within the TTL without re-running gh', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [PR],
    });
    const app = mount({ cacheTtlMs: 60_000 });

    const first = await request(app).get('/workspaces/primary/github/prs');
    const second = await request(app).get('/workspaces/primary/github/prs');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.pullRequests).toEqual([PR]);
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);
  });

  it('reloads on every request when the TTL is 0', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [PR],
    });
    const app = mount({ cacheTtlMs: 0 });

    await request(app).get('/workspaces/primary/github/prs');
    await request(app).get('/workspaces/primary/github/prs');

    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed result (the next open retries gh)', async () => {
    fetchGitHubPullRequestsMock
      .mockResolvedValueOnce({
        kind: 'failed',
        message: 'gh: not logged in',
        gitRoot: '/work/main',
      })
      .mockResolvedValueOnce({ kind: 'ok', pullRequests: [PR] });
    const app = mount({ cacheTtlMs: 60_000 });

    const first = await request(app).get('/workspaces/primary/github/prs');
    expect(first.status).toBe(502);
    expect(first.body.code).toBe('github_prs_failed');

    const second = await request(app).get('/workspaces/primary/github/prs');
    expect(second.status).toBe(200);
    expect(second.body.pullRequests).toEqual([PR]);
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent opens onto a single in-flight gh load', async () => {
    let calls = 0;
    let resolveLoad: (r: {
      kind: 'ok';
      pullRequests: Array<typeof PR>;
    }) => void = () => {};
    const gate = new Promise<{ kind: 'ok'; pullRequests: Array<typeof PR> }>(
      (r) => {
        resolveLoad = r;
      },
    );
    fetchGitHubPullRequestsMock.mockImplementation(() => {
      calls++;
      return gate;
    });
    // TTL 0 would normally reload each request; the pending load must still be
    // shared so two concurrent opens spawn gh once. `.then` forces supertest to
    // send now (it is otherwise lazy), so both handlers reach getPullRequests
    // while the single load is still pending.
    const app = mount({ cacheTtlMs: 0 });

    const p1 = request(app)
      .get('/workspaces/primary/github/prs')
      .then((r) => r);
    const p2 = request(app)
      .get('/workspaces/primary/github/prs')
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    resolveLoad({ kind: 'ok', pullRequests: [PR] });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls).toBe(1);
  });
});
