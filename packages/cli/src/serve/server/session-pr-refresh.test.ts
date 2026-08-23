/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Storage,
  fetchGitHubPullRequests,
  readSessionPrs,
  upsertSessionPr,
  type SessionService,
} from '@qwen-code/qwen-code-core';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  refreshWorkspaceSessionPrStates,
  resolveSessionPrRefreshIntervalMs,
  startSessionPrRefreshTimer,
} from './session-pr-refresh.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  fetchGitHubPullRequests: vi.fn(),
}));

const fetchGitHubPullRequestsMock = vi.mocked(fetchGitHubPullRequests);

const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';

function pr(number: number, state: string) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    author: 'octocat',
    headRefName: `fix/${number}`,
    state: state as 'open' | 'merged' | 'closed',
    reviewDecision: null,
    checks: 'passing' as const,
    updatedAt: 1_800_000_000,
  };
}

describe('resolveSessionPrRefreshIntervalMs', () => {
  it('defaults to five minutes', () => {
    expect(resolveSessionPrRefreshIntervalMs({})).toBe(300_000);
  });

  it('disables on 0 and honors a custom interval', () => {
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '0',
      }),
    ).toBeUndefined();
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '2',
      }),
    ).toBe(120_000);
  });

  it('falls back to the default on garbage', () => {
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: 'later',
      }),
    ).toBe(300_000);
  });
});

describe('refreshWorkspaceSessionPrStates', () => {
  let runtimeDir: string;
  let workspaceCwd: string;
  let runtime: WorkspaceRuntime;
  let sessionService: SessionService;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-refresh-runtime-'),
    );
    workspaceCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-refresh-work-'),
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

  async function seedSession(sessionId: string): Promise<void> {
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
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
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
  }

  it('rewrites open bindings to merged, preserving createdAt', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    const seeded = await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    const persisted = await readSessionPrs(prPath);
    expect(persisted?.[0]?.state).toBe('merged');
    expect(persisted?.[0]?.createdAt).toBe(seeded[0]?.createdAt);
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledWith(
      workspaceCwd,
      undefined,
      { state: 'all', limit: 500, slim: true },
    );
  });

  it('skips gh entirely when every binding is merged', async () => {
    await seedSession(SESSION_A);
    await upsertSessionPr(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      { number: 42, url: 'https://github.com/o/r/pull/42', state: 'merged' },
    );
    await seedSession(SESSION_B);
    await upsertSessionPr(
      sessionService.getPrSessionPathForArchiveState(SESSION_B, 'active'),
      { number: 43, url: 'https://github.com/o/r/pull/43', state: 'merged' },
    );

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 2, updated: 0 });
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
  });

  it('tracks a reopened closed PR back to open', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'closed',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'open')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  it('swallows gh failures and updates nothing', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'failed',
      message: 'boom',
      gitRoot: workspaceCwd,
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  it('does not write back open for bindings missing from the gh page', async () => {
    // Seeded 'closed': resurrecting page-absent bindings to 'open' would
    // rewrite this entry (an 'open' seed makes that regression vacuous).
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 999,
      url: 'https://github.com/o/r/pull/999',
      state: 'closed',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('closed');
  });

  it('updates nothing when the gh page is unavailable', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    // Stamping authority is the page gh lists; without any page nothing
    // stamps, whatever the workspace's git remote looks like.
    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  it('refreshes a parent-repo binding in the fork layout', async () => {
    // Origin is the fork, but gh resolves the PARENT repo for queries and
    // the writers bind parent URLs — the sweep must accept the repository
    // gh actually queried instead of freezing the binding at 'open'.
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 7,
      url: 'https://github.com/parent/repo/pull/7',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        { ...pr(7, 'merged'), url: 'https://github.com/parent/repo/pull/7' },
      ],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('merged');
  });

  it('never reads or stamps a sidecar through a traversal sessionId', async () => {
    // The sessionId comes verbatim from the transcript's first record; a
    // planted record may carry a path-escape id. The sweep must skip it
    // instead of reading and stamping the escaped sidecar path.
    const fileName = '00000000-0000-4000-8000-00000000000f';
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
    // A valid sidecar at the escaped path is what the unguarded sweep
    // would read and stamp.
    const escapedSidecar = sessionService.getPrSessionPathForArchiveState(
      traversalId,
      'active',
    );
    await fsp.mkdir(path.dirname(escapedSidecar), { recursive: true });
    await fsp.writeFile(
      escapedSidecar,
      JSON.stringify({
        prs: [
          {
            number: 42,
            url: 'https://github.com/o/r/pull/42',
            createdAt: '2026-08-01T00:00:00.000Z',
            state: 'open',
          },
        ],
      }),
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 0, updated: 0 });
    const raw = JSON.parse(await fsp.readFile(escapedSidecar, 'utf8'));
    expect(raw.prs[0].state).toBe('open');
  });

  it('never stamps a same-number PR of another repository', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    // A binding whose URL points at an upstream repository; the sweep only
    // queries the workspace repo, so a number collision there must not
    // rewrite this entry.
    await upsertSessionPr(prPath, {
      number: 500,
      url: 'https://github.com/upstream/repo/pull/500',
      state: 'open',
    });
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(500, 'merged'), pr(42, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    const persisted = await readSessionPrs(prPath);
    expect(persisted?.find((p) => p.number === 500)?.state).toBe('open');
    expect(persisted?.find((p) => p.number === 42)?.state).toBe('merged');
  });

  it('counts only bindings whose state was actually rewritten', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 10,
      url: 'https://github.com/o/r/pull/10',
      state: 'open',
    });
    await upsertSessionPr(prPath, {
      number: 11,
      url: 'https://github.com/o/r/pull/11',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      // gh confirms both numbers, but only one changed state.
      pullRequests: [pr(10, 'merged'), pr(11, 'open')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
  });

  it('never stamps a fork-URL binding from the parent page it passes through', async () => {
    // Fork layout, reverse corner: the binding's URL is the FORK's web URL
    // while the page is the PARENT's. PR numbers collide between fork and
    // parent routinely, so the parent page's same-number state must not
    // reach the fork binding — its repo is not the one gh listed.
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 12,
      url: 'https://github.com/me/fork/pull/12',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [
        { ...pr(12, 'merged'), url: 'https://github.com/parent/repo/pull/12' },
      ],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });
});

describe('startSessionPrRefreshTimer', () => {
  let runtimeDir: string;
  let workspaceCwd: string;
  let runtime: WorkspaceRuntime;
  let sessionService: SessionService;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-refresh-timer-runtime-'),
    );
    workspaceCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-refresh-timer-work-'),
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
    vi.useRealTimers();
    await fsp.rm(runtimeDir, { recursive: true, force: true });
    await fsp.rm(workspaceCwd, { recursive: true, force: true });
  });

  it('marks the session catalog when a sweep rewrites states', async () => {
    // State transitions rewrite sidecars the daemon never sees; the tick
    // must bump the catalog revision or live-state clients keep rendering
    // the stale badge until unrelated churn.
    vi.useFakeTimers();
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
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
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
    await upsertSessionPr(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
      { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open' },
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    const markSessionCatalogChanged = vi.fn();
    const timer = startSessionPrRefreshTimer({
      workspaceRegistry: {
        listAll: () => [{ ...runtime, bridge: { markSessionCatalogChanged } }],
      } as unknown as WorkspaceRegistry,
      env: { QWEN_SESSION_PR_REFRESH_MINUTES: '5' },
    });
    expect(timer).toBeDefined();

    // Past the first-run delay: the sweep rewrites open -> merged and bumps
    // the catalog. waitFor keeps advancing the fake clock and yielding until
    // the tick's async sweep settles.
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() =>
      expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1),
    );
    expect(
      (
        await readSessionPrs(
          sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
        )
      )?.[0]?.state,
    ).toBe('merged');
    timer?.dispose();
  });
});
