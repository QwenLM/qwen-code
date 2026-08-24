/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
  writeSessionPrs,
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

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  fetchGitHubPullRequests: vi.fn(),
  fetchRemoteWebUrl: vi.fn(),
}));

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
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
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

  it('recovers PRs created via gh pr create in the session shell', async () => {
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
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

  it('does not recover a transcript URL from another repository', async () => {
    fetchRemoteWebUrlMock.mockResolvedValue('https://github.com/o/r');
    const sessionId = '00000000-0000-4000-8000-000000000009';
    await seedSession(sessionId);
    const chatsDir = path.join(
      new Storage(workspaceCwd).getProjectDir(),
      'chats',
    );
    await fsp.appendFile(
      path.join(chatsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
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
                args: { command: 'gh pr create --title x' },
              },
            },
          ],
        },
        cwd: workspaceCwd,
      })}\n${JSON.stringify({
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
                  output: 'https://github.com/evil/other/pull/5\n',
                },
              },
            },
          ],
        },
        cwd: workspaceCwd,
      })}\n`,
      'utf8',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'not_a_repo' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 0 });
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

  it('moves a gh-create number past weaker reviewed duplicates', async () => {
    await seedSession(SESSION_A);
    for (const n of [5, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11]) {
      await appendUserText(SESSION_A, `/review ${n}`);
    }
    await appendShellCommand(
      SESSION_A,
      'gh pr create --title x --body y',
      'https://github.com/o/r/pull/5\n',
    );
    // Negative control: a non-create gh command printing the workspace's
    // own PR URL must not bind at gh-create authority.
    await appendShellCommand(
      SESSION_A,
      'gh pr view 98 --json url -q .url',
      'https://github.com/o/r/pull/98\n',
    );
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    // 11 candidates, tail-10 cap: only the 10 persisted bindings count.
    expect(result.bound).toBe(10);
    const prs = await readSessionPrs(
      sessionService.getPrSessionPathForArchiveState(SESSION_A, 'active'),
    );
    // The created PR outranks the reviewed tier, so it sits at the tail and
    // survives the sidecar's cap instead of being evicted from the head.
    expect(prs?.map((p) => p.number)).toEqual([2, 3, 4, 6, 7, 8, 9, 10, 11, 5]);
  });

  it("keeps the run's new bindings under the sidecar tail cap", async () => {
    // Seeded at 8 so the 3 new bindings overflow the cap: the single
    // capped write must keep every new binding (evicting the oldest seeded
    // entry) instead of cascading re-upserts that drop the new ones, and
    // survivors keep their binding-time createdAt.
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
      })),
    );
    await seedSession(SESSION_A);
    await seedWorktreeSidecar(SESSION_A, 'pr-101', 'worktree-pr-101');
    await appendUserText(SESSION_A, '/review 102');
    await appendUserText(SESSION_A, '/review 103');
    fetchGitHubPullRequestsMock.mockResolvedValue({ kind: 'cli_unavailable' });

    const result = await backfillWorkspaceSessionPrs(runtime);

    expect(result).toMatchObject({ bound: 3, alreadyBound: 0 });
    const final = await readSessionPrs(prPath);
    expect(final?.map((p) => p.number)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 102, 103, 101,
    ]);
    expect(final?.[0]?.createdAt).toBe('2026-08-01T00:00:01.000Z');
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
      expect(first.body.bound).toBe(1);
      expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);

      // Second run binds nothing new: no catalog bump.
      const second = await request(app).post('/sessions/backfill-prs');
      expect(second.status).toBe(200);
      expect(second.body.bound).toBe(0);
      expect(markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    } finally {
      await fsp.rm(workCwd, { recursive: true, force: true });
      await fsp.rm(runtimeBase, { recursive: true, force: true });
    }
  });
});
