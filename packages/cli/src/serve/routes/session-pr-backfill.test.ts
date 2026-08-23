/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Storage,
  fetchGitHubPullRequests,
  readSessionPrs,
  type SessionService,
} from '@qwen-code/qwen-code-core';
import { sendBridgeError } from '../server/error-response.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  backfillWorkspaceSessionPrs,
  normalizeRemoteToWebUrl,
  parsePrNumberFromWorktree,
  registerSessionPrBackfillRoutes,
} from './session-pr-backfill.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  fetchGitHubPullRequests: vi.fn(),
}));

const fetchGitHubPullRequestsMock = vi.mocked(fetchGitHubPullRequests);

const passthroughMutate = () =>
  ((_req: unknown, _res: unknown, next: () => void) => next()) as never;

// listSessions only scans UUID-pattern file names.
const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';
const SESSION_C = '00000000-0000-4000-8000-000000000003';
const SESSION_D = '00000000-0000-4000-8000-000000000004';
const SESSION_E = '00000000-0000-4000-8000-000000000005';
const SESSION_F = '00000000-0000-4000-8000-000000000006';
const SESSION_G = '00000000-0000-4000-8000-000000000007';

function pr(number: number, headRefName: string) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    author: 'octocat',
    headRefName,
    state: 'open' as const,
    reviewDecision: null,
    checks: 'passing' as const,
    updatedAt: 1_800_000_000,
  };
}

describe('parsePrNumberFromWorktree', () => {
  it('parses the pr-<N> slug convention', () => {
    expect(parsePrNumberFromWorktree('pr-123', 'worktree-pr-123')).toBe(123);
  });

  it('parses the worktree-pr-<N> branch convention', () => {
    expect(parsePrNumberFromWorktree('my-thing', 'worktree-pr-7')).toBe(7);
  });

  it('prefers the slug over the branch', () => {
    expect(parsePrNumberFromWorktree('pr-1', 'worktree-pr-2')).toBe(1);
  });

  it('rejects non-conventional slugs and branches', () => {
    expect(parsePrNumberFromWorktree('pr-abc', 'worktree-pr-abc')).toBe(
      undefined,
    );
    expect(parsePrNumberFromWorktree('pr-', 'worktree-')).toBeUndefined();
    expect(parsePrNumberFromWorktree(undefined, undefined)).toBeUndefined();
    expect(parsePrNumberFromWorktree('pr-1234567890', undefined)).toBe(
      undefined,
    );
  });
});

describe('normalizeRemoteToWebUrl', () => {
  it('normalizes https remotes, stripping .git', () => {
    expect(normalizeRemoteToWebUrl('https://github.com/o/r.git')).toBe(
      'https://github.com/o/r',
    );
  });

  it('normalizes scp-style ssh remotes', () => {
    expect(normalizeRemoteToWebUrl('git@github.com:o/r.git')).toBe(
      'https://github.com/o/r',
    );
  });

  it('normalizes ssh:// remotes', () => {
    expect(normalizeRemoteToWebUrl('ssh://git@github.com/o/r')).toBe(
      'https://github.com/o/r',
    );
  });

  it('keeps enterprise hosts', () => {
    expect(normalizeRemoteToWebUrl('git@code.example.com:team/repo.git')).toBe(
      'https://code.example.com/team/repo',
    );
  });

  it('rejects garbage and non-http protocols', () => {
    expect(normalizeRemoteToWebUrl('not a url')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('git://github.com/o/r')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('')).toBeUndefined();
  });
});

describe('backfillWorkspaceSessionPrs', () => {
  let runtimeDir: string;
  let workspaceCwd: string;
  let runtime: WorkspaceRuntime;
  let sessionService: SessionService;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-runtime-'),
    );
    workspaceCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-work-'),
    );
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    runtime = {
      workspaceId: 'primary',
      workspaceCwd,
      sessionRuntimeBaseDir: runtimeDir,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
    } as unknown as WorkspaceRuntime;
    sessionService = createWorkspaceRuntimeSessionService(runtime);
  });

  afterEach(async () => {
    delete process.env['QWEN_RUNTIME_DIR'];
    await fsp.rm(runtimeDir, { recursive: true, force: true });
    await fsp.rm(workspaceCwd, { recursive: true, force: true });
  });

  async function seedSession(
    sessionId: string,
    gitBranch?: string,
  ): Promise<void> {
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    const record = {
      uuid: `${sessionId}-user-1`,
      parentUuid: null,
      sessionId,
      timestamp: '2026-08-01T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'hello' }] },
      cwd: workspaceCwd,
      ...(gitBranch !== undefined ? { gitBranch } : {}),
    };
    await fsp.writeFile(
      path.join(chatsDir, `${sessionId}.jsonl`),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
  }

  async function seedWorktreeSidecar(
    sessionId: string,
    slug: string,
    branch: string,
    archiveState: 'active' | 'archived' = 'active',
  ): Promise<void> {
    const sidecarPath = sessionService.getWorktreeSessionPathForArchiveState(
      sessionId,
      archiveState,
    );
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fsp.writeFile(
      sidecarPath,
      JSON.stringify({
        slug,
        worktreePath: `${workspaceCwd}/.qwen/worktrees/${slug}`,
        worktreeBranch: branch,
        originalCwd: workspaceCwd,
        originalBranch: 'main',
        originalHeadCommit: 'abc123',
      }),
      'utf8',
    );
  }

  async function archiveSession(sessionId: string): Promise<void> {
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(path.join(chatsDir, 'archive'), { recursive: true });
    await fsp.rename(
      path.join(chatsDir, `${sessionId}.jsonl`),
      path.join(chatsDir, 'archive', `${sessionId}.jsonl`),
    );
  }

  it('binds the PR named by the slug convention using the gh URL', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1, unresolved: 0 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs).toEqual([
      {
        number: 123,
        url: 'https://github.com/o/r/pull/123',
        createdAt: expect.any(String),
        state: 'open',
      },
    ]);
  });

  it('falls back to the remote web URL when gh is unavailable', async () => {
    execSync('git init', { cwd: workspaceCwd, stdio: 'pipe' });
    execSync('git remote add origin git@github.com:o/r.git', {
      cwd: workspaceCwd,
      stdio: 'pipe',
    });
    await seedSession(SESSION_B);
    await seedWorktreeSidecar(SESSION_B, 'pr-7', 'worktree-pr-7');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1, unresolved: 0 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
    );
    expect(prs?.[0]).toMatchObject({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
    });
  });

  it('binds the reviewed PR from a /review command, archived included', async () => {
    await seedSession(SESSION_C);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_C}.jsonl`),
      `${JSON.stringify({
        uuid: `${SESSION_C}-review`,
        parentUuid: `${SESSION_C}-user-1`,
        sessionId: SESSION_C,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: '/review 55 --comment' }] },
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
    await archiveSession(SESSION_C);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(55, 'fix/55')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_C, 'archived'),
    );
    expect(prs?.[0]).toMatchObject({
      number: 55,
      url: 'https://github.com/o/r/pull/55',
    });
  });

  it('counts already-bound sessions without rewriting the sidecar', async () => {
    await seedSession(SESSION_D);
    await seedWorktreeSidecar(SESSION_D, 'pr-123', 'worktree-pr-123');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_D,
      'active',
    );
    await fsp.mkdir(path.dirname(prPath), { recursive: true });
    await fsp.writeFile(
      prPath,
      JSON.stringify({
        prs: [
          {
            number: 123,
            url: 'https://github.com/o/r/pull/123',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, alreadyBound: 1 });
  });

  it('scans sessions without worktree sidecars without binding them', async () => {
    await seedSession(SESSION_E);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({
      scanned: 1,
      bound: 0,
      alreadyBound: 0,
      unresolved: 0,
    });
    // No candidates — gh must not be spawned at all.
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });
    await seedSession(SESSION_F);
    await backfillWorkspaceSessionPrs(runtime);
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
  });

  it('leaves sessions with no resolvable PR untouched', async () => {
    await seedSession(SESSION_G, 'my-thing');
    await seedWorktreeSidecar(SESSION_G, 'my-thing', 'worktree-my-thing');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 0, unresolved: 0 });
  });

  it('binds the URL form of /review', async () => {
    await seedSession(SESSION_G);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_G}.jsonl`),
      `${JSON.stringify({
        uuid: `${SESSION_G}-review`,
        parentUuid: `${SESSION_G}-user-1`,
        sessionId: SESSION_G,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: '/review https://github.com/o/r/pull/43 --comment' }],
        },
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(43, 'fix/43')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_G, 'active'),
    );
    expect(prs?.[0]).toMatchObject({ number: 43 });
  });

  it('does not bind the session git branch (noise source removed)', async () => {
    await seedSession(SESSION_G, 'fix/thing');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'fix/thing')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 0 });
  });

  it('recovers PRs created via gh pr create in the session shell', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000008';
    await seedSession(sessionId);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    const call = {
      uuid: `${sessionId}-call`,
      parentUuid: `${sessionId}-user-1`,
      sessionId,
      timestamp: '2026-08-02T00:00:00.000Z',
      type: 'assistant',
      message: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-1',
              name: 'run_shell_command',
              args: { command: 'gh pr create --title x --body y' },
            },
          },
        ],
      },
      cwd: workspaceCwd,
    };
    const response = {
      uuid: `${sessionId}-resp`,
      parentUuid: `${sessionId}-call`,
      sessionId,
      timestamp: '2026-08-02T00:00:01.000Z',
      type: 'user',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'run_shell_command',
              response: {
                output: `created\nhttps://github.com/o/r/pull/99\n`,
              },
            },
          },
        ],
      },
      cwd: workspaceCwd,
    };
    await fsp.appendFile(
      path.join(chatsDir, `${sessionId}.jsonl`),
      `${JSON.stringify(call)}\n${JSON.stringify(response)}\n`,
      'utf8',
    );
    // gh is unavailable: the URL printed at create time is the only source.
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(sessionId, 'active'),
    );
    expect(prs).toEqual([
      {
        number: 99,
        url: 'https://github.com/o/r/pull/99',
        createdAt: expect.any(String),
      },
    ]);
  });
});

describe('registerSessionPrBackfillRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function runtime(
    workspaceId: string,
    workspaceCwd: string,
    trusted: boolean,
  ): WorkspaceRuntime {
    return {
      workspaceId,
      workspaceCwd,
      sessionRuntimeBaseDir: workspaceCwd,
      primary: workspaceId === 'primary',
      trusted,
      env: { mode: 'parent-process', overlayKeys: [] },
    } as unknown as WorkspaceRuntime;
  }

  function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
    return createWorkspaceRegistry(runtimes);
  }

  it('aggregates results across workspaces and skips untrusted ones', async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([
        runtime('primary', '/work/main', true),
        runtime('secondary', '/work/untrusted', false),
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).post('/sessions/backfill-prs');

    expect(response.status).toBe(200);
    expect(response.body.workspaces).toHaveLength(2);
    const untrusted = response.body.workspaces.find(
      (w: { workspaceCwd: string }) => w.workspaceCwd === '/work/untrusted',
    );
    expect(untrusted.error).toBe('untrusted workspace skipped');
    expect(response.body).toMatchObject({ v: 1, bound: 0 });
  });
});
