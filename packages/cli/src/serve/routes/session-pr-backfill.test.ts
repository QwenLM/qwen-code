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
  fetchRemoteWebUrl,
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
  parsePrNumberFromWorktree,
  registerSessionPrBackfillRoutes,
} from './session-pr-backfill.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    fetchGitHubPullRequests: vi.fn(),
    fetchRemoteWebUrl: vi.fn().mockImplementation(actual.fetchRemoteWebUrl),
  };
});

const fetchGitHubPullRequestsMock = vi.mocked(fetchGitHubPullRequests);
const fetchRemoteWebUrlMock = vi.mocked(fetchRemoteWebUrl);

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

  it('rejects zero and leading zeros (no PR 0, unambiguous round-trips)', () => {
    // `pr-0` is a legal user-chosen slug, but number 0 would poison the
    // sidecar read; `#0123`-style leading zeros stay rejected too.
    expect(parsePrNumberFromWorktree('pr-0', 'worktree-pr-0')).toBeUndefined();
    expect(parsePrNumberFromWorktree('pr-0123', undefined)).toBeUndefined();
    expect(
      parsePrNumberFromWorktree(undefined, 'worktree-pr-0123'),
    ).toBeUndefined();
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
    seedWorkspaceRemote();
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

  it('maps custom-slug worktree branches through gh headRefName', async () => {
    seedWorkspaceRemote();
    await seedSession(SESSION_C);
    await seedWorktreeSidecar(
      SESSION_C,
      'my-thing',
      'worktree-my-thing',
      'active',
    );
    await archiveSession(SESSION_C);
    await seedWorktreeSidecar(
      SESSION_C,
      'my-thing',
      'worktree-my-thing',
      'archived',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(55, 'worktree-my-thing')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_C, 'archived'),
    );
    expect(prs?.[0]).toMatchObject({ number: 55 });
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

  it('binds PRs whose head branch appears in the transcript gitBranch', async () => {
    seedWorkspaceRemote();
    await seedSession(SESSION_G, 'fix/thing');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'fix/thing')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_G, 'active'),
    );
    expect(prs?.[0]).toMatchObject({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
    });
  });

  it('binds one session to several PRs from multiple branches', async () => {
    seedWorkspaceRemote();
    await seedSession(SESSION_G, 'fix/a');
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_G}.jsonl`),
      `${JSON.stringify({
        uuid: `${SESSION_G}-user-2`,
        parentUuid: `${SESSION_G}-user-1`,
        sessionId: SESSION_G,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'more' }] },
        cwd: workspaceCwd,
        gitBranch: 'fix/b',
      })}\n`,
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'fix/a'), pr(43, 'fix/b')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 2 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_G, 'active'),
    );
    expect(prs?.map((pr) => pr.number).sort()).toEqual([42, 43]);
  });

  async function seedGhCreateTranscript(
    sessionId: string,
    command: string,
    output: string,
  ): Promise<void> {
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
              args: { command },
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
              response: { output },
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
  }

  function seedWorkspaceRemote(): void {
    execSync('git init', { cwd: workspaceCwd, stdio: 'pipe' });
    execSync('git remote add origin git@github.com:o/r.git', {
      cwd: workspaceCwd,
      stdio: 'pipe',
    });
  }

  it('does not bind transcript gh pr create URLs that gh cannot vouch for', async () => {
    // A URL printed in a historical transcript cannot be attributed to the
    // session's own create without gh's confirmation, so the transcript
    // source stays silent instead of persisting unverifiable URLs
    // retroactively (forged bindings would otherwise survive forever).
    const sessionId = '00000000-0000-4000-8000-000000000008';
    seedWorkspaceRemote();
    await seedSession(sessionId);
    await seedGhCreateTranscript(
      sessionId,
      'gh pr create --title x --body y',
      `created\nhttps://github.com/o/r/pull/99\n`,
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, alreadyBound: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(sessionId, 'active'),
      ),
    ).toBeNull();
  });

  it('does not recover a transcript URL from another repository', async () => {
    // The attribution gate: a forged or foreign URL in the captured output
    // must not persist as this workspace session's PR.
    const sessionId = '00000000-0000-4000-8000-000000000009';
    seedWorkspaceRemote();
    await seedSession(sessionId);
    await seedGhCreateTranscript(
      sessionId,
      'gh pr create --fill',
      `https://github.com/other/repo/pull/666\n`,
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, unresolved: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(sessionId, 'active'),
      ),
    ).toBeNull();
  });

  it('never binds number 0 from a pr-0 user slug', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-0', 'worktree-pr-0');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 0, unresolved: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
  });

  it('maps a shared head branch to the newest PR', async () => {
    // gh emits newest-updatedAt first; first-wins keeps the current PR
    // reachable instead of resolving to the oldest one on the branch.
    seedWorkspaceRemote();
    await seedSession(SESSION_A, 'fix/login');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(87, 'fix/login'), pr(12, 'fix/login')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]).toMatchObject({ number: 87 });
  });

  it('keeps the convention binding when weaker numbers overflow the cap', async () => {
    seedWorkspaceRemote();
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-42', 'worktree-pr-42');
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    const branchRecords = Array.from({ length: 11 }, (_, i) =>
      JSON.stringify({
        uuid: `${SESSION_A}-branch-${i}`,
        parentUuid: `${SESSION_A}-user-1`,
        sessionId: SESSION_A,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: `on b${i}` }] },
        cwd: workspaceCwd,
        gitBranch: `fix/b${i}`,
      }),
    ).join('\n');
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      `${branchRecords}\n`,
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        pr(42, 'worktree-pr-42'),
        ...Array.from({ length: 11 }, (_, i) => pr(101 + i, `fix/b${i}`)),
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 12 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs).toHaveLength(10);
    // The worktree's own PR is the strongest binding — inserted last, so it
    // survives the tail-10 cap instead of being evicted by branch matches.
    expect(prs?.map((p) => p.number)).toContain(42);
    expect(prs?.[9]?.number).toBe(42);
  });

  it('keeps an already-bound convention PR across runs that bind weaker numbers', async () => {
    // Run 1 binds only the convention (gh unavailable); run 2 then binds 11
    // branch-mapped PRs. The convention must be repositioned on run 2, or
    // the sidecar's tail cap evicts the PR the session exists for.
    seedWorkspaceRemote();
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-42', 'worktree-pr-42');
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    const branchRecords = Array.from({ length: 11 }, (_, i) =>
      JSON.stringify({
        uuid: `${SESSION_A}-branch-${i}`,
        parentUuid: `${SESSION_A}-user-1`,
        sessionId: SESSION_A,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: `on b${i}` }] },
        cwd: workspaceCwd,
        gitBranch: `fix/b${i}`,
      }),
    ).join('\n');
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      `${branchRecords}\n`,
      'utf8',
    );

    // RUN 1: gh unavailable — convention only.
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });
    await backfillWorkspaceSessionPrs(runtime);

    // RUN 2: gh available — 11 branch-mapped PRs plus the convention PR.
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        pr(42, 'worktree-pr-42'),
        ...Array.from({ length: 11 }, (_, i) => pr(101 + i, `fix/b${i}`)),
      ],
    });
    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 11, alreadyBound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs).toHaveLength(10);
    expect(prs?.[9]?.number).toBe(42);
  });

  it('does not branch-map PRs whose URL belongs to another repository', async () => {
    // Fork layout: gh resolves the PARENT repo for list queries when the
    // origin is a fork; a bare head-branch collision with one of those PRs
    // must not bind this workspace's session to it.
    seedWorkspaceRemote();
    await seedSession(SESSION_G, 'fix/login');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(31415, 'fix/login'),
          url: 'https://github.com/parent/repo/pull/31415',
        },
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_G, 'active'),
      ),
    ).toBeNull();
  });

  it('binds a fork-layout convention number to the parent URL gh attributes', async () => {
    // Fork layout: the repo gate rejects the whole (parent) page, but gh's
    // own attribution still names the convention PR authoritatively — the
    // session must bind the parent URL, not a synthesized fork URL that
    // would 404 (forks host no PRs).
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/me/fork');
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(123, 'worktree-pr-123'),
          url: 'https://github.com/parent/repo/pull/123',
        },
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1, unresolved: 0 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]).toMatchObject({
      number: 123,
      url: 'https://github.com/parent/repo/pull/123',
    });
  });

  it('repairs a pre-existing live binding evicted by weaker branch numbers', async () => {
    // A live gh-backed binding (#5, strongest signal) already sits in the
    // sidecar. A run that binds 11 weaker branch-mapped numbers pushes #5
    // past the tail-10 cap; the eviction repair must restore it — no other
    // path recovers a dropped pre-existing binding.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await fsp.mkdir(path.dirname(prPath), { recursive: true });
    await fsp.writeFile(
      prPath,
      JSON.stringify({
        prs: [
          {
            number: 5,
            url: 'https://github.com/o/r/pull/5',
            createdAt: '2026-08-01T00:00:00.000Z',
            state: 'open',
          },
        ],
      }),
      'utf8',
    );
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    const branchRecords = Array.from({ length: 11 }, (_, i) =>
      JSON.stringify({
        uuid: `${SESSION_A}-branch-${i}`,
        parentUuid: `${SESSION_A}-user-1`,
        sessionId: SESSION_A,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: `on b${i}` }] },
        cwd: workspaceCwd,
        gitBranch: `fix/b${i}`,
      }),
    ).join('\n');
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      `${branchRecords}\n`,
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: Array.from({ length: 11 }, (_, i) =>
        pr(101 + i, `fix/b${i}`),
      ),
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 11, alreadyBound: 0 });
    const prs = await readSessionPrs(prPath);
    expect(prs).toHaveLength(10);
    expect(prs?.map((p) => p.number)).toContain(5);
  });

  it('isolates a failing sidecar write and continues with other candidates', async () => {
    // One candidate's sidecar is unwritable (a directory sits where the
    // file belongs); the run must record it and keep going, not abort and
    // drop every later candidate.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    await seedSession(SESSION_A, 'fix/a');
    await seedSession(SESSION_B);
    await seedWorktreeSidecar(SESSION_B, 'pr-7', 'worktree-pr-7');
    const badPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
    );
    await fsp.mkdir(badPath, { recursive: true });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'fix/a'), pr(7, 'worktree-pr-7')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1, failed: 1 });
    const prsA = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prsA?.[0]).toMatchObject({ number: 42 });
  });

  it('resolves the git remote at most once per backfill run', async () => {
    fetchRemoteWebUrlMock.mockResolvedValue(undefined);
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-7', 'worktree-pr-7');
    await seedSession(SESSION_B);
    await seedWorktreeSidecar(SESSION_B, 'pr-8', 'worktree-pr-8');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, unresolved: 2 });
    // A failed lookup must be cached too — one attempt per run, not one per
    // candidate.
    expect(fetchRemoteWebUrlMock).toHaveBeenCalledTimes(1);
  });

  it('rejects traversal sessionIds before building sidecar paths', async () => {
    // listSessions returns the transcript's first-record sessionId
    // verbatim; a planted transcript may carry a path-escape id. Unguarded,
    // the scan would read the escaped transcript for branches and WRITE the
    // binding at the escaped sidecar path.
    const fileName = '00000000-0000-4000-8000-00000000000a';
    const traversalId = '../../pwn';
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    await fsp.writeFile(
      path.join(chatsDir, `${fileName}.jsonl`),
      `${JSON.stringify({
        uuid: `${fileName}-user-1`,
        parentUuid: null,
        sessionId: traversalId,
        timestamp: '2026-08-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
    // Plant the escape transcript the unguarded scan reads for branches, so
    // the pre-gate code path binds instead of skipping the session.
    const escapedDir = path.dirname(
      sessionService.getWorktreeSessionPathForArchiveState(
        traversalId,
        'active',
      ),
    );
    await fsp.mkdir(escapedDir, { recursive: true });
    await fsp.writeFile(
      path.join(escapedDir, `${traversalId}.jsonl`),
      `${JSON.stringify({ gitBranch: 'fix/thing' })}\n`,
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'fix/thing')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 0, bound: 0 });
    const escapedSidecar = sessionService.getPrSessionPathForArchiveState(
      traversalId,
      'active',
    );
    expect(path.relative(chatsDir, escapedSidecar).startsWith('..')).toBe(true);
    await expect(fsp.access(escapedSidecar)).rejects.toThrow();
    // The planted escape transcript lands outside the per-test runtime dir
    // (that is what makes it an escape) — remove it explicitly so a
    // fixed-name file does not linger in the OS tmpdir across runs.
    await fsp.rm(path.join(escapedDir, `${traversalId}.jsonl`), {
      force: true,
    });
  });

  it('keeps sidecar order and createdAt when a run binds nothing new', async () => {
    // The sidecar's ordering contract — binding-time order, last entry
    // latest — is what the badge and tooltip render by. A re-run finding
    // only already-bound numbers must not re-upsert them: moving an entry
    // to the end with a fresh createdAt flips which PR renders as latest.
    seedWorkspaceRemote();
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-42', 'worktree-pr-42');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await fsp.mkdir(path.dirname(prPath), { recursive: true });
    await fsp.writeFile(
      prPath,
      JSON.stringify({
        prs: [
          {
            number: 42,
            url: 'https://github.com/o/r/pull/42',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
          {
            number: 57,
            url: 'https://github.com/o/r/pull/57',
            createdAt: '2026-08-02T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'worktree-pr-42')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, alreadyBound: 1 });
    const persisted = await readSessionPrs(prPath);
    expect(persisted).toEqual([
      {
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      {
        number: 57,
        url: 'https://github.com/o/r/pull/57',
        createdAt: '2026-08-02T00:00:00.000Z',
      },
    ]);
  });

  it('fails branch mapping closed when the workspace repo key is unknown', async () => {
    // Without a resolvable origin, gh may resolve a default repo that is
    // not this workspace's — its page must not feed branch mapping.
    fetchRemoteWebUrlMock.mockResolvedValue(undefined);
    await seedSession(SESSION_G, 'master');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(31415, 'master')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_G, 'active'),
      ),
    ).toBeNull();
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

  it('marks the session catalog only when a run binds new PRs', async () => {
    // New sidecar bindings are invisible to live-state clients until the
    // catalog revision bumps; a re-run binding nothing must not bump again.
    const workCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-work-'),
    );
    const runtimeBase = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-runtime-'),
    );
    try {
      fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
      const sessionId = '00000000-0000-4000-8000-000000000001';
      const chatsDir = path.join(
        new Storage(workCwd, runtimeBase).getProjectDir(),
        'chats',
      );
      await fsp.mkdir(chatsDir, { recursive: true });
      await fsp.writeFile(
        path.join(chatsDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          uuid: `${sessionId}-user-1`,
          parentUuid: null,
          sessionId,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'hello' }] },
          cwd: workCwd,
        })}\n`,
        'utf8',
      );
      await fsp.writeFile(
        path.join(chatsDir, `${sessionId}.worktree.json`),
        JSON.stringify({
          slug: 'pr-7',
          worktreePath: `${workCwd}/.qwen/worktrees/pr-7`,
          worktreeBranch: 'worktree-pr-7',
          originalCwd: workCwd,
          originalBranch: 'main',
          originalHeadCommit: 'abc123',
        }),
        'utf8',
      );
      fetchGitHubPullRequestsMock.mockResolvedValue({
        kind: 'ok',
        pullRequests: [pr(7, 'worktree-pr-7')],
      });
      const markSessionCatalogChanged = vi.fn();
      const app = express();
      registerSessionPrBackfillRoutes(app, {
        workspaceRegistry: registry([
          {
            workspaceId: 'primary',
            workspaceCwd: workCwd,
            sessionRuntimeBaseDir: runtimeBase,
            primary: true,
            trusted: true,
            env: { mode: 'parent-process', overlayKeys: [] },
            bridge: { markSessionCatalogChanged },
          } as unknown as WorkspaceRuntime,
        ]),
        sendBridgeError,
        mutate: passthroughMutate,
      });

      const first = await request(app).post('/sessions/backfill-prs');

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ bound: 1 });
      expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);

      const second = await request(app).post('/sessions/backfill-prs');
      expect(second.body).toMatchObject({ bound: 0 });
      expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    } finally {
      await fsp.rm(workCwd, { recursive: true, force: true });
      await fsp.rm(runtimeBase, { recursive: true, force: true });
    }
  });
});
