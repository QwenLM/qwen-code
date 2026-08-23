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
  SESSION_PR_LIST_LIMIT,
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

function pr(
  number: number,
  headRefName: string,
  state: 'open' | 'merged' | 'closed' | 'draft' = 'open',
) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    author: 'octocat',
    headRefName,
    state,
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

  it('rejects a zero PR number', () => {
    // `pr-0` is a legal user slug, but binding number 0 invalidates the
    // whole sidecar (isValidSessionPr requires a positive number).
    expect(parsePrNumberFromWorktree('pr-0', 'worktree-pr-0')).toBeUndefined();
    expect(parsePrNumberFromWorktree('pr-00', undefined)).toBeUndefined();
    expect(parsePrNumberFromWorktree('custom', 'worktree-pr-0')).toBe(
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

  it('drops the SSH port from ssh:// remotes', () => {
    // The explicit port is the SSH port, almost never the web port — the
    // badge would link to a dead address if it survived.
    expect(
      normalizeRemoteToWebUrl(
        'ssh://git@github.example.com:2222/team/repo.git',
      ),
    ).toBe('https://github.example.com/team/repo');
  });

  it('keeps an explicit https port', () => {
    // An https remote's port IS the web port and must survive.
    expect(
      normalizeRemoteToWebUrl('https://code.example.com:8443/team/repo.git'),
    ).toBe('https://code.example.com:8443/team/repo');
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
      env: {
        mode: 'parent-process',
        overlayKeys: [],
        effectiveEnv: { GH_TOKEN: 'x' },
      },
    } as unknown as WorkspaceRuntime;
    sessionService = createWorkspaceRuntimeSessionService(runtime);
  });

  afterEach(async () => {
    delete process.env['QWEN_RUNTIME_DIR'];
    await fsp.rm(runtimeDir, { recursive: true, force: true });
    await fsp.rm(workspaceCwd, { recursive: true, force: true });
  });

  async function seedSession(sessionId: string): Promise<void> {
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
    };
    await fsp.writeFile(
      path.join(chatsDir, `${sessionId}.jsonl`),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
  }

  // Appends transcript records carrying gitBranch `b-<i>` for i in
  // [from, to]; session listing maps them to PR head branches.
  async function seedTranscriptBranches(
    sessionId: string,
    from: number,
    to: number,
  ): Promise<void> {
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    for (let i = from; i <= to; i++) {
      await fsp.appendFile(
        path.join(chatsDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          uuid: `${sessionId}-user-${i}`,
          parentUuid: i === 1 ? null : `${sessionId}-user-${i - 1}`,
          sessionId,
          timestamp: '2026-08-02T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'more' }] },
          cwd: workspaceCwd,
          gitBranch: `b-${i}`,
        })}\n`,
        'utf8',
      );
    }
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

  async function seedPrSidecar(
    sessionId: string,
    numbers: readonly number[],
    archiveState: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const prPath = sessionService.getPrSessionPathForArchiveState(
      sessionId,
      archiveState,
    );
    await fsp.mkdir(path.dirname(prPath), { recursive: true });
    await fsp.writeFile(
      prPath,
      JSON.stringify({
        prs: numbers.map((number) => ({
          number,
          url: `https://github.com/o/r/pull/${number}`,
          createdAt: '2026-08-01T00:00:00.000Z',
        })),
      }),
      'utf8',
    );
    return prPath;
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
    // The fetch options are load-bearing: state 'all' makes merged heads
    // bindable, and slim avoids the GraphQL timeouts on large queries.
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledWith(
      workspaceCwd,
      { GH_TOKEN: 'x' },
      { state: 'all', limit: 500, slim: true },
    );
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);
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

  it('binds a merged PR with its terminal state', async () => {
    // `--state all` is load-bearing because merged heads are bindable (the
    // common case for stale worktrees); the accept side needs a witness.
    await seedTranscriptBranches(SESSION_A, 1, 1);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(31, 'b-1', 'merged')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]).toMatchObject({ number: 31, state: 'merged' });
  });

  it('persists a draft PR as open', async () => {
    // The sidecar snapshot has no 'draft' variant, and isValidSessionPr
    // rejects it — a persisted 'draft' would hide the session's bindings.
    await seedTranscriptBranches(SESSION_A, 1, 1);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(44, 'b-1', 'draft')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]).toMatchObject({ number: 44, state: 'open' });
  });

  it('resolves the git remote at most once per workspace', async () => {
    // A PATH shim stands in for git and records every spawn: with gh
    // unavailable and no resolvable remote, three unresolved convention
    // candidates must cost one blocking lookup, not one per session.
    const shimDir = path.join(workspaceCwd, 'git-shim');
    const spawnLog = path.join(workspaceCwd, 'git-spawns.log');
    await fsp.mkdir(shimDir, { recursive: true });
    await fsp.writeFile(
      path.join(shimDir, 'git'),
      `#!/bin/sh\necho "$@" >> "${spawnLog}"\nexit 1\n`,
    );
    await fsp.chmod(path.join(shimDir, 'git'), 0o755);
    await seedSession(SESSION_B);
    await seedWorktreeSidecar(SESSION_B, 'pr-1', 'worktree-pr-1');
    await seedSession(SESSION_C);
    await seedWorktreeSidecar(SESSION_C, 'pr-2', 'worktree-pr-2');
    await seedSession(SESSION_D);
    await seedWorktreeSidecar(SESSION_D, 'pr-3', 'worktree-pr-3');
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${shimDir}${path.delimiter}${previousPath ?? ''}`;

    try {
      const result = await backfillWorkspaceSessionPrs(runtime);

      expect(result).toMatchObject({ bound: 0, unresolved: 3 });
      const spawns = (await fsp.readFile(spawnLog, 'utf8')).trim().split('\n');
      expect(spawns).toEqual(['remote get-url origin']);
    } finally {
      process.env['PATH'] = previousPath;
    }
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

    const before = await fsp.readFile(prPath, 'utf8');

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, alreadyBound: 1 });
    // A re-upsert would refresh createdAt and move the entry to latest,
    // reshuffling which binding the UI renders — the file must be untouched.
    expect(await fsp.readFile(prPath, 'utf8')).toBe(before);
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
    await seedSession(SESSION_G);
    await seedWorktreeSidecar(SESSION_G, 'my-thing', 'worktree-my-thing');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 0, unresolved: 0 });
  });

  it('binds PRs whose head branch appears in the transcript gitBranch', async () => {
    await seedSession(SESSION_G);
    await seedTranscriptBranches(SESSION_G, 1, 1);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'b-1')],
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
    await seedSession(SESSION_G);
    await seedTranscriptBranches(SESSION_G, 1, 2);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'b-1'), pr(43, 'b-2')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 2 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_G, 'active'),
    );
    expect(prs?.map((pr) => pr.number).sort()).toEqual([42, 43]);
  });

  it('binds at most the sidecar cap and stays idempotent across runs', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 12);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: Array.from({ length: 12 }, (_, i) =>
        pr(i + 1, `b-${i + 1}`),
      ),
    });

    const first = await backfillWorkspaceSessionPrs(runtime);
    expect(first).toMatchObject({ bound: 10, overLimit: 2 });
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    const afterFirst = await readSessionPrs(prPath);
    expect(afterFirst?.map((entry) => entry.number)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);

    const second = await backfillWorkspaceSessionPrs(runtime);
    expect(second).toMatchObject({
      bound: 0,
      alreadyBound: 10,
      overLimit: 2,
    });
    expect(await readSessionPrs(prPath)).toEqual(afterFirst);
  });

  it('binds the newest PR when several share one head branch', async () => {
    await seedTranscriptBranches(SESSION_A, 1, 1);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      // gh pr list arrives newest-first; the newest PR owns the reused
      // branch, so the stale merged PR must lose the mapping.
      pullRequests: [pr(250, 'b-1'), pr(10, 'b-1')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.map((entry) => entry.number)).toEqual([250]);
  });

  it('maps a reused head branch to the newest PR regardless of arrival order', async () => {
    await seedTranscriptBranches(SESSION_A, 1, 1);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      // The slim field set omits updatedAt, so nothing guarantees a
      // newest-first arrival order survives parsing; the branch mapping
      // must not depend on it.
      pullRequests: [pr(10, 'b-1'), pr(250, 'b-1')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.map((entry) => entry.number)).toEqual([250]);
  });

  it('keeps the convention number bound when candidates exceed the cap', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 12);
    await seedWorktreeSidecar(SESSION_A, 'pr-50', 'worktree-pr-50');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        pr(50, 'worktree-pr-50'),
        ...Array.from({ length: 12 }, (_, i) => pr(i + 1, `b-${i + 1}`)),
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 10, overLimit: 3 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    // The pr-<N> slug names the session's own PR — the cap slice must not
    // evict it in favor of branch-mapped numbers, and it is planned last so
    // it stays the sidecar's newest entry.
    expect(prs?.map((entry) => entry.number)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 50,
    ]);
  });

  it('keeps the convention number bound when a later run adds a candidate', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 12);
    await seedWorktreeSidecar(SESSION_A, 'pr-50', 'worktree-pr-50');
    const fetchFor = (branchCount: number) =>
      fetchGitHubPullRequestsMock.mockResolvedValue({
        kind: 'ok',
        pullRequests: [
          pr(50, 'worktree-pr-50'),
          ...Array.from({ length: branchCount }, (_, i) =>
            pr(i + 1, `b-${i + 1}`),
          ),
        ],
      });
    fetchFor(12);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );

    await backfillWorkspaceSessionPrs(runtime);
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toContain(50);

    // A new branch appears in the transcript and gh knows its PR: the new
    // binding must evict a branch-mapped number, not the convention one.
    await seedTranscriptBranches(SESSION_A, 13, 13);
    fetchFor(13);

    const second = await backfillWorkspaceSessionPrs(runtime);

    expect(second).toMatchObject({ bound: 1, alreadyBound: 9 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toContain(50);
  });

  it('keeps the convention number bound across accumulating non-overflowing runs', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-50', 'worktree-pr-50');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    const fetchFor = (branchCount: number) =>
      fetchGitHubPullRequestsMock.mockResolvedValue({
        kind: 'ok',
        pullRequests: [
          pr(50, 'worktree-pr-50'),
          ...Array.from({ length: branchCount }, (_, i) =>
            pr(i + 1, `b-${i + 1}`),
          ),
        ],
      });

    // The first run stays under the cap; the convention number must land as
    // the sidecar's newest entry, not its oldest...
    for (let i = 1; i <= 9; i++) {
      await seedTranscriptBranches(SESSION_A, i, i);
      fetchFor(i);
      await backfillWorkspaceSessionPrs(runtime);
    }
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([1, 50, 2, 3, 4, 5, 6, 7, 8, 9]);

    // ...so the run that crosses the cap evicts the oldest entry (a branch
    // mapping); the convention number stays bound.
    await seedTranscriptBranches(SESSION_A, 10, 10);
    fetchFor(10);
    const last = await backfillWorkspaceSessionPrs(runtime);
    expect(last).toMatchObject({ bound: 1, alreadyBound: 9, overLimit: 1 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([50, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('keeps the convention number bound when a capped run trims the window', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 11);
    await seedWorktreeSidecar(SESSION_A, 'pr-50', 'worktree-pr-50');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    // A pre-fix run left the convention number in the oldest slot; planning
    // counts it against the cap up front, so no write ever evicts it.
    await seedPrSidecar(SESSION_A, [50, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        pr(50, 'worktree-pr-50'),
        ...Array.from({ length: 11 }, (_, i) => pr(i + 1, `b-${i + 1}`)),
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 2, alreadyBound: 8, overLimit: 2 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([50, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('keeps convention and dialog bindings when a new number joins a full sidecar', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 9);
    await seedWorktreeSidecar(SESSION_A, 'pr-50', 'worktree-pr-50');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    // Already at the cap, with the convention number in the oldest slot and
    // a dialog-bound entry (99) this run cannot re-resolve; the new binding
    // displaces a branch-mapped number, never 50 or 99.
    await seedPrSidecar(SESSION_A, [50, 1, 2, 3, 4, 5, 6, 7, 8, 99]);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        pr(50, 'worktree-pr-50'),
        ...Array.from({ length: 9 }, (_, i) => pr(i + 1, `b-${i + 1}`)),
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1, alreadyBound: 8, overLimit: 1 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([50, 2, 3, 4, 5, 6, 7, 8, 99, 9]);
  });

  it('preserves dialog-created bindings across cascading capped runs', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 10);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    // 99 was bound from the Git dialog; its head branch never appears in
    // the transcript, so no backfill run can ever re-resolve it — every run
    // must plan around it instead of evicting it.
    await seedPrSidecar(SESSION_A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 99]);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: Array.from({ length: 10 }, (_, i) =>
        pr(i + 1, `b-${i + 1}`),
      ),
    });

    const first = await backfillWorkspaceSessionPrs(runtime);
    expect(first).toMatchObject({ bound: 1, alreadyBound: 8, overLimit: 1 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 99, 10]);

    // Later runs stay idempotent: the displaced number is reported in
    // overLimit every time instead of cascading through the list.
    const second = await backfillWorkspaceSessionPrs(runtime);
    expect(second).toMatchObject({ bound: 0, alreadyBound: 9, overLimit: 1 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 99, 10]);

    const third = await backfillWorkspaceSessionPrs(runtime);
    expect(third).toMatchObject({ bound: 0, alreadyBound: 9, overLimit: 1 });
  });

  it('never evicts an unresolvable binding even when it is the oldest entry', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 8);
    await seedTranscriptBranches(SESSION_A, 10, 11);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    // The dialog binding is the OLDEST entry with displaced branch numbers
    // still on disk: sequential capped writes would rotate through them and
    // evict it mid-loop; a single planned write must keep it.
    await seedPrSidecar(SESSION_A, [99, 1, 2, 3, 4, 5, 6, 7, 8]);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        ...Array.from({ length: 8 }, (_, i) => pr(i + 1, `b-${i + 1}`)),
        pr(10, 'b-10'),
        pr(11, 'b-11'),
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 2, alreadyBound: 7, overLimit: 1 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([99, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
  });

  it('binds nothing when unresolvable bindings already fill the cap', async () => {
    await seedSession(SESSION_A);
    await seedTranscriptBranches(SESSION_A, 1, 1);
    const prPath = await seedPrSidecar(
      SESSION_A,
      Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) => 101 + i),
    );
    const before = await fsp.readFile(prPath, 'utf8');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'b-1')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, alreadyBound: 0, overLimit: 1 });
    expect(await fsp.readFile(prPath, 'utf8')).toBe(before);
  });

  it('keeps backfilling other sessions when one sidecar write fails', async () => {
    await seedTranscriptBranches(SESSION_A, 1, 1);
    await seedTranscriptBranches(SESSION_B, 2, 2);
    const prPathB = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
    );
    // A directory at the sidecar path makes every write fail (EISDIR).
    await fsp.mkdir(prPathB, { recursive: true });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'b-1'), pr(2, 'b-2')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1, writeErrors: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]).toMatchObject({ number: 1 });
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

  it('backfills a trusted workspace and skips untrusted ones', async () => {
    const trustedCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-work-'),
    );
    const trustedRuntimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-runtime-'),
    );
    // Storage(trustedCwd) below resolves its project dir through this env
    // var, exactly like the service's sessionRuntimeBaseDir does.
    process.env['QWEN_RUNTIME_DIR'] = trustedRuntimeDir;
    const trustedRuntime = {
      workspaceId: 'primary',
      workspaceCwd: trustedCwd,
      sessionRuntimeBaseDir: trustedRuntimeDir,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
    } as unknown as WorkspaceRuntime;
    const trustedService = createWorkspaceRuntimeSessionService(trustedRuntime);
    const chatsDir = path.join(
      new Storage(trustedCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    await fsp.writeFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      `${JSON.stringify({
        uuid: `${SESSION_A}-user-1`,
        parentUuid: null,
        sessionId: SESSION_A,
        timestamp: '2026-08-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
        cwd: trustedCwd,
      })}\n`,
      'utf8',
    );
    const worktreePath = trustedService.getWorktreeSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
    await fsp.writeFile(
      worktreePath,
      JSON.stringify({
        slug: 'pr-123',
        worktreePath: `${trustedCwd}/.qwen/worktrees/pr-123`,
        worktreeBranch: 'worktree-pr-123',
        originalCwd: trustedCwd,
        originalBranch: 'main',
        originalHeadCommit: 'abc123',
      }),
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([
        trustedRuntime,
        runtime('secondary', '/work/untrusted', false),
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    try {
      const response = await request(app).post('/sessions/backfill-prs');

      expect(response.status).toBe(200);
      expect(response.body.workspaces).toHaveLength(2);
      const trusted = response.body.workspaces.find(
        (w: { workspaceCwd: string }) => w.workspaceCwd === trustedCwd,
      );
      // The trusted workspace must be processed cleanly, and its non-zero
      // counters must propagate into the aggregated totals.
      expect(trusted.error).toBeUndefined();
      expect(trusted).toMatchObject({ scanned: 1, bound: 1 });
      const untrusted = response.body.workspaces.find(
        (w: { workspaceCwd: string }) => w.workspaceCwd === '/work/untrusted',
      );
      expect(untrusted.error).toBe('untrusted workspace skipped');
      expect(response.body).toMatchObject({ v: 1, scanned: 1, bound: 1 });
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      await fsp.rm(trustedCwd, { recursive: true, force: true });
      await fsp.rm(trustedRuntimeDir, { recursive: true, force: true });
    }
  });
});
