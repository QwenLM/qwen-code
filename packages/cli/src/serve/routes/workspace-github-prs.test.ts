/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubPullRequest,
  fetchGitHubPullRequests,
  fetchGitHubPullRequestFiles,
  getDefaultBranch,
  type FetchGitHubPullRequestFilesResult,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceQualifiedGitHubPrsRoutes } from './workspace-github-prs.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  createGitHubPullRequest: vi.fn(),
  fetchGitHubPullRequests: vi.fn(),
  fetchGitHubPullRequestFiles: vi.fn(),
  getDefaultBranch: vi.fn(),
}));

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/utils/debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

const createGitHubPullRequestMock = vi.mocked(createGitHubPullRequest);
const fetchGitHubPullRequestsMock = vi.mocked(fetchGitHubPullRequests);
const fetchGitHubPullRequestFilesMock = vi.mocked(fetchGitHubPullRequestFiles);
const getDefaultBranchMock = vi.mocked(getDefaultBranch);

const passthroughMutate = () =>
  ((_req: unknown, _res: unknown, next: () => void) => next()) as never;

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted: boolean,
  effectiveEnv?: Record<string, string | undefined>,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    env: {
      mode: 'parent-process',
      overlayKeys: [],
      ...(effectiveEnv !== undefined ? { effectiveEnv } : {}),
    },
    bridge: { publishWorkspaceEvent: vi.fn() } as unknown as AcpSessionBridge,
  } as unknown as WorkspaceRuntime;
}

function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return createWorkspaceRegistry(runtimes);
}

function mount(deps: { cacheTtlMs?: number } = {}) {
  const app = express();
  registerWorkspaceQualifiedGitHubPrsRoutes(app, {
    workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
    sendBridgeError,
    mutate: passthroughMutate,
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
      mutate: passthroughMutate,
    });

    const response = await request(app).get('/workspaces/secondary/github/prs');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/secondary',
      available: true,
      pullRequests: [PR],
    });
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledWith(
      '/work/secondary',
      undefined,
    );
  });

  it('returns available:false when the workspace is not a git repository', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
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
      mutate: passthroughMutate,
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
      mutate: passthroughMutate,
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
      mutate: passthroughMutate,
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
      mutate: passthroughMutate,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      error: 'fatal: <workspace> is not a GitHub remote',
      code: 'github_prs_failed',
    });
    expect(response.body.error).not.toContain('/work/main');
  });

  it('sweeps an absolute gh binary path out of a spawn failure', async () => {
    // The resolver can hand the child an absolute install path; Node embeds
    // it in the spawn error, and this body is what remote clients read. Only
    // a fail-closed absolute-path sweep keeps the host layout out.
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message: 'spawn /Users/alice/.local/bin/gh EACCES',
      gitRoot: '/work/main',
    });
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('github_prs_failed');
    expect(response.body.error).toBe('spawn <path> EACCES');
    expect(response.body.error).not.toContain('/Users/alice');
  });

  it('redacts the resolved fallback binary even when its path has spaces', async () => {
    // A whitespace-bounded token sweep cannot own `/Users/John Smith/...`; the
    // producer's exact value is the only thing that can.
    const binary = '/Users/John Smith/.local/bin/gh';
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message: `spawn ${binary} EACCES`,
      gitRoot: '/work/main',
      binary,
    });
    const app = mount();

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('spawn <path> EACCES');
    expect(response.body.error).not.toContain('Smith');
    expect(response.body.error).not.toContain('.local');
  });

  it('sweeps paths glued after = and a backtick', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message:
        'open=/Users/alice/.config/gh/hosts.yml; see `/Users/alice/.ssh/config`',
      gitRoot: '/work/main',
    });
    const app = mount();

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body.error).not.toContain('/Users/alice');
    expect(response.body.error).toContain('<path>');
  });

  it('sweeps drive-letter and UNC paths', async () => {
    // gh's own stderr is the producer here; the Windows shapes the sweep
    // names must not survive on a Windows daemon host.
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message:
        'could not open C:\\Users\\alice\\hosts.yml; spawn \\\\host\\share\\gh EACCES',
      gitRoot: '/work/main',
    });
    const app = mount();

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body.error).not.toContain('alice');
    expect(response.body.error).not.toContain('share');
    expect(response.body.error).toContain('<path>');
  });

  it('sweeps an absolute path out of a PR create spawn failure', async () => {
    createGitHubPullRequestMock.mockResolvedValue({
      kind: 'failed',
      message: 'spawn /Users/alice/.local/bin/gh EACCES',
      gitRoot: '/work/main',
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app)
      .post('/workspaces/primary/github/prs/create')
      .send({ title: 'Add a thing' });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('spawn <path> EACCES');
    expect(response.body.error).not.toContain('/Users/alice');
  });

  it('logs the raw gh failure server-side while redacting the body', async () => {
    const raw = 'spawn /Users/alice/.local/bin/gh EACCES';
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message: raw,
      gitRoot: '/work/main',
    });
    const app = mount();

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(mockDebugLogger.debug).toHaveBeenCalledWith(
      'GitHub PR list failed',
      {
        workspaceCwd: '/work/main',
        gitRoot: '/work/main',
        message: raw,
      },
    );
    expect(response.body.error).not.toContain('/Users/alice');
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
      mutate: passthroughMutate,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('github_prs_failed');
    expect(response.body.error).not.toContain(gitRoot);
    expect(response.body.error.length).toBeLessThanOrEqual(512);
  });

  it('sanitizes the git root (not just the workspace cwd) on PR create failure', async () => {
    // gh runs at the git root, which may be a parent of the workspace cwd; a
    // failure message can embed that root, so it must be redacted too.
    createGitHubPullRequestMock.mockResolvedValue({
      kind: 'failed',
      message: 'fatal: /work is not a GitHub remote',
      gitRoot: '/work',
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app)
      .post('/workspaces/primary/github/prs/create')
      .send({ title: 'Add a thing' });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      error: 'fatal: <workspace> is not a GitHub remote',
      code: 'github_pr_create_failed',
    });
    expect(response.body.error).not.toContain('/work');
  });

  it('maps a not-a-repo result to 404 on PR create', async () => {
    createGitHubPullRequestMock.mockResolvedValue({ kind: 'not_a_repo' });
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app)
      .post('/workspaces/primary/github/prs/create')
      .send({ title: 'Add a thing' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_a_git_repository' });
  });

  it('maps a missing gh binary to 502 on PR create', async () => {
    createGitHubPullRequestMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app)
      .post('/workspaces/primary/github/prs/create')
      .send({ title: 'Add a thing' });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('github_cli_unavailable');
  });

  it('falls back to the bridge error mapper on unexpected throws', async () => {
    fetchGitHubPullRequestsMock.mockRejectedValue(new Error('boom'));
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get('/workspaces/primary/github/prs');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('boom');
  });

  it('returns runtime-unavailable on default-branch when the generation is closed', async () => {
    const generationGuard = createWorkspaceGenerationGuard();
    generationGuard.close();
    const guarded = {
      ...runtime('primary', '/work/main', true),
      generationGuard,
    };
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([guarded]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get(
      '/workspaces/primary/github/default-branch',
    );

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
  });

  it('creates a pull request and returns 201 with url and number', async () => {
    createGitHubPullRequestMock.mockResolvedValue({
      kind: 'ok',
      url: 'https://github.com/o/r/pull/43',
      number: 43,
    });
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app)
      .post('/workspaces/primary/github/prs/create')
      .send({ title: 'Add a thing' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      url: 'https://github.com/o/r/pull/43',
      number: 43,
    });
    expect(createGitHubPullRequestMock).toHaveBeenCalledWith(
      '/work/main',
      {
        title: 'Add a thing',
        body: undefined,
        base: undefined,
        head: undefined,
      },
      undefined,
    );
  });

  it('returns the default branch for a trusted workspace', async () => {
    getDefaultBranchMock.mockResolvedValue('origin/main');
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get(
      '/workspaces/primary/github/default-branch',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branch: 'origin/main' });
    expect(getDefaultBranchMock).toHaveBeenCalledWith('/work/main', undefined);
  });

  it('falls back to origin/main when getDefaultBranch returns null', async () => {
    getDefaultBranchMock.mockResolvedValue(null);
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([runtime('primary', '/work/main', true)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get(
      '/workspaces/primary/github/default-branch',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branch: 'origin/main' });
  });

  it('returns a PR file list and scale for a trusted workspace', async () => {
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'ok',
      files: {
        files: [{ path: 'src/a.ts', additions: 10, deletions: 2 }],
        hiddenCount: 0,
        additions: 10,
        deletions: 2,
        headSha: 'abc1234',
      },
    });
    const app = mount();

    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      available: true,
      files: [{ path: 'src/a.ts', additions: 10, deletions: 2 }],
      hiddenCount: 0,
      additions: 10,
      deletions: 2,
      headSha: 'abc1234',
    });
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledWith(
      '/work/main',
      42,
      undefined,
      undefined,
    );
  });

  it('keeps concurrent same-number requests in different workspaces separate', async () => {
    // The coalescing key's cwd component: the same PR number in two
    // workspaces is two different probes and two different gh calls.
    const gates: Array<(r: FetchGitHubPullRequestFilesResult) => void> = [];
    fetchGitHubPullRequestFilesMock.mockImplementation(
      () =>
        new Promise<FetchGitHubPullRequestFilesResult>((resolve) => {
          gates.push(resolve);
        }),
    );
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([
        runtime('primary', '/work/main', true),
        runtime('secondary', '/work/second', true),
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const p1 = request(app)
      .get('/workspaces/primary/github/prs/42/files')
      .then((r) => r);
    const p2 = request(app)
      .get('/workspaces/secondary/github/prs/42/files')
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    expect(gates).toHaveLength(2);
    gates[0]!({
      kind: 'ok',
      files: {
        files: [{ path: 'main.ts', additions: 1, deletions: 0 }],
        hiddenCount: 0,
        additions: 1,
        deletions: 0,
        headSha: 'mmm',
      },
    });
    gates[1]!({
      kind: 'ok',
      files: {
        files: [{ path: 'second.ts', additions: 2, deletions: 0 }],
        hiddenCount: 0,
        additions: 2,
        deletions: 0,
        headSha: 'sss',
      },
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.body.files).toEqual([
      { path: 'main.ts', additions: 1, deletions: 0 },
    ]);
    expect(r2.body.files).toEqual([
      { path: 'second.ts', additions: 2, deletions: 0 },
    ]);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledTimes(2);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenNthCalledWith(
      1,
      '/work/main',
      42,
      undefined,
      undefined,
    );
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenNthCalledWith(
      2,
      '/work/second',
      42,
      undefined,
      undefined,
    );
  });

  it('forwards the repo query parameter to the core helper', async () => {
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'ok',
      files: {
        files: [],
        hiddenCount: 0,
        additions: 0,
        deletions: 0,
        headSha: '',
      },
    });
    const app = mount();

    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files?repo=other%2Frepo',
    );

    expect(response.status).toBe(200);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledWith(
      '/work/main',
      42,
      undefined,
      'other/repo',
    );
  });

  it('rejects a repeated repo query key with 400 before calling gh', async () => {
    // Express's simple parser turns a repeated key into an array; dropping it
    // silently would answer with a same-numbered local PR instead.
    const app = mount();
    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files?repo=a%2Fb&repo=c%2Fd',
    );
    expect(response.status).toBe(400);
    expect(response.body.errorKind).toBe('parse_error');
    expect(fetchGitHubPullRequestFilesMock).not.toHaveBeenCalled();
  });

  it('rejects an empty repo query value with 400 before calling gh', async () => {
    const app = mount();
    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files?repo=',
    );
    expect(response.status).toBe(400);
    expect(response.body.errorKind).toBe('parse_error');
    expect(fetchGitHubPullRequestFilesMock).not.toHaveBeenCalled();
  });

  it('maps a malformed repo slug to 400, not a gh failure', async () => {
    // A slug the core validator refuses (three path segments) is a caller
    // error, not a gh failure. (`../..` is NOT such a case: '.' is in the slug
    // charset, so it is valid-format and resolves via gh like any other repo.)
    // The route classifies by the machine-readable reason the core test pins,
    // not the prose — rewording the message must not turn this into a 502.
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'failed',
      message: 'invalid pull request repository',
      reason: 'invalid_repo',
      gitRoot: '/work/main',
    });
    const app = mount();
    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files?repo=owner%2Frepo%2Fextra',
    );
    expect(response.status).toBe(400);
    expect(response.body.errorKind).toBe('parse_error');
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledWith(
      '/work/main',
      42,
      undefined,
      'owner/repo/extra',
    );
  });

  it('forwards the workspace effectiveEnv to the PR files helper', async () => {
    // A workspace whose GH_TOKEN comes from its overlay must run gh under that
    // identity, not the daemon host's; pin the env argument is the overlay.
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'ok',
      files: {
        files: [],
        hiddenCount: 0,
        additions: 0,
        deletions: 0,
        headSha: '',
      },
    });
    const overlay = { GH_TOKEN: 'workspace-token' };
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([
        runtime('primary', '/work/main', true, overlay),
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );

    expect(response.status).toBe(200);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledWith(
      '/work/main',
      42,
      overlay,
      undefined,
    );
  });

  it('redacts the resolved fallback binary with spaces for PR files', async () => {
    // A whitespace-bounded sweep cannot own `/Users/John Smith/...`; only the
    // producer's exact binary value redacts it whole out of the 502 body.
    const binary = '/Users/John Smith/.local/bin/gh';
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'failed',
      message: `spawn ${binary} EACCES`,
      gitRoot: '/work/main',
      binary,
    });
    const app = mount();

    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('spawn <path> EACCES');
    expect(response.body.error).not.toContain('Smith');
    expect(response.body.error).not.toContain('.local');
  });

  it('coalesces concurrent same-PR files requests into one gh call', async () => {
    let resolveLoad: (r: FetchGitHubPullRequestFilesResult) => void = () => {};
    const gate = new Promise<FetchGitHubPullRequestFilesResult>((r) => {
      resolveLoad = r;
    });
    fetchGitHubPullRequestFilesMock.mockImplementation(() => gate);
    const app = mount();

    const p1 = request(app)
      .get('/workspaces/primary/github/prs/42/files')
      .then((r) => r);
    const p2 = request(app)
      .get('/workspaces/primary/github/prs/42/files')
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    resolveLoad({
      kind: 'ok',
      files: {
        files: [],
        hiddenCount: 0,
        additions: 0,
        deletions: 0,
        headSha: '',
      },
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent requests for different PR numbers separate', async () => {
    // The coalescing key must discriminate on number: collapsing it to cwd
    // would hand the second caller the first PR's files under its own request.
    const gates: Array<(r: FetchGitHubPullRequestFilesResult) => void> = [];
    fetchGitHubPullRequestFilesMock.mockImplementation(
      () =>
        new Promise<FetchGitHubPullRequestFilesResult>((resolve) => {
          gates.push(resolve);
        }),
    );
    const app = mount();

    const p1 = request(app)
      .get('/workspaces/primary/github/prs/42/files')
      .then((r) => r);
    const p2 = request(app)
      .get('/workspaces/primary/github/prs/43/files')
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    expect(gates).toHaveLength(2);
    gates[0]!({
      kind: 'ok',
      files: {
        files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
        hiddenCount: 0,
        additions: 1,
        deletions: 0,
        headSha: 'aaa',
      },
    });
    gates[1]!({
      kind: 'ok',
      files: {
        files: [{ path: 'b.ts', additions: 2, deletions: 0 }],
        hiddenCount: 0,
        additions: 2,
        deletions: 0,
        headSha: 'bbb',
      },
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.body.files).toEqual([
      { path: 'a.ts', additions: 1, deletions: 0 },
    ]);
    expect(r2.body.files).toEqual([
      { path: 'b.ts', additions: 2, deletions: 0 },
    ]);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledTimes(2);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenNthCalledWith(
      1,
      '/work/main',
      42,
      undefined,
      undefined,
    );
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenNthCalledWith(
      2,
      '/work/main',
      43,
      undefined,
      undefined,
    );
  });

  it('keeps concurrent requests for the same number in different repos separate', async () => {
    // The coalescing key must discriminate on repo: a same-numbered PR in
    // another repository is a different PR with its own files and head.
    const gates: Array<(r: FetchGitHubPullRequestFilesResult) => void> = [];
    fetchGitHubPullRequestFilesMock.mockImplementation(
      () =>
        new Promise<FetchGitHubPullRequestFilesResult>((resolve) => {
          gates.push(resolve);
        }),
    );
    const app = mount();

    const p1 = request(app)
      .get('/workspaces/primary/github/prs/42/files?repo=o%2Fr')
      .then((r) => r);
    const p2 = request(app)
      .get('/workspaces/primary/github/prs/42/files?repo=x%2Fy')
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    expect(gates).toHaveLength(2);
    gates[0]!({
      kind: 'ok',
      files: {
        files: [{ path: 'r.ts', additions: 1, deletions: 0 }],
        hiddenCount: 0,
        additions: 1,
        deletions: 0,
        headSha: 'rrr',
      },
    });
    gates[1]!({
      kind: 'ok',
      files: {
        files: [{ path: 'y.ts', additions: 2, deletions: 0 }],
        hiddenCount: 0,
        additions: 2,
        deletions: 0,
        headSha: 'yyy',
      },
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.body.files).toEqual([
      { path: 'r.ts', additions: 1, deletions: 0 },
    ]);
    expect(r2.body.files).toEqual([
      { path: 'y.ts', additions: 2, deletions: 0 },
    ]);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledTimes(2);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenNthCalledWith(
      1,
      '/work/main',
      42,
      undefined,
      'o/r',
    );
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenNthCalledWith(
      2,
      '/work/main',
      42,
      undefined,
      'x/y',
    );
  });

  it('re-reads fresh data on a sequential repeat request', async () => {
    // The in-flight entry must clear once settled, or a later open serves a
    // frozen snapshot for the daemon's lifetime. Deleting the clear leaves the
    // second request reusing the settled promise (one call instead of two).
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'ok',
      files: {
        files: [],
        hiddenCount: 0,
        additions: 0,
        deletions: 0,
        headSha: '',
      },
    });
    const app = mount();
    const first = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );
    const second = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchGitHubPullRequestFilesMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid cwd query with 400 before calling gh', async () => {
    const app = mount();
    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files?cwd=%2Fnonexistent-xyz',
    );
    expect(response.status).toBe(400);
    expect(fetchGitHubPullRequestFilesMock).not.toHaveBeenCalled();
  });

  it('returns available:false for a PR files request outside a git repo', async () => {
    fetchGitHubPullRequestFilesMock.mockResolvedValue({ kind: 'not_a_repo' });
    const app = mount();

    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(false);
    expect(response.body.files).toEqual([]);
  });

  it('rejects a non-integer PR number before calling gh', async () => {
    const app = mount();

    for (const bad of ['abc', '0', '-3', '1.5']) {
      const response = await request(app).get(
        `/workspaces/primary/github/prs/${bad}/files`,
      );
      expect(response.status).toBe(400);
      expect(response.body.errorKind).toBe('parse_error');
    }
    expect(fetchGitHubPullRequestFilesMock).not.toHaveBeenCalled();
  });

  it('rejects an untrusted workspace before fetching PR files', async () => {
    const app = express();
    registerWorkspaceQualifiedGitHubPrsRoutes(app, {
      workspaceRegistry: registry([
        runtime('primary', '/work/main', true),
        runtime('untrusted', '/work/untrusted', false),
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get(
      '/workspaces/untrusted/github/prs/42/files',
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(fetchGitHubPullRequestFilesMock).not.toHaveBeenCalled();
  });

  it('maps a missing gh binary to github_cli_unavailable for PR files', async () => {
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });
    const app = mount();

    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('github_cli_unavailable');
  });

  it('redacts a gh failure message and logs it server-side', async () => {
    const raw = 'spawn /Users/alice/.local/bin/gh EACCES';
    fetchGitHubPullRequestFilesMock.mockResolvedValue({
      kind: 'failed',
      message: raw,
      gitRoot: '/work/main',
      binary: '/Users/alice/.local/bin/gh',
    });
    const app = mount();

    const response = await request(app).get(
      '/workspaces/primary/github/prs/42/files',
    );

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('github_pr_files_failed');
    expect(response.body.error).not.toContain('/Users/alice');
    expect(mockDebugLogger.debug).toHaveBeenCalledWith(
      'GitHub PR files failed',
      {
        workspaceCwd: '/work/main',
        gitRoot: '/work/main',
        message: raw,
      },
    );
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
