/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Storage,
  fetchGitHubPullRequestIssues,
  fetchGitHubPullRequests,
  readSessionPrs,
  updateSessionPrStates,
  upsertSessionPr,
  type SessionService,
} from '@qwen-code/qwen-code-core';
import {
  AONE_MAX_MR_VIEW_CALLS_PER_RUN,
  AoneCommandError,
  type AoneMrBackend,
} from './aone-mrs.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  WorkspaceGenerationClosedError,
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceGenerationGuard,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  DaemonDrainingError,
  SessionArchiveCoordinator,
} from './session-archive.js';
import * as sessionListModule from './session-list.js';
import {
  refreshWorkspaceSessionPrStates,
  resolveSessionPrRefreshIntervalMs,
  startSessionPrRefreshTimer,
} from './session-pr-refresh.js';

// Delegating spy: the Aone tests seed a real repository, so resolution must
// really run — the spy only makes its per-sweep cost observable.
const aoneMocks = vi.hoisted(() => ({
  resolveAoneWorkspaceRepo: vi.fn(),
}));
vi.mock('./aone-mrs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aone-mrs.js')>();
  aoneMocks.resolveAoneWorkspaceRepo.mockImplementation(
    actual.resolveAoneWorkspaceRepo,
  );
  return {
    ...actual,
    resolveAoneWorkspaceRepo: aoneMocks.resolveAoneWorkspaceRepo,
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  fetchGitHubPullRequests: vi.fn(),
  fetchGitHubPullRequestIssues: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<typeof import('node:fs/promises').readFile>(),
  realReadFile: undefined as
    | undefined
    | typeof import('node:fs/promises').readFile,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.realReadFile = actual.readFile;
  fsMocks.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: fsMocks.readFile };
});

const fetchGitHubPullRequestsMock = vi.mocked(fetchGitHubPullRequests);
const fetchGitHubPullRequestIssuesMock = vi.mocked(
  fetchGitHubPullRequestIssues,
);

function closingIssue(number: number, state: 'open' | 'completed' = 'open') {
  return { number, url: `https://github.com/o/r/issues/${number}`, state };
}

function prIssues(
  entries: Array<[number, Array<ReturnType<typeof closingIssue>>]>,
): Awaited<ReturnType<typeof fetchGitHubPullRequestIssues>> {
  return {
    kind: 'ok',
    pullRequests: new Map(
      entries.map(([number, issues]) => [
        number,
        { url: `https://github.com/o/r/pull/${number}`, issues },
      ]),
    ),
  };
}

const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';
const SESSION_C = '00000000-0000-4000-8000-000000000003';

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
  let markSessionCatalogChanged: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-refresh-runtime-'),
    );
    workspaceCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-refresh-work-'),
    );
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    fetchGitHubPullRequestIssuesMock.mockResolvedValue(prIssues([]));
    markSessionCatalogChanged = vi.fn();
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
      bridge: { markSessionCatalogChanged },
    } as unknown as WorkspaceRuntime;
    sessionService = createWorkspaceRuntimeSessionService(runtime);
  });

  afterEach(async () => {
    delete process.env['QWEN_RUNTIME_DIR'];
    fsMocks.readFile.mockImplementation(fsMocks.realReadFile!);
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
      { GH_TOKEN: 'x' },
      { state: 'all', limit: 500, slim: true },
    );
  });

  describe('on an Aone workspace', () => {
    const AONE_URL =
      'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/26430560';

    beforeEach(() => {
      execSync('git init', { cwd: workspaceCwd, stdio: 'pipe' });
      execSync(
        'git remote add origin git@gitlab.alibaba-inc.com:jspt/agentic_coding.git',
        { cwd: workspaceCwd, stdio: 'pipe' },
      );
    });

    function fakeAoneBackend(
      overrides: Partial<AoneMrBackend> = {},
    ): AoneMrBackend {
      return {
        list: vi.fn(async () => []),
        view: vi.fn(async (_repoPath: string, id: number) => ({
          number: id,
          url: AONE_URL,
          state: 'merged' as const,
        })),
        ...overrides,
      };
    }

    it('refreshes a binding state through mr view', async () => {
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      const seeded = await upsertSessionPr(prPath, {
        number: 26430560,
        url: AONE_URL,
      });
      const backend = fakeAoneBackend();

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      expect(result).toEqual({ scanned: 1, updated: 1, aoneConsumed: 1 });
      expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
      expect(backend.view).toHaveBeenCalledWith(
        'jspt/agentic_coding',
        26430560,
      );
      const persisted = await readSessionPrs(prPath);
      expect(persisted?.[0]?.state).toBe('merged');
      expect(persisted?.[0]?.createdAt).toBe(seeded[0]?.createdAt);
    });

    it('converges merged bindings without a snapshot and then costs nothing', async () => {
      // Closing references are GitHub-only, so a merged Aone binding
      // would otherwise keep the workspace pending forever — one origin
      // resolution per sweep for nothing.
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await upsertSessionPr(prPath, {
        number: 26430560,
        url: AONE_URL,
        state: 'merged',
      });
      const backend = fakeAoneBackend();

      const first = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      expect(first).toEqual({ scanned: 1, updated: 1, aoneConsumed: 0 });
      expect(backend.view).not.toHaveBeenCalled();
      expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
      expect((await readSessionPrs(prPath))?.[0]?.issues).toEqual([]);
      expect(aoneMocks.resolveAoneWorkspaceRepo).toHaveBeenCalledTimes(1);

      const second = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      // No pending target at all: the sweep returns before it even
      // resolves the workspace repository (no `aoneConsumed`, no origin
      // spawn).
      expect(second).toEqual({ scanned: 1, updated: 0 });
      expect(backend.view).not.toHaveBeenCalled();
      expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
      expect(aoneMocks.resolveAoneWorkspaceRepo).toHaveBeenCalledTimes(1);
    });

    it('dedupes one mr view across sessions binding the same MR', async () => {
      await seedSession(SESSION_A);
      await seedSession(SESSION_B);
      const prPathA = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      const prPathB = sessionService.getPrSessionPathForArchiveState(
        SESSION_B,
        'active',
      );
      await upsertSessionPr(prPathA, { number: 26430560, url: AONE_URL });
      await upsertSessionPr(prPathB, { number: 26430560, url: AONE_URL });
      const backend = fakeAoneBackend();

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      expect(result).toEqual({ scanned: 2, updated: 2, aoneConsumed: 1 });
      expect(backend.view).toHaveBeenCalledTimes(1);
      expect((await readSessionPrs(prPathA))?.[0]?.state).toBe('merged');
      expect((await readSessionPrs(prPathB))?.[0]?.state).toBe('merged');
    });

    it('applies a non-terminal view state (open beats stale closed)', async () => {
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      // 'closed' stays in the pending set (only merged is terminal), so a
      // reopened MR's fresh 'open' must reach the sidecar — pinning the
      // view.state passthrough against a hardcoded-state mutation.
      await upsertSessionPr(prPath, {
        number: 26430560,
        url: AONE_URL,
        state: 'closed',
      });
      const backend = fakeAoneBackend({
        view: vi.fn(async (_repoPath: string, id: number) => ({
          number: id,
          url: AONE_URL,
          state: 'open' as const,
        })),
      });

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      expect(result).toEqual({ scanned: 1, updated: 1, aoneConsumed: 1 });
      expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
    });

    it('leaves the binding untouched when mr view fails', async () => {
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await upsertSessionPr(prPath, { number: 26430560, url: AONE_URL });
      const backend = fakeAoneBackend({
        view: vi.fn(async () => {
          throw new AoneCommandError('403 Forbidden');
        }),
      });

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      // consumed counts views STARTED (one was, and failed), not updates.
      expect(result).toEqual({ scanned: 1, updated: 0, aoneConsumed: 1 });
      expect((await readSessionPrs(prPath))?.[0]?.state).toBeUndefined();
    });

    it('caps mr view calls per sweep', async () => {
      // Spread AONE_MAX_MR_VIEW_CALLS_PER_RUN + 2 unique numbers over
      // several sessions (one sidecar caps at 10 entries) so the sweep
      // collects more pending numbers than the per-sweep view budget.
      const sessionIds = [SESSION_A, SESSION_B, SESSION_C];
      let number = 1;
      for (const sessionId of sessionIds) {
        await seedSession(sessionId);
        const prPath = sessionService.getPrSessionPathForArchiveState(
          sessionId,
          'active',
        );
        for (let i = 0; i < 9; i++, number++) {
          await upsertSessionPr(prPath, {
            number,
            url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${number}`,
          });
        }
      }
      const view = vi.fn(async (_repoPath: string, id: number) => ({
        number: id,
        url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
        state: 'merged' as const,
      }));
      const backend = fakeAoneBackend({ view });

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
      expect(result).toEqual({
        scanned: 3,
        updated: AONE_MAX_MR_VIEW_CALLS_PER_RUN,
        aoneConsumed: AONE_MAX_MR_VIEW_CALLS_PER_RUN,
      });
    });

    it('never views numbers whose only binding is off the detailUrl shape', async () => {
      // Manual binding is platform-neutral: a foreign URL can never match
      // an attested detailUrl, so viewing its number (a global id — one
      // usually exists) would only burn a capped slot every sweep.
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await upsertSessionPr(prPath, { number: 26430560, url: AONE_URL });
      await upsertSessionPr(prPath, {
        number: 12345,
        url: 'https://github.com/elsewhere/other/pull/12345',
      });
      const view = vi.fn(async (_repoPath: string, id: number) => ({
        number: id,
        url: AONE_URL,
        state: 'merged' as const,
      }));
      const backend = fakeAoneBackend({ view });

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      expect(view).toHaveBeenCalledTimes(1);
      expect(view).toHaveBeenCalledWith('jspt/agentic_coding', 26430560);
      expect(result).toEqual({ scanned: 1, updated: 1, aoneConsumed: 1 });
    });

    it('never views a number whose only binding is git-host spelled', async () => {
      // The identity check must agree with the write path's exact canonical
      // equality: a detailUrl spelled with the GIT host can never match the
      // web-host detailUrl a1 attests, so viewing it would spend a capped
      // slot (and part of the sweep budget) on a state that can never land.
      // The filter excludes it entirely — no view, no wasted slot.
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      await upsertSessionPr(prPath, {
        number: 26430560,
        url: 'https://gitlab.alibaba-inc.com/jspt/agentic_coding/codereview/26430560',
      });
      const view = vi.fn(async (_repoPath: string, id: number) => ({
        number: id,
        url: AONE_URL,
        state: 'merged' as const,
      }));
      const backend = fakeAoneBackend({ view });

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
      });

      expect(view).not.toHaveBeenCalled();
      expect(result).toEqual({ scanned: 1, updated: 0, aoneConsumed: 0 });
      expect((await readSessionPrs(prPath))?.[0]?.state).toBeUndefined();
    });

    it('rotates the capped window across sweeps', async () => {
      // With more permanently pending numbers than the cap, a fixed prefix
      // would starve the tail; the timer rotates sweepStart per sweep.
      // View returns a NON-terminal state so nothing leaves the pending
      // set between the two sweeps.
      const sessionIds = [SESSION_A, SESSION_B, SESSION_C];
      let number = 1;
      for (const sessionId of sessionIds) {
        await seedSession(sessionId);
        const prPath = sessionService.getPrSessionPathForArchiveState(
          sessionId,
          'active',
        );
        for (let i = 0; i < 9; i++, number++) {
          await upsertSessionPr(prPath, {
            number,
            url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${number}`,
          });
        }
      }
      const seen = new Set<number>();
      const view = vi.fn(async (_repoPath: string, id: number) => {
        seen.add(id);
        return {
          number: id,
          url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
          state: 'open' as const,
        };
      });
      const backend = fakeAoneBackend({ view });

      await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
        sweepStart: 0,
      });
      expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
      await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
        sweepStart: AONE_MAX_MR_VIEW_CALLS_PER_RUN,
      });
      expect(view).toHaveBeenCalledTimes(2 * AONE_MAX_MR_VIEW_CALLS_PER_RUN);
      // Two rotated windows cover all 27 numbers; a fixed prefix repeats
      // the first 25 and never reaches 26/27.
      expect(seen.size).toBe(27);
    });

    it('stops starting views once the aggregate sweep budget is spent', async () => {
      // Per-call timeouts bound one view; the aggregate budget bounds the
      // loop, or a hung a1 could stall the whole timer past its interval.
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      for (let i = 1; i <= 5; i++) {
        await upsertSessionPr(prPath, {
          number: i,
          url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${i}`,
        });
      }
      // Each view "hangs" for the full per-call timeout; the 60s budget
      // admits four of five before the loop stops starting new views.
      let clock = 0;
      const view = vi.fn(async (_repoPath: string, id: number) => {
        clock += 20_000;
        return {
          number: id,
          url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
          state: 'merged' as const,
        };
      });
      const backend = fakeAoneBackend({ view });

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
        now: () => clock,
      });

      expect(view).toHaveBeenCalledTimes(4);
      expect(result).toEqual({ scanned: 1, updated: 4, aoneConsumed: 4 });
    });

    it('reports consumed so a truncated window tiles contiguously', async () => {
      // Under the aggregate budget the timer must advance the rotation by
      // how far the window actually GOT (aoneConsumed), not the fixed cap —
      // else the truncated tail falls in the gap between windows. Five
      // pending numbers, a clock advancing a full per-call timeout per view,
      // admit four; consumed must report 4, not the cap of 25.
      await seedSession(SESSION_A);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        SESSION_A,
        'active',
      );
      for (let i = 1; i <= 5; i++) {
        await upsertSessionPr(prPath, {
          number: i,
          url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${i}`,
        });
      }
      let clock = 0;
      const view = vi.fn(async (_repoPath: string, id: number) => {
        clock += 20_000;
        return {
          number: id,
          url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
          state: 'merged' as const,
        };
      });
      const backend = fakeAoneBackend({ view });

      const result = await refreshWorkspaceSessionPrStates(runtime, undefined, {
        aoneBackend: backend,
        now: () => clock,
      });

      expect(result.aoneConsumed).toBe(4);
      expect(result.aoneConsumed).toBeLessThan(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    });
  });

  it("never applies this workspace's state to a binding pointing at another repository", async () => {
    // The metadata route accepts any http(s) pr.url, so a client can bind a
    // foreign-repo PR whose number collides with this workspace's own; the
    // workspace's same-numbered PR state must not leak onto it (a wrong
    // 'merged' would also be permanent — merged entries leave the sweep).
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/other-org/other-repo/pull/42',
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

  it('does not resurrect a sidecar whose session is deleted mid-sweep', async () => {
    // Session deletion unlinks the transcript and sidecar outside the
    // mutation queue. Land the deletion the moment the queued refresh read
    // resolves; without the commit-step guard the write recreates the
    // sidecar at the stale path and it haunts every future sweep.
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
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    const transcriptPath = path.join(chatsDir, `${SESSION_A}.jsonl`);
    let prPathReads = 0;
    fsMocks.readFile.mockImplementation(async (...args) => {
      const content = await fsMocks.realReadFile!(...args);
      if (args[0] === prPath) {
        prPathReads += 1;
        // Second read is the queued refresh write's own read — the
        // deletion lands right after it captured the contents.
        if (prPathReads === 2) {
          await fsp.unlink(transcriptPath);
          await fsp.unlink(prPath);
        }
      }
      return content;
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect(existsSync(prPath)).toBe(false);
    expect(markSessionCatalogChanged).not.toHaveBeenCalled();
  });

  function attachGuard(target: WorkspaceRuntime): WorkspaceGenerationGuard {
    const guard = createWorkspaceGenerationGuard();
    (target as { generationGuard?: WorkspaceGenerationGuard }).generationGuard =
      guard;
    return guard;
  }

  async function seedOpenBinding(sessionId: string): Promise<string> {
    await seedSession(sessionId);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      sessionId,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    return prPath;
  }

  it('never runs gh for a retired runtime generation', async () => {
    const prPath = await seedOpenBinding(SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    // The timer snapshots the runtime from the registry; a trust/env
    // replacement that lands while the sidecar scan awaits closes its guard,
    // and `gh` must not run with the retired generation's env.
    attachGuard(runtime).close();

    await expect(
      refreshWorkspaceSessionPrStates(runtime),
    ).rejects.toBeInstanceOf(WorkspaceGenerationClosedError);

    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
    expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
    expect(markSessionCatalogChanged).not.toHaveBeenCalled();
  });

  it('commits nothing and notifies nobody once the generation closes mid-sweep', async () => {
    const prPath = await seedOpenBinding(SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    const guard = attachGuard(runtime);
    let prPathReads = 0;
    fsMocks.readFile.mockImplementation(async (...args) => {
      const content = await fsMocks.realReadFile!(...args);
      if (args[0] === prPath) {
        prPathReads += 1;
        // Second read is the queued write's own read: the replacement lands
        // after the sweep already fetched from gh and planned the rewrite.
        if (prPathReads === 2) guard.close();
      }
      return content;
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
    expect(markSessionCatalogChanged).not.toHaveBeenCalled();
  });

  it('defers a sidecar held by an archive lane to the next sweep', async () => {
    const prPath = await seedOpenBinding(SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    const archiveCoordinator = new SessionArchiveCoordinator();
    let release!: () => void;
    // An archive/delete in flight holds the session's exclusive lane across
    // its renames; the commit must not race it.
    const archiving = archiveCoordinator.runExclusiveMany(
      [SESSION_A],
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const held = await refreshWorkspaceSessionPrStates(runtime, undefined, {
      archiveCoordinator,
    });
    expect(held).toEqual({ scanned: 1, updated: 0 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
    expect(markSessionCatalogChanged).not.toHaveBeenCalled();

    release();
    await archiving;
    const retried = await refreshWorkspaceSessionPrStates(runtime, undefined, {
      archiveCoordinator,
    });
    expect(retried).toEqual({ scanned: 1, updated: 1 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('merged');
    expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
  });

  it('stops the sweep once the daemon seals session maintenance', async () => {
    const prPath = await seedOpenBinding(SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    const archiveCoordinator = new SessionArchiveCoordinator();
    await archiveCoordinator.sealMaintenanceAndWait();

    await expect(
      refreshWorkspaceSessionPrStates(runtime, undefined, {
        archiveCoordinator,
      }),
    ).rejects.toBeInstanceOf(DaemonDrainingError);

    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
    expect(markSessionCatalogChanged).not.toHaveBeenCalled();
  });

  it('counts only the bindings whose state was rewritten', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    // 42 changes, 43 stays open: counting every pending binding present in
    // the gh page would report two rewrites for one actual change.
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    await upsertSessionPr(prPath, {
      number: 43,
      url: 'https://github.com/o/r/pull/43',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged'), pr(43, 'open')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect(
      (await readSessionPrs(prPath))?.map((p) => [p.number, p.state]),
    ).toEqual([
      [42, 'merged'],
      [43, 'open'],
    ]);
  });

  it('invalidates the session-list cache and marks the catalog when a binding changed', async () => {
    // The sidebar refetch is catalog-version-gated and the live-state
    // payload carries no `prs`; a rewrite without this pairing leaves the
    // stale badge on an otherwise-idle workspace indefinitely.
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
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    const invalidateSpy = vi.spyOn(
      sessionListModule,
      'invalidateWorkspaceSessionListCache',
    );

    try {
      const result = await refreshWorkspaceSessionPrStates(runtime);

      expect(result).toEqual({ scanned: 1, updated: 1 });
      expect(invalidateSpy).toHaveBeenCalledWith({
        runtimeBaseDir: runtimeDir,
        workspaceCwd,
        archiveStates: ['active', 'archived'],
      });
      expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    } finally {
      invalidateSpy.mockRestore();
    }
  });

  it('leaves the cache and catalog untouched when no binding changed', async () => {
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
      kind: 'ok',
      pullRequests: [pr(42, 'open')],
    });
    const invalidateSpy = vi.spyOn(
      sessionListModule,
      'invalidateWorkspaceSessionListCache',
    );

    try {
      const result = await refreshWorkspaceSessionPrStates(runtime);

      expect(result).toEqual({ scanned: 1, updated: 0 });
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(markSessionCatalogChanged).not.toHaveBeenCalled();
    } finally {
      invalidateSpy.mockRestore();
    }
  });

  it('skips the list query when every binding is merged, and every query once their issues are snapshotted', async () => {
    await seedSession(SESSION_A);
    const prPathA = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPathA, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'merged',
    });
    await seedSession(SESSION_B);
    const prPathB = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
    );
    await upsertSessionPr(prPathB, {
      number: 43,
      url: 'https://github.com/o/r/pull/43',
      state: 'merged',
    });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue(
      prIssues([
        [42, [closingIssue(7, 'completed')]],
        [43, []],
      ]),
    );

    // Merged bindings that predate the issue snapshot get one by-number
    // lookup (legacy sidecars), never the list query.
    const first = await refreshWorkspaceSessionPrStates(runtime);

    expect(first).toEqual({ scanned: 2, updated: 2 });
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
    expect(fetchGitHubPullRequestIssuesMock).toHaveBeenCalledWith(
      workspaceCwd,
      { GH_TOKEN: 'x' },
      [42, 43],
    );
    expect((await readSessionPrs(prPathA))?.[0]?.issues).toEqual([
      closingIssue(7, 'completed'),
    ]);
    expect((await readSessionPrs(prPathB))?.[0]?.issues).toEqual([]);

    fetchGitHubPullRequestIssuesMock.mockClear();
    const second = await refreshWorkspaceSessionPrStates(runtime);

    expect(second).toEqual({ scanned: 2, updated: 0 });
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
    expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
  });

  it('snapshots the closing issues of an open binding alongside its state', async () => {
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
    fetchGitHubPullRequestIssuesMock.mockResolvedValue(
      prIssues([[42, [closingIssue(7)]]]),
    );

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    const persisted = await readSessionPrs(prPath);
    expect(persisted?.[0]).toMatchObject({
      state: 'merged',
      issues: [closingIssue(7)],
      createdAt: seeded[0]?.createdAt,
    });
    expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);

    // Closing references change while a PR is open: the next sweep tracks
    // an issue added to the body, and a closed issue's state.
    await updateSessionPrStates(
      prPath,
      new Map([[42, { state: 'open' as const, url: persisted![0]!.url }]]),
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'open')],
    });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue(
      prIssues([[42, [closingIssue(7, 'completed'), closingIssue(8)]]]),
    );

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 1,
    });
    expect((await readSessionPrs(prPath))?.[0]?.issues).toEqual([
      closingIssue(7, 'completed'),
      closingIssue(8),
    ]);
  });

  it("never applies issues from this workspace's same-numbered PR to a foreign binding", async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/other-org/other-repo/pull/42',
      state: 'merged',
    });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue(
      prIssues([[42, [closingIssue(7)]]]),
    );

    // The repository cannot resolve a foreign binding, so the lookup
    // converges it with an empty snapshot instead of re-querying it every
    // sweep forever.
    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 1,
    });
    expect((await readSessionPrs(prPath))?.[0]?.issues).toEqual([]);

    fetchGitHubPullRequestIssuesMock.mockClear();
    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 0,
    });
    expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
  });

  it('converges a merged binding the lookup resolves to nothing', async () => {
    // Another repository's merged PR whose number this repository does not
    // have at all: the lookup succeeds with an empty result, and the
    // binding must leave the sweep on that success instead of being
    // re-queried every five minutes.
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 424242,
      url: 'https://github.com/other-org/other-repo/pull/424242',
      state: 'merged',
    });

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 1,
    });
    expect((await readSessionPrs(prPath))?.[0]?.issues).toEqual([]);
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
    expect(fetchGitHubPullRequestIssuesMock).toHaveBeenCalledTimes(1);

    fetchGitHubPullRequestIssuesMock.mockClear();
    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 0,
    });
    expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
  });

  it('keeps a foreign open binding out of the issue lookup', async () => {
    // The list query names this workspace's repository; an open binding to
    // another repository can never resolve here and must not cost the
    // lookup every sweep (the Aone branch filters the same way).
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/other-org/other-repo/pull/42',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'open')],
    });

    for (const round of [1, 2]) {
      expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
        scanned: 1,
        updated: 0,
      });
      expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(round);
      expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
    }
    expect((await readSessionPrs(prPath))?.[0]).toMatchObject({
      state: 'open',
    });
    expect((await readSessionPrs(prPath))?.[0]?.issues).toBeUndefined();
  });

  it('converges merged bindings locally when the lookup is structurally impossible', async () => {
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'merged',
    });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue({
      kind: 'cli_unavailable',
    });

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 1,
    });
    expect((await readSessionPrs(prPath))?.[0]?.issues).toEqual([]);

    fetchGitHubPullRequestIssuesMock.mockClear();
    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 0,
    });
    expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
  });

  it('converges merged bindings when the cwd is not a git repository or gh has no usable remote', async () => {
    for (const kind of ['not_a_repo', 'repo_unresolved'] as const) {
      const sessionId = kind === 'not_a_repo' ? SESSION_A : SESSION_B;
      await seedSession(sessionId);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        'active',
      );
      await upsertSessionPr(prPath, {
        number: kind === 'not_a_repo' ? 42 : 43,
        url: `https://github.com/o/r/pull/${kind === 'not_a_repo' ? 42 : 43}`,
        state: 'merged',
      });
      fetchGitHubPullRequestIssuesMock.mockClear();
      fetchGitHubPullRequestIssuesMock.mockResolvedValue({ kind });

      expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
        scanned: kind === 'not_a_repo' ? 1 : 2,
        updated: 1,
      });
      expect((await readSessionPrs(prPath))?.[0]?.issues).toEqual([]);

      fetchGitHubPullRequestIssuesMock.mockClear();
      expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
        scanned: kind === 'not_a_repo' ? 1 : 2,
        updated: 0,
      });
      expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
    }
  });

  it('applies fetched issues to a binding spelled with a non-canonical url', async () => {
    // The bind path accepts any http(s) url: `/files`, `www.`, `http:` all
    // name the same PR and must receive its issues, not a false empty
    // snapshot (which would be permanent for a merged binding).
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    const url = 'http://www.github.com/O/R/pull/42/files';
    await upsertSessionPr(prPath, { number: 42, url, state: 'merged' });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue(
      prIssues([[42, [closingIssue(7)]]]),
    );

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 1,
    });
    expect((await readSessionPrs(prPath))?.[0]).toMatchObject({
      url,
      issues: [closingIssue(7)],
    });
  });

  it('converges a merged foreign binding during a lookup outage', async () => {
    // The list query (run for the open local binding) names the
    // repository; the merged foreign binding can never resolve here, so it
    // converges even while the lookup itself is failing.
    await seedSession(SESSION_A);
    const prPathA = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPathA, {
      number: 42,
      url: 'https://github.com/other-org/other-repo/pull/42',
      state: 'merged',
    });
    await seedSession(SESSION_B);
    const prPathB = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
    );
    await upsertSessionPr(prPathB, {
      number: 43,
      url: 'https://github.com/o/r/pull/43',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(43, 'open')],
    });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue({
      kind: 'failed',
      message: 'HTTP 502',
      gitRoot: workspaceCwd,
    });

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 2,
      updated: 1,
    });
    expect(fetchGitHubPullRequestIssuesMock).toHaveBeenCalledWith(
      workspaceCwd,
      { GH_TOKEN: 'x' },
      [43],
    );
    expect((await readSessionPrs(prPathA))?.[0]?.issues).toEqual([]);
    expect((await readSessionPrs(prPathB))?.[0]?.issues).toBeUndefined();
  });

  it('keeps retrying a merged binding after a transient lookup failure', async () => {
    // A 5xx or rate limit says nothing about the PR's references; an
    // empty snapshot here would permanently record "fetched, none".
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'merged',
    });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue({
      kind: 'failed',
      message: 'HTTP 502',
      gitRoot: workspaceCwd,
    });

    for (const round of [1, 2]) {
      expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
        scanned: 1,
        updated: 0,
      });
      expect(fetchGitHubPullRequestIssuesMock).toHaveBeenCalledTimes(round);
    }
    expect((await readSessionPrs(prPath))?.[0]?.issues).toBeUndefined();
  });

  it('runs the list query for a mixed workspace', async () => {
    // One legacy merged binding (issue catch-up only) next to one open
    // binding: the open one still needs its state refreshed.
    await seedSession(SESSION_A);
    const prPathA = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPathA, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'merged',
    });
    await seedSession(SESSION_B);
    const prPathB = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
    );
    await upsertSessionPr(prPathB, {
      number: 43,
      url: 'https://github.com/o/r/pull/43',
      state: 'open',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(43, 'merged')],
    });

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 2,
      updated: 2,
    });
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);
    expect((await readSessionPrs(prPathB))?.[0]?.state).toBe('merged');
    expect((await readSessionPrs(prPathA))?.[0]?.issues).toEqual([]);
  });

  it('never runs the issue lookup once the generation closes between the two queries', async () => {
    const prPath = await seedOpenBinding(SESSION_A);
    const guard = attachGuard(runtime);
    fetchGitHubPullRequestsMock.mockImplementation(async () => {
      // A trust/env replacement lands while the list query is in flight.
      guard.close();
      return { kind: 'ok', pullRequests: [pr(42, 'merged')] };
    });

    await expect(
      refreshWorkspaceSessionPrStates(runtime),
    ).rejects.toBeInstanceOf(WorkspaceGenerationClosedError);

    expect(fetchGitHubPullRequestIssuesMock).not.toHaveBeenCalled();
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
    expect(markSessionCatalogChanged).not.toHaveBeenCalled();
  });

  it('still snapshots issues when the list query fails', async () => {
    const prPath = await seedOpenBinding(SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue(
      prIssues([[42, [closingIssue(7)]]]),
    );

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 1,
    });
    expect((await readSessionPrs(prPath))?.[0]).toMatchObject({
      state: 'open',
      issues: [closingIssue(7)],
    });
  });

  it('still refreshes states when the issue lookup fails', async () => {
    const prPath = await seedOpenBinding(SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    fetchGitHubPullRequestIssuesMock.mockResolvedValue({
      kind: 'failed',
      message: 'HTTP 502',
      gitRoot: workspaceCwd,
    });

    expect(await refreshWorkspaceSessionPrStates(runtime)).toEqual({
      scanned: 1,
      updated: 1,
    });
    expect((await readSessionPrs(prPath))?.[0]).toMatchObject({
      state: 'merged',
    });
    expect((await readSessionPrs(prPath))?.[0]?.issues).toBeUndefined();
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
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledWith(
      workspaceCwd,
      { GH_TOKEN: 'x' },
      { state: 'all', limit: 500, slim: true },
    );
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

  it('treats a draft PR as open for the state snapshot', async () => {
    // The sidecar snapshot has no 'draft' variant, and isValidSessionPr
    // rejects it — a persisted 'draft' would hide the session's bindings.
    // Seeded 'closed' so the normalization is an observable rewrite.
    await seedSession(SESSION_A);
    const prPath = sessionService.getPrSessionPathForArchiveState(
      SESSION_A,
      'active',
    );
    await upsertSessionPr(prPath, {
      number: 44,
      url: 'https://github.com/o/r/pull/44',
      state: 'closed',
    });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(44, 'draft')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect((await readSessionPrs(prPath))?.[0]?.state).toBe('open');
  });

  it('keeps sweeping when a sidecar is corrupt or unreadable', async () => {
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
    // Invalid JSON makes readSessionPrs return null...
    await seedSession(SESSION_B);
    const prPathB = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
    );
    await fsp.writeFile(prPathB, '{invalid', 'utf8');
    // ...and a directory at the path makes it throw (EISDIR). Neither may
    // abort the sweep for the healthy sessions that follow.
    await seedSession(SESSION_C);
    const prPathC = sessionService.getPrSessionPathForArchiveState(
      SESSION_C,
      'active',
    );
    await fsp.mkdir(prPathC, { recursive: true });
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect((await readSessionPrs(prPathA))?.[0]?.state).toBe('merged');
    expect(await fsp.readFile(prPathB, 'utf8')).toBe('{invalid');
  });

  it('keeps sweeping when a transcript head has no string cwd', async () => {
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
    // A head that parses as an object but carries no string cwd is
    // inconclusive; it must not abort the whole workspace's sweep.
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.writeFile(
      path.join(chatsDir, `${SESSION_B}.jsonl`),
      `${JSON.stringify({})}\n`,
      'utf8',
    );
    const prPathB = sessionService.getPrSessionPathForArchiveState(
      SESSION_B,
      'active',
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

    const result = await refreshWorkspaceSessionPrStates(runtime);

    expect(result).toEqual({ scanned: 2, updated: 2 });
    expect((await readSessionPrs(prPathA))?.[0]?.state).toBe('merged');
    expect((await readSessionPrs(prPathB))?.[0]?.state).toBe('merged');
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

  it('refreshes a pre-flush sidecar despite a cwd collision (accepted fail-open)', async () => {
    // Same collision as above, but the foreign session has no transcript
    // yet: the belongs-check is inconclusive and deliberately fails open so
    // pre-flush bindings stay refreshable. Harm is bounded — only `state`
    // is rewritten, and the owner's flush reasserts its own project.
    const parent = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-collide-open-'),
    );
    try {
      const cwdA = path.join(parent, 'my-app');
      const cwdB = path.join(parent, 'my.app');
      await fsp.mkdir(cwdA, { recursive: true });
      await fsp.mkdir(cwdB, { recursive: true });
      const runtimeB = {
        workspaceId: 'collide-b',
        workspaceCwd: cwdB,
        sessionRuntimeBaseDir: runtimeDir,
        primary: true,
        trusted: true,
        env: { mode: 'parent-process', overlayKeys: [] },
        bridge: { markSessionCatalogChanged: vi.fn() },
      } as unknown as WorkspaceRuntime;
      const serviceA = createWorkspaceRuntimeSessionService({
        ...runtimeB,
        workspaceId: 'collide-a',
        workspaceCwd: cwdA,
      } as unknown as WorkspaceRuntime);
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

      expect(result).toEqual({ scanned: 1, updated: 1 });
      expect((await readSessionPrs(prPathA))?.[0]?.state).toBe('merged');
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });
});

describe('startSessionPrRefreshTimer', () => {
  let baseDir: string;
  let trustedCwd: string;
  let untrustedCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-pr-timer-base-'));
    trustedCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-timer-trusted-'),
    );
    untrustedCwd = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pr-timer-untrusted-'),
    );
    process.env['QWEN_RUNTIME_DIR'] = baseDir;
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['QWEN_RUNTIME_DIR'];
    for (const dir of [baseDir, trustedCwd, untrustedCwd]) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  function timerRuntime(
    workspaceId: string,
    workspaceCwd: string,
    trusted: boolean,
  ): WorkspaceRuntime {
    return {
      workspaceId,
      workspaceCwd,
      sessionRuntimeBaseDir: baseDir,
      primary: trusted,
      trusted,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: { markSessionCatalogChanged: vi.fn() },
    } as unknown as WorkspaceRuntime;
  }

  async function seedPendingBinding(
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): Promise<string> {
    const service = createWorkspaceRuntimeSessionService(runtime);
    const chatsDir = path.join(
      new Storage(runtime.workspaceCwd).getProjectDir(),
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
        cwd: runtime.workspaceCwd,
      })}\n`,
      'utf8',
    );
    const prPath = service.getPrSessionPathForArchiveState(sessionId, 'active');
    await upsertSessionPr(prPath, {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
    });
    return prPath;
  }

  it('returns undefined when disabled via QWEN_SESSION_PR_REFRESH_MINUTES=0', () => {
    const registry = createWorkspaceRegistry([
      timerRuntime('trusted', trustedCwd, true),
    ]);

    expect(
      startSessionPrRefreshTimer({
        workspaceRegistry: registry,
        env: { QWEN_SESSION_PR_REFRESH_MINUTES: '0' },
      }),
    ).toBeUndefined();
  });

  it('sweeps only trusted workspaces after the first-run delay', async () => {
    const trustedRuntime = timerRuntime('trusted', trustedCwd, true);
    const untrustedRuntime = timerRuntime('untrusted', untrustedCwd, false);
    const registry = createWorkspaceRegistry([
      trustedRuntime,
      untrustedRuntime,
    ]);
    const trustedPrPath = await seedPendingBinding(trustedRuntime, SESSION_A);
    const untrustedPrPath = await seedPendingBinding(
      untrustedRuntime,
      SESSION_B,
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: {},
    });
    expect(handle).toBeDefined();
    // The first sweep is delayed to stay out of boot's way.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000); // crosses the first-run delay
    await vi.waitFor(() => {
      expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledWith(
      trustedCwd,
      undefined,
      { state: 'all', limit: 500, slim: true },
    );
    await vi.waitFor(async () => {
      expect((await readSessionPrs(trustedPrPath))?.[0]?.state).toBe('merged');
    });
    // The untrusted workspace's sidecar must never be read or rewritten.
    expect((await readSessionPrs(untrustedPrPath))?.[0]?.state).toBe('open');

    handle?.dispose();
  });

  it('skips an overlapping tick while a sweep is still running', async () => {
    const trustedRuntime = timerRuntime('trusted', trustedCwd, true);
    const registry = createWorkspaceRegistry([trustedRuntime]);
    const prPath = await seedPendingBinding(trustedRuntime, SESSION_A);
    let releaseFetch!: () => void;
    fetchGitHubPullRequestsMock.mockReturnValue(
      new Promise((resolve) => {
        releaseFetch = () =>
          resolve({ kind: 'ok', pullRequests: [pr(42, 'merged')] });
      }),
    );
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: { QWEN_SESSION_PR_REFRESH_MINUTES: '1' },
    });
    expect(handle).toBeDefined();

    // The first tick reaches the (hung) gh fetch and holds `running`; every
    // tick that lands while it is in flight must be skipped, not start a
    // second sweep.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fetchGitHubPullRequestsMock).toHaveBeenCalledTimes(1);

    releaseFetch();
    await vi.waitFor(async () => {
      expect((await readSessionPrs(prPath))?.[0]?.state).toBe('merged');
    });
    handle?.dispose();
  });

  it('stops ticking after dispose', async () => {
    const trustedRuntime = timerRuntime('trusted', trustedCwd, true);
    const registry = createWorkspaceRegistry([trustedRuntime]);
    await seedPendingBinding(trustedRuntime, SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: {},
    });
    expect(handle).toBeDefined();
    handle?.dispose();

    // Far past the first-run delay and several default intervals: a
    // still-armed timer would have swept long before this point.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchGitHubPullRequestsMock).not.toHaveBeenCalled();
  });

  it('commits every sweep under the archive lane resolved at tick time', async () => {
    const trustedRuntime = timerRuntime('trusted', trustedCwd, true);
    const registry = createWorkspaceRegistry([trustedRuntime]);
    const prPath = await seedPendingBinding(trustedRuntime, SESSION_A);
    fetchGitHubPullRequestsMock.mockResolvedValue({
      kind: 'ok',
      pullRequests: [pr(42, 'merged')],
    });
    // The daemon parks the coordinator on the serve app, which exists only
    // after the timer starts — so it is looked up per tick, not captured.
    const app: { archiveCoordinator?: SessionArchiveCoordinator } = {};
    const getArchiveCoordinator = vi.fn(() => app.archiveCoordinator);
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: {},
      getArchiveCoordinator,
    });
    app.archiveCoordinator = new SessionArchiveCoordinator();
    const runSharedMany = vi.spyOn(app.archiveCoordinator, 'runSharedMany');

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      expect((await readSessionPrs(prPath))?.[0]?.state).toBe('merged');
    });
    expect(getArchiveCoordinator).toHaveBeenCalled();
    expect(runSharedMany).toHaveBeenCalledWith(
      [SESSION_A],
      expect.any(Function),
    );

    handle?.dispose();
  });

  // Seeds `total` detailUrl-shaped pending bindings (all non-merged, so they
  // stay pending across sweeps) across ceil(total/10) sessions — one sidecar
  // caps at SESSION_PR_LIST_LIMIT — in a git repo whose origin is Aone, so
  // the sweep's platform detection keys on the a1 path.
  async function seedAoneTimerWorkspace(
    runtime: WorkspaceRuntime,
    total: number,
  ): Promise<void> {
    execSync('git init', { cwd: runtime.workspaceCwd, stdio: 'pipe' });
    execSync(
      'git remote add origin git@gitlab.alibaba-inc.com:jspt/agentic_coding.git',
      { cwd: runtime.workspaceCwd, stdio: 'pipe' },
    );
    const service = createWorkspaceRuntimeSessionService(runtime);
    const chatsDir = path.join(
      new Storage(runtime.workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.mkdir(chatsDir, { recursive: true });
    let number = 1;
    let sessionIdx = 0;
    while (number <= total) {
      const sessionId = `00000000-0000-4000-8000-${String(300 + sessionIdx).padStart(12, '0')}`;
      sessionIdx += 1;
      await fsp.writeFile(
        path.join(chatsDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          uuid: `${sessionId}-user-1`,
          parentUuid: null,
          sessionId,
          timestamp: '2026-08-01T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'hello' }] },
          cwd: runtime.workspaceCwd,
        })}\n`,
        'utf8',
      );
      const prPath = service.getPrSessionPathForArchiveState(
        sessionId,
        'active',
      );
      for (let i = 0; i < 10 && number <= total; i++, number++) {
        await upsertSessionPr(prPath, {
          number,
          url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${number}`,
        });
      }
    }
  }

  function attachTimerGuard(
    target: WorkspaceRuntime,
  ): WorkspaceGenerationGuard {
    const guard = createWorkspaceGenerationGuard();
    (target as { generationGuard?: WorkspaceGenerationGuard }).generationGuard =
      guard;
    return guard;
  }

  // The sweep's observable completion signal: the bridge notification fires
  // only after the LAST sidecar commit of the tick. Waiting on it before
  // crossing the next interval is what keeps these timer tests deterministic
  // under full-suite load — advancing the fake clock the instant the VIEW
  // count lands races the tick's real-fs commit tail, and the re-entrancy
  // guard then silently skips the next tick (intermittent red).
  const sweepDone = (runtime: WorkspaceRuntime, times: number): Promise<void> =>
    vi.waitFor(
      () => {
        expect(
          runtime.bridge.markSessionCatalogChanged as ReturnType<typeof vi.fn>,
        ).toHaveBeenCalledTimes(times);
      },
      { timeout: 30_000 },
    );

  it('rotates the Aone view window across timer ticks', async () => {
    // 30 pending (> the 25 cap): tick 1 must view the first window, tick 2
    // a DIFFERENT window — the timer advances sweepStart, so the union of
    // the two windows covers all 30. A dropped sweepStart passthrough (a
    // fixed prefix) would re-view the same first 25 both ticks.
    const total = 30;
    const runtime = timerRuntime('aone', trustedCwd, true);
    await seedAoneTimerWorkspace(runtime, total);
    const perTickViews: number[][] = [];
    let current: number[] = [];
    const view = vi.fn(async (_repoPath: string, id: number) => {
      current.push(id);
      return {
        number: id,
        url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
        // Non-terminal: nothing leaves the pending set between ticks.
        state: 'open' as const,
      };
    });
    const backend: AoneMrBackend = { list: vi.fn(async () => []), view };
    const registry = {
      listAll: () => [runtime],
    } as unknown as WorkspaceRegistry;
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: {},
      aoneBackend: backend,
    });

    await vi.advanceTimersByTimeAsync(60_000); // crosses the first-run delay
    await vi.waitFor(() => {
      expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    });
    await sweepDone(runtime, 1); // tick 1 fully committed before next tick
    perTickViews.push(current);
    current = [];

    await vi.advanceTimersByTimeAsync(5 * 60_000); // next interval
    await vi.waitFor(() => {
      expect(view).toHaveBeenCalledTimes(2 * AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    });
    await sweepDone(runtime, 2);
    perTickViews.push(current);

    const union = new Set(perTickViews.flat());
    // Both windows together cover every pending number; a fixed prefix would
    // cap the union at the window size.
    expect(union.size).toBe(total);
    handle?.dispose();
  });

  it('prunes the sweep offset of a workspace removed from the registry', async () => {
    // If the offset survived removal, re-adding the workspace would resume the
    // stale window; pruning resets it to 0, so the re-added workspace's first
    // sweep re-views the first window (ids 21..25 included, which a stale
    // offset-25 window would skip).
    const total = 30;
    const runtime = timerRuntime('aone', trustedCwd, true);
    await seedAoneTimerWorkspace(runtime, total);
    const perTickViews: number[][] = [];
    let current: number[] = [];
    const view = vi.fn(async (_repoPath: string, id: number) => {
      current.push(id);
      return {
        number: id,
        url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
        state: 'open' as const,
      };
    });
    const backend: AoneMrBackend = { list: vi.fn(async () => []), view };
    const runtimes: WorkspaceRuntime[] = [runtime];
    const registry = {
      listAll: () => runtimes,
    } as unknown as WorkspaceRegistry;
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: {},
      aoneBackend: backend,
    });

    // Tick 1: workspace swept, offset advances past 0.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    });
    await sweepDone(runtime, 1); // tick 1 fully committed before removal
    perTickViews.push(current);
    current = [];

    // Tick 2: workspace removed → not swept, its offset must be pruned.
    runtimes.length = 0;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(10);

    // Tick 3: workspace re-added → a pruned offset restarts at the first
    // window (ids 21..25 present); a stale offset would start mid-set.
    runtimes.push(runtime);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => {
      expect(view).toHaveBeenCalledTimes(2 * AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    });
    // Tick 3 re-views the first window, already 'open' from tick 1, so it
    // commits nothing and the catalog notification does not refire — wait on
    // the view count and let the tick's synchronous tail settle instead of
    // sweepDone.
    await vi.advanceTimersByTimeAsync(10);
    perTickViews.push(current);

    const readded = new Set(perTickViews[1]);
    expect(readded.size).toBe(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    for (const id of [21, 22, 23, 24, 25]) {
      expect(readded.has(id)).toBe(true);
    }
    handle?.dispose();
  });

  it('advances the rotation by the consumed count when the budget truncates', async () => {
    // R1-4 witness: the timer must advance the offset by however many views
    // the sweep actually STARTED (aoneConsumed), not the fixed cap. Each
    // fake view hangs for the full per-call timeout against the injected
    // clock, so the 60s budget truncates the window well below the cap; the
    // next sweep must then begin at the truncation point. Mutant
    // `sweepStart + AONE_MAX_MR_VIEW_CALLS_PER_RUN` would start the second
    // window cap positions ahead and leave the truncated tail unviewed.
    const total = 30;
    const runtime = timerRuntime('aone', trustedCwd, true);
    await seedAoneTimerWorkspace(runtime, total);
    const perTickViews: number[][] = [];
    let current: number[] = [];
    let clock = 0;
    const view = vi.fn(async (_repoPath: string, id: number) => {
      current.push(id);
      clock += 20_000; // each view burns the per-call timeout
      return {
        number: id,
        url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
        state: 'open' as const,
      };
    });
    const backend: AoneMrBackend = { list: vi.fn(async () => []), view };
    const registry = {
      listAll: () => [runtime],
    } as unknown as WorkspaceRegistry;
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: {},
      aoneBackend: backend,
      now: () => clock,
    });

    // Tick 1: budget admits far fewer views than the cap.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(view.mock.calls.length).toBeGreaterThan(0);
      expect(view.mock.calls.length).toBeLessThan(
        AONE_MAX_MR_VIEW_CALLS_PER_RUN,
      );
    });
    await sweepDone(runtime, 1);
    const consumed = current.length;
    expect(consumed).toBeLessThan(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    perTickViews.push(current);
    current = [];

    // Tick 2: must begin at the truncation point, not cap positions ahead.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => {
      expect(view.mock.calls.length).toBeGreaterThan(consumed);
    });
    await sweepDone(runtime, 2);
    perTickViews.push(current);

    // Pending numbers are the consecutive 1..30, so the window that begins
    // at the truncation offset picks up exactly where tick 1's window left
    // off. A cap-advance mutant would start the second window cap positions
    // ahead and leave a gap.
    expect(perTickViews[1][0]).toBe(
      perTickViews[0][perTickViews[0].length - 1] + 1,
    );
    handle?.dispose();
  });

  it('keeps the offset unmoved when a sweep throws, retrying the window', async () => {
    // R4-4 witness: a workspace whose sweep throws (non-draining) must keep
    // its offset so the next tick retries the same window. Mutant "advance
    // the offset in the catch / move the write into finally" would skip the
    // failed window. Tick 1 views window 1; tick 2 throws (generation guard
    // closed); tick 3 must start where tick 1 left off (offset 25), not cap
    // positions further ahead.
    const total = 30;
    const runtime = timerRuntime('aone', trustedCwd, true);
    await seedAoneTimerWorkspace(runtime, total);
    const perTickViews: number[][] = [];
    let current: number[] = [];
    const view = vi.fn(async (_repoPath: string, id: number) => {
      current.push(id);
      return {
        number: id,
        url: `https://code.alibaba-inc.com/jspt/agentic_coding/codereview/${id}`,
        state: 'open' as const,
      };
    });
    const backend: AoneMrBackend = { list: vi.fn(async () => []), view };
    const registry = {
      listAll: () => [runtime],
    } as unknown as WorkspaceRegistry;
    vi.useFakeTimers();

    const handle = startSessionPrRefreshTimer({
      workspaceRegistry: registry,
      env: {},
      aoneBackend: backend,
    });

    // Tick 1: window 1 viewed, offset advances to 25.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    });
    await sweepDone(runtime, 1);
    perTickViews.push(current);
    current = [];

    // Tick 2: guard closed → sweep throws non-draining → offset must NOT
    // advance. No new views fire. The guard assert sits AFTER the sweep's
    // real-fs sidecar scan, so wait on the assert itself — a spy on the
    // test-owned closed guard — before concluding the tick threw: asserting
    // the view count alone races the scan, and the guard can be re-opened
    // before the sweep reaches the assert, so no throw ever happens.
    const closedGuard = attachTimerGuard(runtime);
    closedGuard.close();
    const assertOpen = vi.spyOn(closedGuard, 'assertOpen');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(
      () => {
        expect(assertOpen).toHaveBeenCalled();
      },
      { timeout: 30_000 },
    );
    expect(view).toHaveBeenCalledTimes(AONE_MAX_MR_VIEW_CALLS_PER_RUN);

    // Tick 3: guard re-opened → sweep retries the window tick 1 left off at
    // (offset 25), not the window a cap-advance would have jumped to.
    attachTimerGuard(runtime);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => {
      expect(view).toHaveBeenCalledTimes(2 * AONE_MAX_MR_VIEW_CALLS_PER_RUN);
    });
    await sweepDone(runtime, 2);
    perTickViews.push(current);

    // Offset stayed put across the thrown tick: tick 3's window picks up
    // exactly where tick 1's left off (pending numbers are the consecutive
    // 1..30). A cap-advance mutant would have jumped the window cap
    // positions ahead on the thrown tick.
    expect(perTickViews[1][0]).toBe(
      perTickViews[0][perTickViews[0].length - 1] + 1,
    );
    handle?.dispose();
  });
});
