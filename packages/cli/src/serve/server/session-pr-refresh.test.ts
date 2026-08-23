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

  it('treats a blank value as unset, not as a disable', () => {
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '',
      }),
    ).toBe(300_000);
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '   ',
      }),
    ).toBe(300_000);
  });

  it('falls back to the default below one minute', () => {
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '0.0001',
      }),
    ).toBe(300_000);
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '1',
      }),
    ).toBe(60_000);
  });

  it('falls back to the default when the converted ms overflows the 32-bit timer max', () => {
    // setInterval clamps out-of-range delays to 1 ms; without the fallback a
    // "monthly" interval would become a continuous sweep hot loop.
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '43200',
      }),
    ).toBe(300_000);
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '1e308',
      }),
    ).toBe(300_000);
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '35792',
      }),
    ).toBe(300_000);
    expect(
      resolveSessionPrRefreshIntervalMs({
        QWEN_SESSION_PR_REFRESH_MINUTES: '35791',
      }),
    ).toBe(2_147_460_000);
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
      kind: 'cli_unavailable',
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  async function seedArchivedSession(sessionId: string): Promise<void> {
    await seedSession(sessionId);
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

  it('refreshes a sidecar written before the session flushed a transcript', async () => {
    // No transcript: the bind route persists the sidecar before the first
    // flush, and the sweep must still discover it.
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
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('merged');
  });

  it('updates every pending session with one gh call per workspace', async () => {
    await seedSession(SESSION_A);
    const prPathA = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPathA, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    await seedSession(SESSION_B);
    const prPathB = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
    );
    await upsertSessionPr(prPathB, {
      number: 43,
      url: 'https://github.com/o/r/pull/43',
      state: 'closed',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged'), pr(43, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 2, updated: 2 });
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);
    expect((await readSessionPrs(prPathA))?.[0]?.state).toBe('merged');
    expect((await readSessionPrs(prPathB))?.[0]?.state).toBe('merged');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps sweeping archived sessions when a sidecar write fails',
    async () => {
      await seedSession(SESSION_A);
      const prPathA = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await upsertSessionPr(prPathA, {
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        state: 'open',
      });
      await seedArchivedSession(SESSION_B);
      const prPathB = sessionService.getPrSessionPathForArchiveState(
        SESSION_B,
        'archived',
      );
      await upsertSessionPr(prPathB, {
        number: 43,
        url: 'https://github.com/o/r/pull/43',
        state: 'open',
      });
      fetchGitHubPullRequestsMock.mockResolvedValue({
        kind: 'ok',
        pullRequests: [pr(42, 'merged'), pr(43, 'merged')],
      });

      const chatsDir = path.join(
        new Storage(workspaceCwd).getProjectDir(),
        'chats',
      );
      await fsp.chmod(chatsDir, 0o555);
      try {
        const result = await refreshWorkspaceSessionPrStates(runtime);

        expect(result).toEqual({ scanned: 2, updated: 1 });
        expect((await readSessionPrs(prPathA))?.[0]?.state).toBe('open');
        expect((await readSessionPrs(prPathB))?.[0]?.state).toBe('merged');
      } finally {
        await fsp.chmod(chatsDir, 0o755);
      }
    },
  );

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

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  it('keeps a closed binding closed when its number is missing from the gh page', async () => {
    // The sibling case seeds 'open', so a regression defaulting gh-absent
    // numbers to 'open' would rewrite nothing and survive it; a 'closed'
    // seed turns red under the same mutation.
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

  it('does not rewrite sidecars owned by a colliding project', async () => {
    // sanitizeCwd maps every non-alphanumeric to '-', so `my-app` and
    // `my.app` share one chats dir; the sweep must stay on its own side of
    // the collision.
    const parent = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-collide-'),
    );
    try {
      const cwdA = path.join(parent, 'my-app');
      const cwdB = path.join(parent, 'my.app');
      await fsp.mkdir(cwdA, { recursive: true });
      await fsp.mkdir(cwdB, { recursive: true });
      const runtimeA = {
        workspaceId: 'collide-a',
        workspaceCwd: cwdA,
        sessionRuntimeBaseDir: runtimeDir,
        primary: true,
        trusted: true,
        env: { mode: 'parent-process', overlayKeys: [] },
      } as unknown as WorkspaceRuntime;
      const runtimeB = {
        ...runtimeA,
        workspaceId: 'collide-b',
        workspaceCwd: cwdB,
      } as unknown as WorkspaceRuntime;
      const serviceA = createWorkspaceRuntimeSessionService(runtimeA);
      const chatsDir = path.join(new Storage(cwdA).getProjectDir(), 'chats');
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
          cwd: cwdA,
        })}\n`,
        'utf8',
      );
      const prPathA = serviceA.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await upsertSessionPr(prPathA, {
        number: 42,
        url: 'https://github.com/o/r/pull/42',
        state: 'open',
      });
      fetchGitHubPullRequestsMock.mockResolvedValue({
        kind: 'ok',
        pullRequests: [pr(42, 'merged')],
      });

      const result = await refreshWorkspaceSessionPrStates(runtimeB);

      expect(result).toEqual({ scanned: 0, updated: 0 });
      expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
      expect((await readSessionPrs(prPathA))?.[0]?.state).toBe('open');
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });
});
