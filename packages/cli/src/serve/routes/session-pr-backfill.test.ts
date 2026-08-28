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
  fetchAttributionRepoKeys,
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  readSessionPrs,
  upsertSessionPr,
  writeSessionPrs,
  type SessionService,
} from '@qwen-code/qwen-code-core';
import { SessionArchivingError } from '../acp-session-bridge.js';
import {
  AONE_MAX_MR_VIEW_CALLS_PER_RUN,
  AoneCommandError,
  type AoneMrBackend,
} from '../server/aone-mrs.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  DaemonDrainingError,
  SessionArchiveCoordinator,
} from '../server/session-archive.js';
import * as sessionListModule from '../server/session-list.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  WorkspaceGenerationClosedError,
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceGenerationGuard,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { SessionPrInfo } from '@qwen-code/acp-bridge/bridgeTypes';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  backfillWorkspaceSessionPrs,
  normalizeRemoteToWebUrl,
  parsePrNumberFromWorktree,
  registerSessionPrBackfillRoutes,
} from './session-pr-backfill.js';

const sidecarReadHook = vi.hoisted(() => ({
  current: undefined as { path: string; run: () => Promise<void> } | undefined,
}));
const sidecarCommitHook = vi.hoisted(() => ({
  current: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    fetchAttributionRepoKeys: vi.fn(),
    fetchGitHubPullRequests: vi.fn(),
    fetchRemoteWebUrl: vi.fn(),
    // Test seam: fires a concurrent writer between the backfill's
    // out-of-queue snapshot read and its queued write, deterministically.
    readSessionPrs: vi.fn(
      async (
        filePath: string,
        options?: Parameters<typeof original.readSessionPrs>[1],
      ) => {
        const result = await original.readSessionPrs(filePath, options);
        const hook = sidecarReadHook.current;
        if (hook && hook.path === filePath) {
          sidecarReadHook.current = undefined;
          await hook.run();
        }
        return result;
      },
    ),
    // Test seam: fires a concurrent writer right after the backfill's
    // queued rewrite commits, before the continuation that follows it —
    // the deterministic interleaving the live-entry sync must survive.
    replaceSessionPrs: vi.fn(
      async (
        filePath: string,
        plan: Parameters<typeof original.replaceSessionPrs>[1],
      ) => {
        const result = await original.replaceSessionPrs(filePath, plan);
        const hook = sidecarCommitHook.current;
        if (hook) {
          sidecarCommitHook.current = undefined;
          await hook();
        }
        return result;
      },
    ),
  };
});

const fetchAttributionRepoKeysMock = vi.mocked(fetchAttributionRepoKeys);
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
    // The repo-key gate fail-closes without a resolvable workspace origin,
    // so tests default to the same repo the `pr()` fixture URLs belong to.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    fetchAttributionRepoKeysMock.mockResolvedValue({});
    sidecarReadHook.current = undefined;
    sidecarCommitHook.current = undefined;
    runtimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-runtime-'),
    );
    workspaceCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-work-'),
    );
    // A healthy workspace has refs/remotes/origin/HEAD — model it so head-
    // branch mapping runs; the fail-closed test deletes the symref.
    execSync('git init', { cwd: workspaceCwd, stdio: 'pipe' });
    execSync(
      'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main',
      { cwd: workspaceCwd, stdio: 'pipe' },
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
      bridge: { markSessionCatalogChanged: vi.fn() },
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

  // Appends user records typing `/review <i>` for i in [from, to]; the
  // review source maps them straight to PR numbers (transcript branch
  // mapping was removed as measured noise).
  async function seedReviewedNumbers(
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
          uuid: `${sessionId}-review-${i}`,
          parentUuid: i === from ? null : `${sessionId}-review-${i - 1}`,
          sessionId,
          timestamp: '2026-08-02T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: `/review ${i}` }] },
          cwd: workspaceCwd,
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

    expect(result).toMatchObject({
      scanned: 1,
      bound: 1,
      unresolved: 0,
      ghAvailable: true,
    });
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
        source: 'worktree',
      },
    ]);
  });

  it('binds a merged PR with its terminal state', async () => {
    // `--state all` is load-bearing because merged heads are bindable (the
    // common case for stale worktrees); the accept side needs a witness.
    await seedReviewedNumbers(SESSION_A, 31, 31);
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

  describe('on an Aone workspace', () => {
    function fakeAoneBackend(
      overrides: Partial<AoneMrBackend> = {},
    ): AoneMrBackend {
      return {
        list: vi.fn(async () => []),
        view: vi.fn(async (repoPath: string, id: number) => ({
          number: id,
          url: `https://code.alibaba-inc.com/${repoPath}/codereview/${id}`,
          state: 'merged' as const,
        })),
        ...overrides,
      };
    }

    // Platform detection reads the real origin; the mocked remote lookup
    // must agree so the legacy-shape detector sees the same web root.
    function aoneOrigin(): void {
      execSync(
        'git remote add origin git@gitlab.alibaba-inc.com:jspt/agentic_coding.git',
        { cwd: workspaceCwd, stdio: 'pipe' },
      );
      fetchRemoteWebUrlMock.mockResolvedValue(
        'https://gitlab.alibaba-inc.com/jspt/agentic_coding',
      );
    }

    it('resolves the slug convention through mr view, never fabricating', async () => {
      aoneOrigin();
      await seedSession(SESSION_A);
      await seedWorktreeSidecar(SESSION_A, 'pr-26430560', 'wt-local-only');
      const backend = fakeAoneBackend();

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(result).toMatchObject({
        scanned: 1,
        bound: 1,
        unresolved: 0,
        platform: 'aone',
      });
      expect(result.ghAvailable).toBeUndefined();
      expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
      expect(fetchAttributionRepoKeysMock).not.toHaveBeenCalled();
      expect(backend.view).toHaveBeenCalledWith(
        'jspt/agentic_coding',
        26430560,
      );
      const prs = await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      );
      expect(prs).toEqual([
        {
          number: 26430560,
          url: 'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/26430560',
          createdAt: expect.any(String),
          state: 'merged',
          source: 'worktree',
        },
      ]);
    });

    it('resolves /review numbers through mr view', async () => {
      aoneOrigin();
      await seedReviewedNumbers(SESSION_A, 26430560, 26430560);
      const backend = fakeAoneBackend({
        view: vi.fn(async (repoPath: string, id: number) => ({
          number: id,
          url: `https://code.alibaba-inc.com/${repoPath}/codereview/${id}`,
          state: 'open' as const,
        })),
      });

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(result).toMatchObject({ bound: 1, platform: 'aone' });
      const prs = await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      );
      expect(prs?.[0]).toMatchObject({
        number: 26430560,
        url: 'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/26430560',
        state: 'open',
        source: 'review',
      });
    });

    it('never falls back to the remote web URL for an Aone number', async () => {
      aoneOrigin();
      await seedSession(SESSION_A);
      await seedWorktreeSidecar(SESSION_A, 'pr-888', 'wt-local-only');
      const backend = fakeAoneBackend({
        view: vi.fn(async () => {
          throw new AoneCommandError('403 Forbidden');
        }),
      });

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(result).toMatchObject({
        bound: 0,
        unresolved: 1,
        platform: 'aone',
      });
      expect(
        await readSessionPrs(
          sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
        ),
      ).toBeNull();
    });

    it('caps mr view calls per run', async () => {
      aoneOrigin();
      // Distinct convention numbers across sessions, one view each, until
      // the cap; the excess stays unresolved for the next run.
      const view = vi.fn(async (repoPath: string, id: number) => ({
        number: id,
        url: `https://code.alibaba-inc.com/${repoPath}/codereview/${id}`,
        state: 'merged' as const,
      }));
      for (let i = 0; i < AONE_MAX_MR_VIEW_CALLS_PER_RUN + 2; i++) {
        const sessionId = `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`;
        await seedSession(sessionId);
        await seedWorktreeSidecar(sessionId, `pr-${9000 + i}`, 'wt-local-only');
      }
      const backend = fakeAoneBackend({ view });

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
      expect(result).toMatchObject({
        bound: AONE_MAX_MR_VIEW_CALLS_PER_RUN,
        unresolved: 2,
        platform: 'aone',
      });

      // Steady state: the second run re-plans all 25 already-bound numbers
      // but must NOT spend the view budget re-attesting them (their stored
      // URLs match this repo's detailUrl shape) — the two still-unbound
      // sessions get the budget and converge. A re-attestation regressor
      // exhausts the 25 calls on the bound numbers and leaves run 2 with
      // bound: 0, unresolved: 2, forever.
      const second = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );
      expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN + 2);
      expect(second).toMatchObject({
        bound: 2,
        unresolved: 0,
        platform: 'aone',
      });
    });

    it('keeps a GHE-shaped origin on the GitHub path', async () => {
      // `*.alibaba-inc.com` also names GitHub Enterprise instances; such a
      // workspace must stay on gh (which resolves the enterprise host from
      // the origin) instead of being displaced onto a1.
      execSync(
        'git remote add origin git@ghe.alibaba-inc.com:team/project.git',
        { cwd: workspaceCwd, stdio: 'pipe' },
      );
      await seedSession(SESSION_A);
      await seedWorktreeSidecar(SESSION_A, 'pr-5', 'worktree-pr-5');
      fetchGitHubPullRequestsMock.mockResolvedValue({
        kind: 'ok',
        pullRequests: [pr(5, 'worktree-pr-5', 'merged')],
      });
      const backend = fakeAoneBackend();

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(result).toMatchObject({
        platform: 'github',
        ghAvailable: true,
        bound: 1,
      });
      expect(backend.view).not.toHaveBeenCalled();
      const prs = await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      );
      expect(prs?.[0]).toMatchObject({
        number: 5,
        url: 'https://github.com/o/r/pull/5',
        state: 'merged',
      });
    });

    it('keeps a foreign same-numbered binding out of the cap plan', async () => {
      aoneOrigin();
      // Two planned numbers: a reviewed number colliding with a foreign
      // binding, plus a convention number — the cap pressure that trims the
      // colliding number unless the identity guard keeps it foreign.
      await seedReviewedNumbers(SESSION_A, 26430560, 26430560);
      await seedWorktreeSidecar(SESSION_A, 'pr-500', 'wt-local-only');
      // Fill the sidecar to the cap; the metadata route accepts any http(s)
      // pr.url, so a foreign entry can carry the colliding number.
      const foreign: number[] = [];
      for (let i = 1; i < SESSION_PR_LIST_LIMIT; i++) {
        foreign.push(1000 + i);
      }
      await seedPrSidecar(SESSION_A, foreign);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await upsertSessionPr(prPath, {
        number: 26430560,
        url: 'https://github.com/elsewhere/other/pull/26430560',
      });
      const backend = fakeAoneBackend();

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(result).toMatchObject({
        bound: 0,
        platform: 'aone',
        overLimit: 1,
      });
      // The colliding number is already bound, so it is never viewed; the
      // github-shaped entries are foreign to this repoPath and hold their
      // slots.
      expect(backend.view).toHaveBeenCalledTimes(1);
      expect(backend.view).toHaveBeenCalledWith('jspt/agentic_coding', 500);
      const prs = await readSessionPrs(prPath);
      const collided = prs?.find((p) => p.number === 26430560);
      expect(collided?.url).toBe(
        'https://github.com/elsewhere/other/pull/26430560',
      );
      expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    });

    it('evicts a re-planned entry when a full sidecar gains a new MR', async () => {
      aoneOrigin();
      // A long-lived session at the cap: number 1 is re-offered this run,
      // MR 11 does not exist in the sidecar yet. Every entry is a review
      // binding, so the cap trims by position.
      await seedReviewedNumbers(SESSION_A, 1, 1);
      await seedReviewedNumbers(SESSION_A, 11, 11);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await fsp.mkdir(path.dirname(prPath), { recursive: true });
      await fsp.writeFile(
        prPath,
        JSON.stringify({
          prs: Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) => ({
            number: i + 1,
            url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${i + 1}`,
            createdAt: '2026-08-01T00:00:00.000Z',
            state: 'merged',
            source: 'review',
          })),
        }),
        'utf8',
      );
      const view = vi.fn(async (repoPath: string, id: number) => ({
        number: id,
        url: `https://code.alibaba-inc.com/${repoPath}/codereview/${id}`,
        state: 'merged' as const,
      }));
      const backend = fakeAoneBackend({ view });

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      // The existing entries match the exact detailUrl shape of this
      // repoPath, so the closed identity guard classifies them own — and
      // trimmable — WITHOUT a re-attestation view; the only view is the
      // new binding's. Without the shape check every entry counted
      // foreign, slots fell to zero, and the new MR was overLimit forever.
      expect(view).toHaveBeenCalledTimes(1);
      expect(view).toHaveBeenCalledWith('jspt/agentic_coding', 11);
      expect(result).toMatchObject({
        bound: 1,
        overLimit: 1,
        platform: 'aone',
      });
      const prs = await readSessionPrs(prPath);
      expect(prs?.map((p) => p.number)).toEqual([
        2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
    });

    it('repairs a legacy fabricated /pull/ binding via mr view', async () => {
      aoneOrigin();
      await seedSession(SESSION_A);
      await seedWorktreeSidecar(SESSION_A, 'pr-777', 'wt-local-only');
      // The pre-Aone backfill persisted this fabricated shape; without
      // repair its state stays frozen and burns one view call per refresh
      // sweep.
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      const seeded = await upsertSessionPr(prPath, {
        number: 777,
        url: 'https://gitlab.alibaba-inc.com/jspt/agentic_coding/pull/777',
        source: 'worktree',
      });

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: fakeAoneBackend() },
      );

      expect(result).toMatchObject({
        platform: 'aone',
        bound: 0,
        written: 1,
      });
      const prs = await readSessionPrs(prPath);
      expect(prs).toEqual([
        {
          number: 777,
          url: 'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/777',
          createdAt: seeded[0]?.createdAt,
          state: 'merged',
          source: 'worktree',
        },
      ]);
    });

    it('leaves a legacy fabricated binding untouched when mr view fails', async () => {
      aoneOrigin();
      await seedSession(SESSION_A);
      await seedWorktreeSidecar(SESSION_A, 'pr-888', 'wt-local-only');
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      const seeded = await upsertSessionPr(prPath, {
        number: 888,
        url: 'https://gitlab.alibaba-inc.com/jspt/agentic_coding/pull/888',
      });
      const backend = fakeAoneBackend({
        view: vi.fn(async () => {
          throw new AoneCommandError('403 Forbidden');
        }),
      });

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(result).toMatchObject({ bound: 0, written: 0, platform: 'aone' });
      const prs = await readSessionPrs(prPath);
      expect(prs).toEqual([
        {
          number: 888,
          url: 'https://gitlab.alibaba-inc.com/jspt/agentic_coding/pull/888',
          createdAt: seeded[0]?.createdAt,
        },
      ]);
    });

    it('repairs an unplanned fabricated entry alongside a planned binding', async () => {
      aoneOrigin();
      // The fabricated number sits OUTSIDE this run's planned list while a
      // reviewed number binds — repair iterates every existing entry,
      // never just the planned ones.
      await seedReviewedNumbers(SESSION_A, 500, 500);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      const seeded = await upsertSessionPr(prPath, {
        number: 999,
        url: 'https://gitlab.alibaba-inc.com/jspt/agentic_coding/pull/999',
      });
      const backend = fakeAoneBackend({
        view: vi.fn(async (repoPath: string, id: number) => ({
          number: id,
          url: `https://code.alibaba-inc.com/${repoPath}/codereview/${id}`,
          state: id === 500 ? ('open' as const) : ('merged' as const),
        })),
      });

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: backend },
      );

      expect(result).toMatchObject({ bound: 1, platform: 'aone' });
      const prs = await readSessionPrs(prPath);
      expect(prs).toEqual([
        {
          number: 999,
          url: 'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/999',
          createdAt: seeded[0]?.createdAt,
          state: 'merged',
        },
        {
          number: 500,
          url: 'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/500',
          createdAt: expect.any(String),
          state: 'open',
          source: 'review',
        },
      ]);
    });

    it('repairs a legacy fabricated binding when nothing is planned this run', async () => {
      aoneOrigin();
      // No worktree sidecar and no /review command: nothing is planned —
      // repair must still run, or the fabricated entry stays frozen and
      // burns one capped view call per refresh sweep, forever.
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      const seeded = await upsertSessionPr(prPath, {
        number: 777,
        url: 'https://gitlab.alibaba-inc.com/jspt/agentic_coding/pull/777',
      });
      const view = vi.fn(async (repoPath: string, id: number) => ({
        number: id,
        url: `https://code.alibaba-inc.com/${repoPath}/codereview/${id}`,
        state: 'merged' as const,
      }));

      const result = await backfillWorkspaceSessionPrs(
        runtime,
        undefined,
        undefined,
        { aoneBackend: fakeAoneBackend({ view }) },
      );

      expect(view).toHaveBeenCalledWith('jspt/agentic_coding', 777);
      expect(result).toMatchObject({
        scanned: 1,
        bound: 0,
        written: 1,
        platform: 'aone',
      });
      const prs = await readSessionPrs(prPath);
      expect(prs).toEqual([
        {
          number: 777,
          url: 'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/777',
          createdAt: seeded[0]?.createdAt,
          state: 'merged',
        },
      ]);
    });
  });
  it('persists a draft PR as open', async () => {
    // The sidecar snapshot has no 'draft' variant, and isValidSessionPr
    // rejects it — a persisted 'draft' would hide the session's bindings.
    await seedReviewedNumbers(SESSION_A, 44, 44);
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
    // With gh unavailable and no resolvable remote, three unresolved
    // convention candidates must cost one remote lookup, not one per
    // session.
    await seedSession(SESSION_B);
    await seedWorktreeSidecar(SESSION_B, 'pr-1', 'worktree-pr-1');
    await seedSession(SESSION_C);
    await seedWorktreeSidecar(SESSION_C, 'pr-2', 'worktree-pr-2');
    await seedSession(SESSION_D);
    await seedWorktreeSidecar(SESSION_D, 'pr-3', 'worktree-pr-3');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });
    fetchRemoteWebUrlMock.mockResolvedValue(undefined);

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, unresolved: 3 });
    // An unresolved convention number must not reach a write: a url-less
    // entry fails isValidSessionPr and would void the whole sidecar.
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
      ),
    ).toBeNull();
    expect(fetchRemoteWebUrlMock).toHaveBeenCalledTimes(1);
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

    // A failed gh fetch degrades to the git-remote fallback — the result
    // must say so, or a degraded run is indistinguishable from an empty one.
    expect(result).toMatchObject({
      bound: 1,
      unresolved: 0,
      ghAvailable: false,
    });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
    );
    expect(prs?.[0]).toMatchObject({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
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

  it('binds at most the sidecar cap and stays idempotent across runs', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 12);
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

  it('scans every session of a workspace beyond one listing page', async () => {
    // The sweep enumerates every persisted session; a workspace with more
    // than a thousand sessions must be scanned and bound in full — a scan
    // that stops at the first page would silently backfill only it.
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    const total = 1001;
    const baseSeconds = Math.floor(Date.now() / 1000) - total - 10;
    for (let chunk = 0; chunk < total; chunk += 100) {
      const batch: Array<Promise<unknown>> = [];
      for (let i = chunk; i < Math.min(chunk + 100, total); i++) {
        const sessionId = `00000000-0000-4000-8000-${i
          .toString(16)
          .padStart(12, '0')}`;
        const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
        batch.push(
          fsp
            .writeFile(
              filePath,
              `${JSON.stringify({
                uuid: `${sessionId}-user-1`,
                parentUuid: null,
                sessionId,
                timestamp: '2026-08-01T00:00:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'hello' }] },
                cwd: workspaceCwd,
              })}\n`,
              'utf8',
            )
            // Distinct mtimes; the mtime-tie hazard has its own test below.
            .then(() => fsp.utimes(filePath, baseSeconds + i, baseSeconds + i)),
        );
      }
      await Promise.all(batch);
    }
    // The only convention binding sits on the oldest session — page 2 of
    // the 1000-entry cursor.
    await seedWorktreeSidecar(
      '00000000-0000-4000-8000-000000000000',
      'pr-9',
      'worktree-pr-9',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(9, 'worktree-pr-9')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1001, bound: 1 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(
          '00000000-0000-4000-8000-000000000000',
          'active',
        ),
      ),
    ).not.toBeNull();
  }, 30000);

  it('scans sessions whose mtime ties across the old page boundary', async () => {
    // listSessions pages with a strict `mtime < cursor` filter and returns
    // the page's last mtime as the cursor — sessions tied with that entry
    // are filtered out on every run, the hazard findSessionsByTitle
    // documents for not paging listSessions. Two files tied across the
    // 1000-entry boundary must both be scanned and bound.
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    const total = 1001;
    const baseSeconds = Math.floor(Date.now() / 1000) - total - 10;
    for (let chunk = 0; chunk < total; chunk += 100) {
      const batch: Array<Promise<unknown>> = [];
      for (let i = chunk; i < Math.min(chunk + 100, total); i++) {
        const sessionId = `00000000-0000-4000-8000-${i
          .toString(16)
          .padStart(12, '0')}`;
        const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
        batch.push(
          fsp
            .writeFile(
              filePath,
              `${JSON.stringify({
                uuid: `${sessionId}-user-1`,
                parentUuid: null,
                sessionId,
                timestamp: '2026-08-01T00:00:00.000Z',
                type: 'user',
                message: { role: 'user', parts: [{ text: 'hello' }] },
                cwd: workspaceCwd,
              })}\n`,
              'utf8',
            )
            // Sessions 0 and 1 share an mtime; every other file is
            // distinct, so the tied pair straddles the boundary.
            .then(() =>
              fsp.utimes(
                filePath,
                i <= 1 ? baseSeconds : baseSeconds + i,
                i <= 1 ? baseSeconds : baseSeconds + i,
              ),
            ),
        );
      }
      await Promise.all(batch);
    }
    // Each twin carries a convention binding: whichever side of the lost
    // listing page one lands on, its binding must still be persisted.
    await seedWorktreeSidecar(
      '00000000-0000-4000-8000-000000000000',
      'pr-9',
      'worktree-pr-9',
    );
    await seedWorktreeSidecar(
      '00000000-0000-4000-8000-000000000001',
      'pr-10',
      'worktree-pr-10',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(9, 'worktree-pr-9'), pr(10, 'worktree-pr-10')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1001, bound: 2 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(
          '00000000-0000-4000-8000-000000000000',
          'active',
        ),
      ),
    ).not.toBeNull();
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(
          '00000000-0000-4000-8000-000000000001',
          'active',
        ),
      ),
    ).not.toBeNull();
  }, 30000);

  it('keeps the convention number bound when candidates exceed the cap', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 12);
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
    await seedReviewedNumbers(SESSION_A, 1, 12);
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
    await seedReviewedNumbers(SESSION_A, 13, 13);
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
      await seedReviewedNumbers(SESSION_A, i, i);
      fetchFor(i);
      await backfillWorkspaceSessionPrs(runtime);
    }
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([1, 50, 2, 3, 4, 5, 6, 7, 8, 9]);

    // ...so the run that crosses the cap evicts the oldest entry (a branch
    // mapping); the convention number stays bound.
    await seedReviewedNumbers(SESSION_A, 10, 10);
    fetchFor(10);
    const last = await backfillWorkspaceSessionPrs(runtime);
    expect(last).toMatchObject({ bound: 1, alreadyBound: 9, overLimit: 1 });
    expect(
      (await readSessionPrs(prPath))?.map((entry) => entry.number),
    ).toEqual([50, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('keeps the convention number bound when a capped run trims the window', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 11);
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
    await seedReviewedNumbers(SESSION_A, 1, 9);
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
    await seedReviewedNumbers(SESSION_A, 1, 10);
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

  it('syncs the live bridge entry when a capped plan evicts bindings', async () => {
    // The summary merge unions persisted sidecar and hydrated live entry by
    // number. An eviction that only rewrites the sidecar leaves the stale
    // entry resurrecting the evicted numbers until a daemon restart — the
    // rendered badge list even grows past the cap.
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 12);
    await seedPrSidecar(SESSION_A, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Models the real bridge: the live entry is hydrated from the full
    // sidecar (as a metadata PATCH does), and setSessionPrs overwrites it.
    const hydrated = Array.from({ length: 10 }, (_, i) => ({
      number: i + 1,
      url: `https://github.com/o/r/pull/${i + 1}`,
    }));
    const liveSummary: {
      sessionId: string;
      workspaceCwd: string;
      createdAt: string;
      updatedAt: string;
      displayName: string;
      clientCount: number;
      hasActivePrompt: boolean;
      isArchived: boolean;
      prs: SessionPrInfo[];
    } = {
      sessionId: SESSION_A,
      workspaceCwd,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      displayName: 'live session',
      clientCount: 0,
      hasActivePrompt: false,
      isArchived: false,
      prs: hydrated,
    };
    const bridge = {
      markSessionCatalogChanged: vi.fn(),
      setSessionPrs: vi.fn((sessionId: string, prs: SessionPrInfo[]) => {
        if (sessionId === SESSION_A) liveSummary.prs = prs;
      }),
      listWorkspaceSessions: vi.fn(() => [liveSummary]),
    };
    const runtimeWithBridge = {
      ...runtime,
      bridge,
    } as unknown as WorkspaceRuntime;
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: Array.from({ length: 12 }, (_, i) =>
        pr(i + 1, `b-${i + 1}`),
      ),
    });

    const result = await backfillWorkspaceSessionPrs(runtimeWithBridge);

    expect(result).toMatchObject({ bound: 2, written: 1, overLimit: 2 });
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    const persisted = await readSessionPrs(prPath);
    expect(persisted?.map((p) => p.number)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    // The hydrated entry of a live session must be rewritten to the
    // persisted membership, not left stale at the pre-eviction list.
    expect(bridge.setSessionPrs).toHaveBeenCalledTimes(1);
    expect(bridge.setSessionPrs).toHaveBeenCalledWith(
      SESSION_A,
      persisted?.map(({ number, url, state }) => ({
        number,
        url,
        ...(state ? { state } : {}),
      })),
    );

    // End-to-end witness: the sidebar list merge must not resurrect the
    // evicted numbers from the stale hydrated entry.
    const list = await sessionListModule.listWorkspaceSessionsForResponse(
      bridge as unknown as AcpSessionBridge,
      workspaceCwd,
      undefined,
      { runtimeBaseDir: runtimeDir },
    );
    const summary = list.sessions.find((s) => s.sessionId === SESSION_A);
    expect(summary?.prs?.map((p) => p.number)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('never evicts an unresolvable binding even when it is the oldest entry', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 8);
    await seedReviewedNumbers(SESSION_A, 10, 11);
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

  it('keeps a foreign same-numbered binding out of the cap plan', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 9);
    // The sidecar holds a dialog-created binding to ANOTHER repository's
    // PR #5 (the metadata route validates number + url shape only, not
    // repository membership) among unresolvable dialog bindings, while
    // this run maps this repo's PRs #1-#9 — colliding on 5.
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await fsp.mkdir(path.dirname(prPath), { recursive: true });
    await fsp.writeFile(
      prPath,
      JSON.stringify({
        prs: [
          ...Array.from({ length: 8 }, (_, i) => ({
            number: 101 + i,
            url: `https://github.com/o/elsewhere/pull/${101 + i}`,
            createdAt: '2026-08-01T00:00:00.000Z',
          })),
          {
            number: 5,
            url: 'https://github.com/other-org/other-repo/pull/5',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: Array.from({ length: 9 }, (_, i) =>
        pr(i + 1, `b-${i + 1}`),
      ),
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    // The foreign #5 is not the PR this run resolved for number 5, so it
    // keeps its slot instead of being trimmed out of the plan — evicting
    // it would let the next run silently flip the binding to this repo's
    // same-numbered PR.
    const prs = await readSessionPrs(prPath);
    expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(prs?.map((entry) => entry.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108, 5, 9,
    ]);
    expect(prs?.find((entry) => entry.number === 5)?.url).toBe(
      'https://github.com/other-org/other-repo/pull/5',
    );
    expect(result).toMatchObject({ bound: 1, alreadyBound: 0, overLimit: 7 });
  });

  it('binds nothing when unresolvable bindings already fill the cap', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 1);
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

  it('keeps a binding that lands between the snapshot read and the queued write', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 42, 43);
    const prPath = await seedPrSidecar(
      SESSION_A,
      Array.from({ length: 9 }, (_, i) => 101 + i),
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'b-42'), pr(43, 'b-43')],
    });
    // The dialog binds #42 after the backfill's snapshot read and before
    // its queued write. This run resolved 42 too, so a plan frozen from
    // the snapshot sees a droppable-but-unplanned entry and must not
    // delete the user's binding.
    sidecarReadHook.current = {
      path: prPath,
      run: () =>
        upsertSessionPr(prPath, {
          number: 42,
          url: 'https://github.com/o/r/pull/42',
        }).then(() => undefined),
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    const prs = await readSessionPrs(prPath);
    expect(prs?.map((entry) => entry.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108, 109, 42,
    ]);
    expect(result).toMatchObject({ bound: 0, overLimit: 1 });
  });

  it('re-plans around a concurrent foreign binding instead of exceeding the cap', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 2);
    const prPath = await seedPrSidecar(
      SESSION_A,
      Array.from({ length: 8 }, (_, i) => 101 + i),
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'b-1'), pr(2, 'b-2')],
    });
    sidecarReadHook.current = {
      path: prPath,
      run: () =>
        upsertSessionPr(prPath, {
          number: 99,
          url: 'https://github.com/o/r/pull/99',
        }).then(() => undefined),
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    const prs = await readSessionPrs(prPath);
    expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(prs?.map((entry) => entry.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108, 99, 2,
    ]);
    expect(result).toMatchObject({ bound: 1, overLimit: 1 });
  });

  it('does not bill a concurrently bound planned number twice against the cap', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 2);
    const prPath = await seedPrSidecar(
      SESSION_A,
      Array.from({ length: 8 }, (_, i) => 101 + i),
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'b-1'), pr(2, 'b-2')],
    });
    // The dialog binds #2 in the seam and the run resolves 1 and 2: the
    // fresh #2 already holds its slot, so the plan must not bill it again
    // as a member — all ten distinct numbers fit the ten slots, nothing
    // is trimmed, and the present #2 is not re-added.
    sidecarReadHook.current = {
      path: prPath,
      run: () =>
        upsertSessionPr(prPath, {
          number: 2,
          url: 'https://github.com/o/r/pull/2',
        }).then(() => undefined),
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    const prs = await readSessionPrs(prPath);
    expect(prs?.map((entry) => entry.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108, 2, 1,
    ]);
    expect(result).toMatchObject({ bound: 1, alreadyBound: 0, overLimit: 0 });
  });

  it('keeps a snapshot-held number a client re-binds during the run', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 5, 7);
    const prPath = await seedPrSidecar(
      SESSION_A,
      [101, 102, 103, 104, 105, 106, 107, 108, 5],
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(5, 'b-5'), pr(6, 'b-6'), pr(7, 'b-7')],
    });
    // The client re-binds #5 — a planned number the snapshot already held —
    // in the seam between the snapshot read and the queued rewrite. The
    // fresh entry is not the one this run planned for: trimming it out of
    // the plan would evict a binding the daemon just confirmed.
    sidecarReadHook.current = {
      path: prPath,
      run: () =>
        upsertSessionPr(prPath, {
          number: 5,
          url: 'https://github.com/o/r/pull/5',
        }).then(() => undefined),
    };
    const setSessionPrs = vi.fn();
    const runtimeWithBridge = {
      ...runtime,
      bridge: { markSessionCatalogChanged: vi.fn(), setSessionPrs },
    } as unknown as WorkspaceRuntime;

    const result = await backfillWorkspaceSessionPrs(runtimeWithBridge);

    const prs = await readSessionPrs(prPath);
    expect(prs?.map((entry) => entry.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108, 5, 7,
    ]);
    expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(result).toMatchObject({ bound: 1, overLimit: 1 });
    // The live-entry sync must publish the surviving binding, not the
    // cap-trimmed list that dropped it.
    expect(setSessionPrs).toHaveBeenCalledWith(
      SESSION_A,
      expect.arrayContaining([expect.objectContaining({ number: 5 })]),
    );
  });

  it('syncs the live entry from the freshest list when a bind lands after the rewrite', async () => {
    // A dialog bind commits between the queued rewrite and the live-entry
    // sync: the sync must publish it, not the rewrite-time snapshot that
    // lacks it — a post-commit call with the snapshot would clobber the
    // bind from the live entry while the sidecar keeps it.
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 2);
    const prPath = await seedPrSidecar(
      SESSION_A,
      Array.from({ length: 7 }, (_, i) => 101 + i),
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'b-1'), pr(2, 'b-2')],
    });
    sidecarCommitHook.current = () =>
      upsertSessionPr(prPath, {
        number: 99,
        url: 'https://github.com/o/r/pull/99',
      }).then(() => undefined);
    const setSessionPrs = vi.fn();
    const runtimeWithBridge = {
      ...runtime,
      bridge: { markSessionCatalogChanged: vi.fn(), setSessionPrs },
    } as unknown as WorkspaceRuntime;

    const result = await backfillWorkspaceSessionPrs(runtimeWithBridge);

    expect(result).toMatchObject({ bound: 2, written: 1 });
    const prs = await readSessionPrs(prPath);
    expect(prs?.map((entry) => entry.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 1, 2, 99,
    ]);
    expect(setSessionPrs).toHaveBeenCalledTimes(1);
    expect(setSessionPrs).toHaveBeenLastCalledWith(
      SESSION_A,
      expect.arrayContaining([expect.objectContaining({ number: 99 })]),
    );
  });

  it('counts in bound only the bindings the write actually persisted', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 3);
    const prPath = await seedPrSidecar(
      SESSION_A,
      Array.from({ length: 7 }, (_, i) => 101 + i),
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'b-1'), pr(2, 'b-2'), pr(3, 'b-3')],
    });
    // The concurrent bind is a number this run also resolved: it must not
    // be counted as bound again when the additions are deduped.
    sidecarReadHook.current = {
      path: prPath,
      run: () =>
        upsertSessionPr(prPath, {
          number: 1,
          url: 'https://github.com/o/r/pull/1',
        }).then(() => undefined),
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    const prs = await readSessionPrs(prPath);
    expect(prs?.map((entry) => entry.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 1, 2, 3,
    ]);
    expect(result.bound).toBe(2);
  });

  it('does not re-add a planned number a concurrent upsert evicted at the cap', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 8);
    await seedWorktreeSidecar(SESSION_A, 'pr-50', 'worktree-pr-50');
    const prPath = await seedPrSidecar(
      SESSION_A,
      [50, 1, 2, 3, 4, 5, 6, 7, 8, 99],
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        pr(50, 'worktree-pr-50'),
        ...Array.from({ length: 8 }, (_, i) => pr(i + 1, `b-${i + 1}`)),
      ],
    });
    // The dialog binding lands in the seam and evicts 50 — the oldest
    // entry, a planned number the URL loop skipped because the snapshot
    // already held it. Re-adding 50 without a URL would persist an entry
    // isValidSessionPr rejects, voiding the whole sidecar; it must be left
    // to the next run to re-bind.
    sidecarReadHook.current = {
      path: prPath,
      run: () =>
        upsertSessionPr(prPath, {
          number: 77,
          url: 'https://github.com/o/r/pull/77',
        }).then(() => undefined),
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    const prs = await readSessionPrs(prPath);
    expect(prs).not.toBeNull();
    expect(prs?.map((entry) => entry.number)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 99, 77,
    ]);
    expect(result).toMatchObject({ bound: 0, alreadyBound: 7, overLimit: 1 });
  });

  it('does not resurrect the sidecar of a session deleted mid-run', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    // removeSession unlinks the sidecar outside the mutation queue; the
    // queued planner must see the session is gone and skip the write.
    sidecarReadHook.current = {
      path: prPath,
      run: async () => {
        await sessionService.removeSession(SESSION_A);
      },
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result.bound).toBe(0);
    expect(await readSessionPrs(prPath)).toBeNull();
  });

  it('does not resurrect a deleted sidecar over a non-empty snapshot', async () => {
    await seedSession(SESSION_A);
    await seedReviewedNumbers(SESSION_A, 1, 1);
    // 99 is a dialog binding this run cannot re-resolve, while 1 still has
    // a URL: without the gone-session abort the write would recreate the
    // file the delete path just removed.
    const prPath = await seedPrSidecar(SESSION_A, [99]);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'b-1')],
    });
    sidecarReadHook.current = {
      path: prPath,
      run: async () => {
        await sessionService.removeSession(SESSION_A);
      },
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result.bound).toBe(0);
    expect(await readSessionPrs(prPath)).toBeNull();
  });

  it('does not write a stray sidecar when the session is archived mid-run', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    const activePrPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    sidecarReadHook.current = {
      path: activePrPath,
      run: async () => {
        await sessionService.archiveSessions([SESSION_A]);
      },
    };

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result.bound).toBe(0);
    expect(await readSessionPrs(activePrPath)).toBeNull();
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'archived'),
      ),
    ).toBeNull();
  });

  function attachGuard(target: WorkspaceRuntime): WorkspaceGenerationGuard {
    const guard = createWorkspaceGenerationGuard();
    (target as { generationGuard?: WorkspaceGenerationGuard }).generationGuard =
      guard;
    return guard;
  }

  it('never runs gh for a retired runtime generation', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    // The route snapshots the runtime from the registry; a trust/env
    // replacement that lands before the scan finishes closes its guard, and
    // `gh` must not run with the retired generation's env.
    attachGuard(runtime).close();

    await expect(backfillWorkspaceSessionPrs(runtime)).rejects.toBeInstanceOf(
      WorkspaceGenerationClosedError,
    );

    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
    expect(await readSessionPrs(prPath)).toBeNull();
  });

  it('commits nothing once the runtime generation closes mid-run', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const guard = attachGuard(runtime);
    // The replacement lands between the out-of-queue snapshot read and the
    // queued write — the window every await in this run opens.
    sidecarReadHook.current = {
      path: prPath,
      run: async () => {
        guard.close();
      },
    };

    await expect(backfillWorkspaceSessionPrs(runtime)).rejects.toBeInstanceOf(
      WorkspaceGenerationClosedError,
    );

    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);
    expect(await readSessionPrs(prPath)).toBeNull();
  });

  it('defers a session held by an archive lane to the next run', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const archiveCoordinator = new SessionArchiveCoordinator();
    let release!: () => void;
    // An archive/delete in flight holds the session's exclusive lane across
    // its renames; the commit must not race it, so this run reports the
    // session as unwritable and the next run re-plans it.
    const archiving = archiveCoordinator.runExclusiveMany(
      [SESSION_A],
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const held = await backfillWorkspaceSessionPrs(
      runtime,
      undefined,
      undefined,
      {
        archiveCoordinator,
      },
    );
    expect(held).toMatchObject({ bound: 0, written: 0, writeErrors: 1 });
    expect(await readSessionPrs(prPath)).toBeNull();

    release();
    await archiving;
    const retried = await backfillWorkspaceSessionPrs(
      runtime,
      undefined,
      undefined,
      {
        archiveCoordinator,
      },
    );
    expect(retried).toMatchObject({ bound: 1, written: 1 });
    expect(retried.writeErrors).toBeUndefined();
    expect((await readSessionPrs(prPath))?.map((e) => e.number)).toEqual([123]);
  });

  it('holds the session lane across the rewrite and the live-entry sync', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const archiveCoordinator = new SessionArchiveCoordinator();
    let archiveRefused = false;
    // Fires after the rewrite commits and before the live-entry sync: an
    // archive attempt in that gap must be refused, not interleaved, or the
    // sync would publish a list the archive move is about to split.
    sidecarCommitHook.current = async () => {
      await expect(
        archiveCoordinator.runExclusiveMany([SESSION_A], async () => {}),
      ).rejects.toBeInstanceOf(SessionArchivingError);
      archiveRefused = true;
    };

    const result = await backfillWorkspaceSessionPrs(
      runtime,
      undefined,
      undefined,
      {
        archiveCoordinator,
      },
    );

    expect(archiveRefused).toBe(true);
    expect(result).toMatchObject({ bound: 1, written: 1 });
    // The lane is released once the sync is done.
    await expect(
      archiveCoordinator.runExclusiveMany([SESSION_A], async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('stops the run once the daemon seals session maintenance', async () => {
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-123', 'worktree-pr-123');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const archiveCoordinator = new SessionArchiveCoordinator();
    await archiveCoordinator.sealMaintenanceAndWait();

    await expect(
      backfillWorkspaceSessionPrs(runtime, undefined, undefined, {
        archiveCoordinator,
      }),
    ).rejects.toBeInstanceOf(DaemonDrainingError);

    expect(await readSessionPrs(prPath)).toBeNull();
  });

  it('keeps backfilling other sessions when one sidecar write fails', async () => {
    await seedReviewedNumbers(SESSION_A, 1, 1);
    await seedReviewedNumbers(SESSION_B, 2, 2);
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

  it('ignores /review mentions outside user text records', async () => {
    // Assistant prose and tool results quote `/review <N>` without
    // requesting one; only the user's command records count.
    await seedSession(SESSION_G);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_G}.jsonl`),
      `${JSON.stringify({
        uuid: `${SESSION_G}-assistant`,
        parentUuid: `${SESSION_G}-user-1`,
        sessionId: SESSION_G,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ text: 'I will run /review 55 for you.' }],
        },
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(55, 'fix/55')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0 });
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

  it('does not bind PRs from transcript gh pr create traces (source removed)', async () => {
    // Transcript traces carry no gh-side attribution per historical command:
    // an echo-shaped command that merely mentions `gh pr create` passes the
    // execution gate and can print any same-repo URL, forging a binding.
    // Live creates bind through the shell post-hook (verified with gh
    // itself); backfill must not recover them from text.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    const sessionId = '00000000-0000-4000-8000-000000000008';
    await seedSession(sessionId);
    await appendShellCommand(
      sessionId,
      'gh pr create --title x --body y',
      'created\nhttps://github.com/o/r/pull/99\n',
    );
    await appendShellCommand(
      sessionId,
      'gh pr view 98 --json url -q .url',
      'https://github.com/o/r/pull/98\n',
    );
    await appendShellCommand(
      sessionId,
      'gh pr create --title x',
      'https://github.com/evil/other/pull/5\n',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 0 });
    // No candidates at all — gh must not be spawned for the run.
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(sessionId, 'active'),
      ),
    ).toBeNull();
  });

  it('never binds number 0 from a pr-0 user slug', async () => {
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    await seedSession(SESSION_F);
    await seedWorktreeSidecar(SESSION_F, 'pr-0', 'worktree-pr-0');
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0 });
  });

  it('rejects traversal sessionIds before building sidecar paths', async () => {
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
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 0, bound: 0 });
    const escapedSidecar = sessionService.getPrSessionPathForArchiveState(
      traversalId,
      'active',
    );
    expect(path.relative(chatsDir, escapedSidecar).startsWith('..')).toBe(true);
    await expect(fsp.access(escapedSidecar)).rejects.toThrow();
  });

  let appendCounter = 0;

  function transcriptRecord(
    sessionId: string,
    type: 'user' | 'assistant',
    parts: unknown[],
  ): string {
    appendCounter += 1;
    return JSON.stringify({
      uuid: `${sessionId}-extra-${appendCounter}`,
      parentUuid: `${sessionId}-user-1`,
      sessionId,
      timestamp: '2026-08-02T00:00:00.000Z',
      type,
      message: { role: type === 'user' ? 'user' : 'model', parts },
      cwd: workspaceCwd,
    });
  }

  async function appendUserText(
    sessionId: string,
    text: string,
  ): Promise<void> {
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${sessionId}.jsonl`),
      transcriptRecord(sessionId, 'user', [{ text }]) + '\n',
      'utf8',
    );
  }

  async function appendShellCommand(
    sessionId: string,
    command: string,
    output: string,
  ): Promise<void> {
    appendCounter += 1;
    const callId = `call-${appendCounter}`;
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${sessionId}.jsonl`),
      transcriptRecord(sessionId, 'assistant', [
        {
          functionCall: {
            id: callId,
            name: 'run_shell_command',
            args: { command },
          },
        },
      ]) +
        '\n' +
        transcriptRecord(sessionId, 'user', [
          {
            functionResponse: {
              id: callId,
              name: 'run_shell_command',
              response: { output },
            },
          },
        ]) +
        '\n',
      'utf8',
    );
  }

  it('fails closed on the gh page when the workspace repo key is unknown', async () => {
    // An upstream-only remote layout leaves no resolvable origin (key
    // undefined) while `gh pr list` still resolves a repo — the page map
    // must not bind that repo's PRs on a bare number collision.
    fetchRemoteWebUrlMock.mockResolvedValue(undefined);
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-42', 'worktree-pr-42');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(42, 'whatever'),
          url: 'https://github.com/upstream-owner/upstream-repo/pull/42',
        },
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, unresolved: 1 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
  });

  it('offers only free sidecar slots, never evicting persisted occupants', async () => {
    // Seeded at 8 with two reviewed candidates plus the convention number:
    // the run offers only the two FREE slots (strongest last), leaves every
    // persisted occupant untouched, and the weakest candidate waits for a
    // free slot instead of displacing one.
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await writeSessionPrs(
      prPath,
      Array.from({ length: 8 }, (_, i) => ({
        number: i + 1,
        url: `https://github.com/o/r/pull/${i + 1}`,
        createdAt: `2026-08-01T00:00:0${i}.000Z`,
        source: 'review' as const,
      })),
    );
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-101', 'worktree-pr-101');
    await appendUserText(SESSION_A, '/review 102');
    await appendUserText(SESSION_A, '/review 103');
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 2, alreadyBound: 0 });
    const final = await readSessionPrs(prPath);
    expect(final?.map((p) => p.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 103, 101,
    ]);
    expect(final?.[0]?.createdAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('binds /review typed through the TUI slash-command expansion', async () => {
    // The TUI records the EXPANDED skill body as the user record — the
    // typed command appended at its end is out of pattern reach; it
    // survives only in the slash_command system record's rawCommand.
    await seedSession(SESSION_A);
    await seedSession(SESSION_B);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    const expandedBody = {
      text: 'You are the /review skill. Steps: ...\n/review 55',
    };
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      transcriptRecord(SESSION_A, 'user', [expandedBody]) +
        '\n' +
        JSON.stringify({
          uuid: `${SESSION_A}-slash`,
          parentUuid: `${SESSION_A}-user-1`,
          sessionId: SESSION_A,
          timestamp: '2026-08-02T00:00:00.000Z',
          type: 'system',
          subtype: 'slash_command',
          systemPayload: { phase: 'invocation', rawCommand: '/review 55' },
          cwd: workspaceCwd,
        }) +
        '\n',
      'utf8',
    );
    // Control: the expanded user record ALONE (no slash record) must not
    // bind — the command sits at the part's end, out of pattern reach.
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_B}.jsonl`),
      transcriptRecord(SESSION_B, 'user', [expandedBody]) + '\n',
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(55, 'fix/55')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]).toMatchObject({ number: 55 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
      ),
    ).toBeNull();
  });

  it('keeps the convention binding across runs as weaker numbers accumulate', async () => {
    // Run 1 binds the convention number alone; later runs accumulate more
    // reviewed numbers than the sidecar cap holds. The convention number is
    // re-offered on every run and must survive each one — a plain
    // head-eviction drops it once enough weaker numbers land after it.
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-7', 'worktree-pr-7');
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });

    const run1 = await backfillWorkspaceSessionPrs(runtime);
    expect(run1.bound).toBe(1);
    expect((await readSessionPrs(prPath))?.map((p) => p.number)).toEqual([7]);

    for (const n of [101, 102, 103, 104, 105]) {
      await appendUserText(SESSION_A, `/review ${n}`);
    }
    const run2 = await backfillWorkspaceSessionPrs(runtime);
    expect(run2.bound).toBe(5);
    expect((await readSessionPrs(prPath))?.map((p) => p.number)).toEqual([
      7, 101, 102, 103, 104, 105,
    ]);

    for (const n of [106, 107, 108, 109, 110]) {
      await appendUserText(SESSION_A, `/review ${n}`);
    }
    const run3 = await backfillWorkspaceSessionPrs(runtime);
    expect(run3.bound).toBe(5);
    const afterRun3 = await readSessionPrs(prPath);
    // The cap planner re-trims the re-offered reviewed window: the weakest
    // reviewed occupant (101) makes room for the newcomers, while the
    // convention binding — planned last — survives every run.
    expect(afterRun3?.map((p) => p.number)).toEqual([
      7, 102, 103, 104, 105, 106, 107, 108, 109, 110,
    ]);
  });

  it('does not bind /review named mid-prose in user text', async () => {
    // Bundled skill bodies are recorded verbatim as user records; a
    // line-anchored pattern must not read a `/review` mention inside prose
    // as a command — neither `/review <N>` mid-line nor one inside a
    // literal path followed by a `(#N)` token.
    await seedSession(SESSION_A);
    await appendUserText(
      SESSION_A,
      'Save reports under .qwen/tmp/review-pr-<n> (#9205) and run /review 77 before merging',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(9205, 'docs'), pr(77, 'fix/77')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
  });

  it('binds the number the user named, not a later token on the line', async () => {
    await seedSession(SESSION_A);
    await appendUserText(SESSION_A, '/review 42 and fix #7');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'fix/42'), pr(7, 'fix/7')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.map((p) => p.number)).toEqual([42]);
  });

  it('does not bind digit-leading file paths passed to /review', async () => {
    // `/review <file-path>` is another documented invocation form of the
    // review skill; a digit-leading path must not forge a binding on its
    // digit run (`001_init.sql` is not PR 1).
    await seedSession(SESSION_A);
    await appendUserText(SESSION_A, '/review 001_init.sql');
    await appendUserText(SESSION_A, '/review 2026-08-25-notes.md');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(1, 'fix/1'), pr(2026, 'fix/2026')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
  });

  it('rejects foreign-repo and zero /review numbers', async () => {
    // The URL form names another repo: resolution must not bind the
    // workspace's own same-numbered PR instead. `/review 0` must not count
    // either — PR 0 does not exist, and counting it would report a phantom
    // bind that never persists.
    await seedSession(SESSION_A);
    await appendUserText(
      SESSION_A,
      '/review https://github.com/other-org/repoB/pull/42 --comment',
    );
    await seedSession(SESSION_B);
    await appendUserText(SESSION_B, '/review 0');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'fix/42')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0, unresolved: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
      ),
    ).toBeNull();
  });

  it('stays idempotent when candidates exceed the sidecar cap', async () => {
    // With 11+ candidates, re-runs must not keep offering the weak numbers
    // the cap evicted: re-appending them after the convention entry would
    // rotate the persisted list on every run until the convention binding
    // itself falls off the head.
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-7', 'worktree-pr-7');
    for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) {
      await appendUserText(SESSION_A, `/review ${n}`);
    }
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );

    const run1 = await backfillWorkspaceSessionPrs(runtime);
    const afterRun1 = await readSessionPrs(prPath);
    const run2 = await backfillWorkspaceSessionPrs(runtime);
    const afterRun2 = await readSessionPrs(prPath);

    expect(run1.bound).toBe(10);
    expect(run2).toMatchObject({ bound: 0, alreadyBound: 10 });
    expect(afterRun2?.map((p) => p.number)).toEqual(
      afterRun1?.map((p) => p.number),
    );
    expect(afterRun2?.map((p) => p.number)).toContain(7);
  });

  it('stays idempotent when non-re-offered occupants hold slots', async () => {
    // A live `create` binding occupies a slot backfill never re-offers.
    // Offering past the free count would evict the weakest persisted entry
    // and re-append it with a fresh createdAt on every re-run — a
    // permanent rotation. Sizing the offer to the free slots keeps the
    // list byte-stable from run 2 on.
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await writeSessionPrs(prPath, [
      {
        number: 100,
        url: 'https://github.com/o/r/pull/100',
        createdAt: '2026-08-01T00:00:00.000Z',
        source: 'create' as const,
      },
    ]);
    await seedSession(SESSION_A);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await appendUserText(SESSION_A, `/review ${n}`);
    }
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });

    const run1 = await backfillWorkspaceSessionPrs(runtime);
    expect(run1.bound).toBe(SESSION_PR_LIST_LIMIT - 1);
    const afterRun1 = await readSessionPrs(prPath);
    expect(afterRun1?.map((p) => p.number)).toEqual([
      100, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);

    const run2 = await backfillWorkspaceSessionPrs(runtime);
    expect(run2).toMatchObject({ bound: 0 });
    expect(await readSessionPrs(prPath)).toEqual(afterRun1);
  });

  it('does not resolve bare numbers through a divergent gh page', async () => {
    // gh's repo resolution is git-config driven and can diverge from the
    // workspace repo entirely; an untrusted page must not feed a bare
    // convention number — the number falls back to the workspace's own
    // remote URL instead of binding the stranger's same-numbered PR.
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-42', 'worktree-pr-42');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(42, 'whatever'),
          url: 'https://github.com/stranger/repoB/pull/42',
          state: 'merged' as const,
        },
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]?.url).toBe('https://github.com/o/r/pull/42');
    // The divergent page's state map is gated the same way.
    expect(prs?.[0]?.state).toBeUndefined();
  });

  it('binds the user-named URL of a /review url form without a trusted page', async () => {
    // The URL form names its PR explicitly and was repo-gated when
    // collected; it binds the named URL itself even when the gh page is
    // divergent and cannot feed bare numbers.
    await seedSession(SESSION_A);
    await appendUserText(
      SESSION_A,
      '/review https://github.com/parent/repo/pull/55 --comment',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(99, 'whatever'),
          url: 'https://github.com/parent/repo/pull/99',
        },
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    expect(prs?.[0]).toMatchObject({
      number: 55,
      url: 'https://github.com/parent/repo/pull/55',
      source: 'review',
    });
  });

  it('does not bind /review lines inside @-imported content parts', async () => {
    // @-imports persist the EXPANDED request: the typed prompt leads, the
    // inlined file body follows as later text parts. Only the typed prompt
    // may request a review — expanded content is arbitrary text, and a part
    // starting in a line-leading `/review N` example must not seed a
    // binding.
    await seedSession(SESSION_A);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      transcriptRecord(SESSION_A, 'user', [
        { text: '@docs/users/features/code-review.md summarize this' },
        {
          text: '/review 123\nprose\n/review 456',
        },
      ]) + '\n',
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'docs'), pr(456, 'docs')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
  });

  it('does not bind a bare number on the line after /review', async () => {
    await seedSession(SESSION_A);
    await appendUserText(SESSION_A, '/review\n5 things broke today');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(5, 'fix/5')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0 });
  });

  it('does not bind /review lookalike commands (token isolation)', async () => {
    // `/review-skill` is another command whose name merely STARTS with
    // `review`; a `\b` separator after `review` would match it and forge a
    // binding from its pull-URL argument. The pattern must isolate the
    // command token — from both the rawCommand and the user-text sources.
    await seedSession(SESSION_A);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      `${JSON.stringify({
        uuid: `${SESSION_A}-slash`,
        parentUuid: `${SESSION_A}-user-1`,
        sessionId: SESSION_A,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: {
          phase: 'invocation',
          rawCommand: '/review-skill https://github.com/o/r/pull/55',
        },
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
    await seedSession(SESSION_B);
    await appendUserText(
      SESSION_B,
      '/review-skill https://github.com/o/r/pull/56',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(55, 'fix/55'), pr(56, 'fix/56')],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 2, bound: 0 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
      ),
    ).toBeNull();
  });

  it('rejects over-long /review numbers instead of truncating them', async () => {
    // PR numbers above nine digits do not exist; a bare `\d{1,9}` group
    // would silently bind the nine-digit prefix.
    await seedSession(SESSION_A);
    await appendUserText(SESSION_A, '/review 12345678901');
    await seedSession(SESSION_B);
    await appendUserText(
      SESSION_B,
      '/review https://github.com/o/r/pull/12345678901',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 2, bound: 0, unresolved: 0 });
  });

  it('fails closed when gh resolution diverged from the workspace repo', async () => {
    // A prior `gh repo set-default someone/their-fork` can diverge gh's
    // resolution to an unrelated repo that is a fork of the page's repo;
    // `gh pr list` then lists the page repo's PRs. Confirming only the
    // parent relationship would mark the unrelated page trusted and bind
    // a stranger's same-numbered PR — gh's OWN resolution must name the
    // workspace repo before the page may feed a binding.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/me/workspace');
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-42', 'worktree-pr-42');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(42, 'fix/42'),
          url: 'https://github.com/parent/repo/pull/42',
        },
      ],
    });
    fetchAttributionRepoKeysMock.mockResolvedValue({
      resolved: 'github.com/someone/their-fork',
      parent: 'github.com/parent/repo',
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 1, unresolved: 0 });
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    // Untrusted page: the convention number falls back to the workspace
    // remote instead of taking the page repo's PR-42 URL.
    expect(prs?.[0]).toMatchObject({
      number: 42,
      url: 'https://github.com/me/workspace/pull/42',
      source: 'worktree',
    });
  });

  it('never lends a gate-rejected form URL to a same-number binding', async () => {
    // `/review 42` (legitimate bare) plus a foreign-repo URL form with the
    // SAME number: the foreign form fails the repo gate, so it must not
    // supply the URL for the number the bare form bound (the map kept the
    // LAST entry per number, letting the foreign URL win).
    await seedSession(SESSION_A);
    await appendUserText(SESSION_A, '/review 42');
    await appendUserText(
      SESSION_A,
      '/review https://github.com/other-org/repoB/pull/42 --comment',
    );
    // Variant: two same-number forms, own-repo first, foreign second.
    await seedSession(SESSION_B);
    await appendUserText(SESSION_B, '/review https://github.com/o/r/pull/42');
    await appendUserText(
      SESSION_B,
      '/review https://github.com/other-org/repoB/pull/42',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result.bound).toBe(2);
    for (const sessionId of [SESSION_A, SESSION_B]) {
      const prs = await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(sessionId, 'active'),
      );
      expect(prs?.[0]).toMatchObject({
        number: 42,
        url: 'https://github.com/o/r/pull/42',
      });
    }
  });

  it('binds the parent-repo URL form of /review in the fork layout', async () => {
    // Origin is the fork; gh resolves the PARENT repo for queries, and PR
    // URLs in this layout always point at the parent. The URL form must
    // gate against the page's repo key too — the identical PR named by
    // bare number binds through the page, so dropping the URL form leaves
    // it systematically dead in fork layouts.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/me/fork');
    fetchAttributionRepoKeysMock.mockResolvedValue({
      resolved: 'github.com/me/fork',
      parent: 'github.com/parent/repo',
    });
    await seedSession(SESSION_A);
    await appendUserText(
      SESSION_A,
      '/review https://github.com/parent/repo/pull/42',
    );
    await seedSession(SESSION_B);
    await appendUserText(SESSION_B, '/review 42');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        { ...pr(42, 'fix/42'), url: 'https://github.com/parent/repo/pull/42' },
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 2, bound: 2 });
    expect(
      (
        await readSessionPrs(
          sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
        )
      )?.[0],
    ).toMatchObject({
      number: 42,
      url: 'https://github.com/parent/repo/pull/42',
    });
    expect(
      (
        await readSessionPrs(
          sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
        )
      )?.[0],
    ).toMatchObject({ number: 42 });
  });

  it('does not pair a fork-url binding with the parent page same-number state', async () => {
    // Fork layout: the gh page lists the PARENT repo's PRs, and a
    // `/review <fork-url>` form binds the FORK url. PR numbers are
    // per-repo — the page's same-numbered entry is a DIFFERENT PR, so its
    // (possibly terminal) state must never be stamped onto this binding;
    // the refresh sweep keys stamps by repo and never re-queries a
    // terminal state, so a wrong 'merged' would persist.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/me/fork');
    fetchAttributionRepoKeysMock.mockResolvedValue({
      resolved: 'github.com/me/fork',
      parent: 'github.com/parent/repo',
    });
    await seedSession(SESSION_A);
    await appendUserText(
      SESSION_A,
      '/review https://github.com/me/fork/pull/7',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(7, 'fix/7'),
          url: 'https://github.com/parent/repo/pull/7',
          state: 'merged' as const,
        },
      ],
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    expect(
      (
        await readSessionPrs(
          sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
        )
      )?.[0],
    ).toEqual({
      number: 7,
      url: 'https://github.com/me/fork/pull/7',
      createdAt: expect.any(String),
      source: 'review',
    });
  });

  it('keeps a bound number untouched when only the remote fallback can feed the url', async () => {
    // Fork layout, run 1 (gh healthy) binds the parent URL. Run 2 while gh
    // is down can only synthesize the FORK remote URL (a guaranteed 404);
    // replacing the persisted parent URL with it on every gh-availability
    // flip oscillates the entry's createdAt and drops its state. A
    // remote-fallback URL for an already-bound number must re-offer the
    // number WITHOUT a url so the mutation counts it already bound.
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/me/fork');
    fetchAttributionRepoKeysMock.mockResolvedValue({
      resolved: 'github.com/me/fork',
      parent: 'github.com/parent/repo',
    });
    await seedSession(SESSION_A);
    await appendUserText(SESSION_A, '/review 42');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        {
          ...pr(42, 'fix/42'),
          url: 'https://github.com/parent/repo/pull/42',
        },
      ],
    });

    const first = await backfillWorkspaceSessionPrs(runtime);
    expect(first).toMatchObject({ bound: 1 });
    const sidecarPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    const afterFirst = await readSessionPrs(sidecarPath);
    expect(afterFirst?.[0]?.url).toBe('https://github.com/parent/repo/pull/42');

    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });
    const second = await backfillWorkspaceSessionPrs(runtime);

    expect(second).toMatchObject({ bound: 0, alreadyBound: 1 });
    const afterSecond = await readSessionPrs(sidecarPath);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('writes the binding to the archive state the session holds at write time', async () => {
    // An archive transition landing during the scan+gh window must not
    // strand the new binding in the enumerated (stale) state's chats dir:
    // the write re-resolves the session's CURRENT location, the way the
    // sibling shell binder does.
    await seedSession(SESSION_A);
    await appendUserText(SESSION_A, '/review 42');
    fetchGitHubPullRequestsMock.mockImplementation(async () => {
      await archiveSession(SESSION_A);
      return { kind: 'ok', pullRequests: [pr(42, 'fix/42')] };
    });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ scanned: 1, bound: 1 });
    expect(
      await readSessionPrs(
        sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      ),
    ).toBeNull();
    expect(
      (
        await readSessionPrs(
          sessionService.getPrSessionPathForArchiveState(SESSION_A, 'archived'),
        )
      )?.[0],
    ).toMatchObject({ number: 42, url: 'https://github.com/o/r/pull/42' });
  });

  it('scans sessions whose mtime ties a pagination boundary', async () => {
    // 1007 sessions, four of them sharing the mtime of the 1000th file:
    // listSessions' strict-`<` cursor boundary drops those boundary twins
    // on every paging run, so a pager can never reach them. Backfill must.
    const total = 1007;
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    const baseMtime = Date.UTC(2026, 7, 1);
    for (let i = 0; i < total; i++) {
      const sessionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
      await fsp.writeFile(
        filePath,
        `${JSON.stringify({
          uuid: `${sessionId}-user-1`,
          parentUuid: null,
          sessionId,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'hello' }] },
          cwd: workspaceCwd,
        })}\n`,
        'utf8',
      );
      const mtimeMs =
        i >= 999 && i <= 1002 ? baseMtime - 999_000 : baseMtime - i * 1000;
      const mtime = new Date(mtimeMs);
      await fsp.utimes(filePath, mtime, mtime);
    }
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result.scanned).toBe(total);
  }, 60_000);
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
      bridge: { markSessionCatalogChanged: vi.fn() },
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
      bridge: { markSessionCatalogChanged: vi.fn() },
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

  // Seeds a trusted workspace holding one `pr-123` worktree session that
  // backfill can bind through the mocked gh page.
  async function seedTrustedBackfillWorkspace(): Promise<{
    runtime: WorkspaceRuntime;
    markSessionCatalogChanged: ReturnType<typeof vi.fn>;
    cleanup: () => Promise<void>;
  }> {
    const cwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-work-'),
    );
    execSync('git init', { cwd, stdio: 'pipe' });
    execSync(
      'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main',
      { cwd, stdio: 'pipe' },
    );
    const runtimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-runtime-'),
    );
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    const markSessionCatalogChanged = vi.fn();
    const rt = {
      workspaceId: 'primary',
      workspaceCwd: cwd,
      sessionRuntimeBaseDir: runtimeDir,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: { markSessionCatalogChanged },
    } as unknown as WorkspaceRuntime;
    const service = createWorkspaceRuntimeSessionService(rt);
    const chatsDir = path.join(new Storage(cwd).getProjectDir(), 'chats');
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
        cwd,
      })}\n`,
      'utf8',
    );
    const worktreePath = service.getWorktreeSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
    await fsp.writeFile(
      worktreePath,
      JSON.stringify({
        slug: 'pr-123',
        worktreePath: `${cwd}/.qwen/worktrees/pr-123`,
        worktreeBranch: 'worktree-pr-123',
        originalCwd: cwd,
        originalBranch: 'main',
        originalHeadCommit: 'abc123',
      }),
      'utf8',
    );
    return {
      runtime: rt,
      markSessionCatalogChanged,
      cleanup: async () => {
        delete process.env['QWEN_RUNTIME_DIR'];
        await fsp.rm(cwd, { recursive: true, force: true });
        await fsp.rm(runtimeDir, { recursive: true, force: true });
      },
    };
  }

  it('isolates a failing workspace and still backfills the rest', async () => {
    const seeded = await seedTrustedBackfillWorkspace();
    // A regular file where a workspace cwd belongs makes the chats-dir
    // readdir throw ENOTDIR (a non-ENOENT error the session enumeration
    // rethrows); the route must isolate that workspace's failure instead
    // of failing the whole request.
    const brokenParent = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-broken-'),
    );
    const brokenCwd = path.join(brokenParent, 'workspace-file');
    await fsp.writeFile(brokenCwd, 'not a directory', 'utf8');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([
        runtime('broken', brokenCwd, true),
        seeded.runtime,
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    try {
      const response = await request(app).post('/sessions/backfill-prs');

      expect(response.status).toBe(200);
      expect(response.body.workspaces).toHaveLength(2);
      const broken = response.body.workspaces.find(
        (w: { workspaceCwd: string }) => w.workspaceCwd === brokenCwd,
      );
      expect(broken.error).toContain('ENOTDIR');
      const good = response.body.workspaces.find(
        (w: { workspaceCwd: string }) =>
          w.workspaceCwd === seeded.runtime.workspaceCwd,
      );
      expect(good.error).toBeUndefined();
      expect(good).toMatchObject({ scanned: 1, bound: 1 });
      expect(response.body).toMatchObject({ v: 1, scanned: 1, bound: 1 });
    } finally {
      await seeded.cleanup();
      await fsp.rm(brokenParent, { recursive: true, force: true });
    }
  });

  it('invalidates the session-list cache and marks the catalog when bindings are added', async () => {
    const seeded = await seedTrustedBackfillWorkspace();
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const invalidateSpy = vi.spyOn(
      sessionListModule,
      'invalidateWorkspaceSessionListCache',
    );
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([seeded.runtime]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    try {
      const response = await request(app).post('/sessions/backfill-prs');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ bound: 1 });
      expect(invalidateSpy).toHaveBeenCalledWith({
        runtimeBaseDir: seeded.runtime.sessionRuntimeBaseDir,
        workspaceCwd: seeded.runtime.workspaceCwd,
        archiveStates: ['active', 'archived'],
      });
      expect(seeded.markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    } finally {
      invalidateSpy.mockRestore();
      await seeded.cleanup();
    }
  });

  it('leaves the session-list cache and catalog untouched when nothing binds', async () => {
    const seeded = await seedTrustedBackfillWorkspace();
    fetchRemoteWebUrlMock.mockResolvedValue(undefined);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [],
    });
    const invalidateSpy = vi.spyOn(
      sessionListModule,
      'invalidateWorkspaceSessionListCache',
    );
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([seeded.runtime]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    try {
      const response = await request(app).post('/sessions/backfill-prs');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ bound: 0 });
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(seeded.markSessionCatalogChanged).not.toHaveBeenCalled();
    } finally {
      invalidateSpy.mockRestore();
      await seeded.cleanup();
    }
  });

  // Seeds a trusted workspace whose single session recorded ten transcript
  // branches while its sidecar already holds the first nine — one free
  // slot at the cap, the shape a concurrent dialog binding fills.
  async function seedTrustedCapWorkspace(): Promise<{
    runtime: WorkspaceRuntime;
    markSessionCatalogChanged: ReturnType<typeof vi.fn>;
    prPath: string;
    cleanup: () => Promise<void>;
  }> {
    const cwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-work-'),
    );
    execSync('git init', { cwd, stdio: 'pipe' });
    execSync(
      'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main',
      { cwd, stdio: 'pipe' },
    );
    const runtimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-backfill-route-runtime-'),
    );
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    const markSessionCatalogChanged = vi.fn();
    const rt = {
      workspaceId: 'primary',
      workspaceCwd: cwd,
      sessionRuntimeBaseDir: runtimeDir,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: { markSessionCatalogChanged },
    } as unknown as WorkspaceRuntime;
    const service = createWorkspaceRuntimeSessionService(rt);
    const chatsDir = path.join(new Storage(cwd).getProjectDir(), 'chats');
    await fsp.mkdir(chatsDir, { recursive: true });
    let transcript = '';
    for (let i = 1; i <= 10; i++) {
      transcript += `${JSON.stringify({
        uuid: `${SESSION_A}-user-${i}`,
        parentUuid: i === 1 ? null : `${SESSION_A}-user-${i - 1}`,
        sessionId: SESSION_A,
        timestamp: '2026-08-02T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: `/review ${i}` }] },
        cwd,
      })}\n`;
    }
    await fsp.writeFile(
      path.join(chatsDir, `${SESSION_A}.jsonl`),
      transcript,
      'utf8',
    );
    const prPath = service.getPrSessionPathForArchiveState(SESSION_A, 'active');
    await fsp.mkdir(path.dirname(prPath), { recursive: true });
    await fsp.writeFile(
      prPath,
      JSON.stringify({
        prs: Array.from({ length: 9 }, (_, i) => ({
          number: i + 1,
          url: `https://github.com/o/r/pull/${i + 1}`,
          createdAt: '2026-08-01T00:00:00.000Z',
        })),
      }),
      'utf8',
    );
    return {
      runtime: rt,
      markSessionCatalogChanged,
      prPath,
      cleanup: async () => {
        delete process.env['QWEN_RUNTIME_DIR'];
        await fsp.rm(cwd, { recursive: true, force: true });
        await fsp.rm(runtimeDir, { recursive: true, force: true });
      },
    };
  }

  it('keeps every binding when a concurrent bind fills the last slot at the cap', async () => {
    const seeded = await seedTrustedCapWorkspace();
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: Array.from({ length: 10 }, (_, i) =>
        pr(i + 1, `b-${i + 1}`),
      ),
    });
    // The dialog binds #10 between the snapshot read and the queued write:
    // the fresh entry already holds its slot, so the plan must not bill it
    // twice and trim a snapshot binding — all ten numbers fit the ten
    // slots, nothing is written, and the cache stays untouched.
    sidecarReadHook.current = {
      path: seeded.prPath,
      run: () =>
        upsertSessionPr(seeded.prPath, {
          number: 10,
          url: 'https://github.com/o/r/pull/10',
        }).then(() => undefined),
    };
    const invalidateSpy = vi.spyOn(
      sessionListModule,
      'invalidateWorkspaceSessionListCache',
    );
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([seeded.runtime]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    try {
      const response = await request(app).post('/sessions/backfill-prs');

      expect(response.status).toBe(200);
      expect(response.body.workspaces[0]).toMatchObject({
        scanned: 1,
        bound: 0,
        alreadyBound: 9,
        overLimit: 0,
      });
      const after = await readSessionPrs(seeded.prPath);
      expect(after?.map((entry) => entry.number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(seeded.markSessionCatalogChanged).not.toHaveBeenCalled();
    } finally {
      invalidateSpy.mockRestore();
      await seeded.cleanup();
    }
  });

  it('reports a workspace whose generation retired mid-run without notifying its bridge', async () => {
    const seeded = await seedTrustedBackfillWorkspace();
    const guard = createWorkspaceGenerationGuard();
    (
      seeded.runtime as { generationGuard?: WorkspaceGenerationGuard }
    ).generationGuard = guard;
    const prPath = createWorkspaceRuntimeSessionService(
      seeded.runtime,
    ).getPrSessionPathForArchiveState(SESSION_A, 'active');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    // The replacement lands while the route awaits the queued write; the
    // retired generation must neither commit nor notify its obsolete bridge.
    sidecarReadHook.current = {
      path: prPath,
      run: async () => {
        guard.close();
      },
    };
    const invalidateSpy = vi.spyOn(
      sessionListModule,
      'invalidateWorkspaceSessionListCache',
    );
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([seeded.runtime]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    try {
      const response = await request(app).post('/sessions/backfill-prs');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ bound: 0 });
      expect(response.body.workspaces[0]).toMatchObject({
        workspaceCwd: seeded.runtime.workspaceCwd,
        bound: 0,
        error: new WorkspaceGenerationClosedError().message,
      });
      expect(await readSessionPrs(prPath)).toBeNull();
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(seeded.markSessionCatalogChanged).not.toHaveBeenCalled();
    } finally {
      invalidateSpy.mockRestore();
      await seeded.cleanup();
    }
  });

  it('serialises each commit with the archive lane it is handed', async () => {
    const seeded = await seedTrustedBackfillWorkspace();
    const prPath = createWorkspaceRuntimeSessionService(
      seeded.runtime,
    ).getPrSessionPathForArchiveState(SESSION_A, 'active');
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(123, 'worktree-pr-123')],
    });
    const archiveCoordinator = new SessionArchiveCoordinator();
    const runSharedMany = vi.spyOn(archiveCoordinator, 'runSharedMany');
    let release!: () => void;
    const archiving = archiveCoordinator.runExclusiveMany(
      [SESSION_A],
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const app = express();
    registerSessionPrBackfillRoutes(app, {
      workspaceRegistry: registry([seeded.runtime]),
      sendBridgeError,
      mutate: passthroughMutate,
      archiveCoordinator,
    });

    try {
      const held = await request(app).post('/sessions/backfill-prs');
      expect(held.status).toBe(200);
      expect(held.body.workspaces[0]).toMatchObject({
        bound: 0,
        written: 0,
        writeErrors: 1,
      });
      expect(runSharedMany).toHaveBeenCalledWith(
        [SESSION_A],
        expect.any(Function),
      );
      expect(await readSessionPrs(prPath)).toBeNull();
      expect(seeded.markSessionCatalogChanged).not.toHaveBeenCalled();

      release();
      await archiving;
      const retried = await request(app).post('/sessions/backfill-prs');
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ bound: 1 });
      expect(seeded.markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    } finally {
      await seeded.cleanup();
    }
  });
});
