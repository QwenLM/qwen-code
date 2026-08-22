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
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  refreshWorkspaceSessionPrStates,
  resolveSessionPrRefreshIntervalMs,
} from './session-pr-refresh.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  fetchGitHubPullRequests: vi.fn(),
}));

const fetchGitHubPullRequestsMock = vi.mocked(fetchGitHubPullRequests);

const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';

// The sweep only updates bindings whose URL belongs to the workspace repo;
// tests seed github.com/o/r URLs, so resolve the workspace remote to it.
const resolveRemote = async (): Promise<string | undefined> =>
  'https://github.com/o/r';

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

    const result = await refreshWorkspaceSessionPrStates(
      runtime,
      undefined,
      resolveRemote,
    );

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

    const result = await refreshWorkspaceSessionPrStates(
      runtime,
      undefined,
      resolveRemote,
    );

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
      kind: 'cli_unavailable',
    });

    const result = await refreshWorkspaceSessionPrStates(
      runtime,
      undefined,
      resolveRemote,
    );

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  it('does not write back open for bindings missing from the gh page', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 999,
      url: 'https://github.com/o/r/pull/999',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(
      runtime,
      undefined,
      resolveRemote,
    );

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  it('updates nothing when the workspace remote cannot be resolved', async () => {
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

    const result = await refreshWorkspaceSessionPrStates(
      runtime,
      undefined,
      async () => undefined,
    );

    // Without a repo identity there is no way to verify a binding belongs
    // to the queried repository, so the round must not stamp any state.
    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
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

    const result = await refreshWorkspaceSessionPrStates(
      runtime,
      undefined,
      resolveRemote,
    );

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

    const result = await refreshWorkspaceSessionPrStates(
      runtime,
      undefined,
      resolveRemote,
    );

    expect(result).toEqual({ scanned: 1, updated: 1 });
  });
});
