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
