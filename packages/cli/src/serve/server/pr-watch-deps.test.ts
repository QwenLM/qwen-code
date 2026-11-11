/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const readGhConfiguredHostsMock = vi.hoisted(() => vi.fn());
const scanWorkspaceBindingsMock = vi.hoisted(() => vi.fn());
const admitSessionPromptMock = vi.hoisted(() => vi.fn());
const cloneWorktreesOfMock = vi.hoisted(() => vi.fn());

vi.mock('./pr-watch-gh-hosts.js', () => ({
  readGhConfiguredHosts: readGhConfiguredHostsMock,
}));
vi.mock('../routes/session-pr-bindings.js', () => ({
  scanWorkspaceBindings: scanWorkspaceBindingsMock,
}));
vi.mock('../routes/session-prompt-admission.js', () => ({
  admitSessionPrompt: admitSessionPromptMock,
}));
vi.mock('../routes/autofix-pr-watches.js', () => ({
  cloneWorktreesOf: cloneWorktreesOfMock,
}));

import { createPrWatchDeps } from './pr-watch-deps.js';
import {
  autofixPrPaths,
  type AutofixPrState,
} from '../../commands/autofix-pr/state.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import { WorktreeMarkerMissingError } from './worktree-reset-errors.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import type { SessionRestoreResult } from './session-restore.js';
import type { SessionArchiveCoordinator } from './session-archive.js';

const CWD = '/ws';
const SESSION = 'session-1';
const URL = 'https://github.com/o/r/pull/42';

function runtime(overrides: Partial<WorkspaceRuntime> = {}): WorkspaceRuntime {
  return {
    workspaceCwd: CWD,
    workspaceId: 'ws',
    primary: false,
    trusted: true,
    bridge: {
      listWorkspaceSessions: vi.fn(() => []),
      detachClient: vi.fn(async () => {}),
    },
    ...overrides,
  } as unknown as WorkspaceRuntime;
}

function state(overrides: Partial<AutofixPrState> = {}): AutofixPrState {
  return {
    version: 1,
    sessionId: SESSION,
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    prNumber: 42,
    remote: 'origin',
    pushTarget: 'origin',
    headRefName: 'head',
    baseRefName: 'main',
    branch: 'b',
    worktreePath: '/wt',
    viewer: 'v',
    prAuthor: 'a',
    lastKnownHeadSha: 'a'.repeat(40),
    pushedShas: ['b'.repeat(40)],
    handledCommentIds: [],
    postedCommentIds: [],
    ...overrides,
  } as AutofixPrState;
}

describe('createPrWatchDeps', () => {
  let dir: string;
  const coordinator = {} as SessionArchiveCoordinator;
  let restore: ReturnType<
    typeof vi.fn<(input: unknown) => Promise<SessionRestoreResult>>
  >;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-watch-deps-'));
    readGhConfiguredHostsMock.mockReturnValue(new Set<string>());
    scanWorkspaceBindingsMock.mockResolvedValue(false);
    cloneWorktreesOfMock.mockResolvedValue([]);
    restore = vi.fn(
      async () => ({ kind: 'cancelled' }) as SessionRestoreResult,
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function build(
    overrides: {
      runtimes?: WorkspaceRuntime[];
      hosted?: readonly unknown[];
      withCoordinator?: boolean;
    } = {},
  ) {
    const runtimes = overrides.runtimes ?? [runtime()];
    return createPrWatchDeps({
      workspaceRegistry: { listAll: () => runtimes } as never,
      archiveCoordinator: () =>
        overrides.withCoordinator === false ? undefined : coordinator,
      restore: restore as never,
      hostedChannelBaseUrls: () => overrides.hosted ?? [],
    });
  }

  it('always allows github.com and adds the gh hosts and hosted origins', () => {
    readGhConfiguredHostsMock.mockReturnValue(new Set(['ghe.example.com']));
    const { watch } = build({ hosted: ['https://api.acme.ghe.com'] });
    // The bare hostname, not the origin URL: the watch identity carries no
    // scheme and no port, so an origin-shaped entry would never match.
    expect(watch.allowedHosts.has('https://acme.ghe.com')).toBe(false);
    expect([...watch.allowedHosts].sort()).toEqual([
      'acme.ghe.com',
      'ghe.example.com',
      'github.com',
    ]);
  });

  it('shares one watch directory and lock registry between both seams', () => {
    const { watch, drain } = build();
    expect(drain.watchDir).toBe(watch.watchDir);
    expect(drain.locks).toBe(watch.locks);
  });

  it('reports a session live only when the bridge lists it', () => {
    const live = runtime();
    const { drain } = build({ runtimes: [live] });
    expect(drain.isSessionLive(live, SESSION)).toBe(false);
    (
      live.bridge.listWorkspaceSessions as ReturnType<typeof vi.fn>
    ).mockReturnValue([{ sessionId: SESSION }]);
    expect(drain.isSessionLive(live, SESSION)).toBe(true);
  });

  it('treats an unreadable live list as not live rather than throwing', () => {
    const broken = runtime();
    (
      broken.bridge.listWorkspaceSessions as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      throw new Error('bridge down');
    });
    const { drain } = build({ runtimes: [broken] });
    expect(drain.isSessionLive(broken, SESSION)).toBe(false);
  });

  it('carries the shared scan bindings and its partial flag', async () => {
    const rows = [{ sessionId: SESSION, workspaceCwd: CWD, prs: [] }];
    scanWorkspaceBindingsMock.mockImplementation(async (_rt, out) => {
      out.push(...rows);
      return true;
    });
    const { drain } = build();
    const result = await drain.scanBindings(runtime());
    expect(result.bindings).toEqual(rows);
    expect(result.partial).toBe(true);
  });

  it('maps a Gone restore error to gone and any other to unavailable', async () => {
    const { drain } = build();
    restore.mockRejectedValueOnce(new SessionNotFoundError(SESSION));
    expect(await drain.wakeSession(SESSION, CWD)).toEqual({ kind: 'gone' });
    restore.mockRejectedValueOnce(new WorktreeMarkerMissingError(SESSION));
    expect(await drain.wakeSession(SESSION, CWD)).toEqual({ kind: 'gone' });
    restore.mockRejectedValueOnce(new Error('session_writer_conflict'));
    expect(await drain.wakeSession(SESSION, CWD)).toEqual({
      kind: 'unavailable',
    });
  });

  it('is unavailable without a runtime or a coordinator', async () => {
    const { drain } = build({ runtimes: [] });
    expect(await drain.wakeSession(SESSION, CWD)).toEqual({
      kind: 'unavailable',
    });
    const noCoordinator = build({ withCoordinator: false });
    expect(await noCoordinator.drain.wakeSession(SESSION, CWD)).toEqual({
      kind: 'unavailable',
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it('releases the client the restore minted, without killing the session', async () => {
    const target = runtime();
    const { drain } = build({ runtimes: [target] });
    restore.mockResolvedValueOnce({
      kind: 'restored',
      session: { sessionId: SESSION, clientId: 'client-1' },
    } as unknown as SessionRestoreResult);
    const outcome = await drain.wakeSession(SESSION, CWD);
    expect(outcome.kind).toBe('restored');
    if (outcome.kind !== 'restored') throw new Error('unreachable');
    expect(target.bridge.detachClient).not.toHaveBeenCalled();
    await outcome.release();
    // Detach only: killing would drop the turn the drain just admitted.
    expect(target.bridge.detachClient).toHaveBeenCalledWith(
      SESSION,
      'client-1',
    );
    expect(
      (target.bridge as unknown as { killSession?: unknown }).killSession,
    ).toBeUndefined();
  });

  it('admits relayed text as a channel turn so no binding backfill runs', async () => {
    admitSessionPromptMock.mockReturnValue({ deduplicated: false });
    const { drain } = build();
    const result = await drain.admitPrompt(runtime(), SESSION, 'text', 'key-1');
    expect(result).toEqual({ deduplicated: false });
    const [, input] = admitSessionPromptMock.mock.calls[0] as [
      unknown,
      { classification: Record<string, unknown>; idempotencyKey: string },
    ];
    expect(input.classification).toEqual({
      channelPrompt: true,
      requestedChannelPrompt: true,
    });
    expect(input.idempotencyKey).toBe('key-1');
  });

  describe('readPushedHeads', () => {
    const recipient = { sessionId: SESSION, workspaceCwd: CWD, url: URL };

    async function seedState(
      root: string,
      overrides: Partial<AutofixPrState> = {},
    ): Promise<void> {
      const paths = autofixPrPaths(root, 42);
      await fs.mkdir(path.dirname(paths.statePath), { recursive: true });
      await fs.writeFile(
        paths.statePath,
        JSON.stringify(state(overrides)),
        'utf8',
      );
    }

    it('returns the pushed shas of a matching watch', async () => {
      const root = path.join(dir, 'clone');
      await fs.mkdir(root, { recursive: true });
      await seedState(root);
      cloneWorktreesOfMock.mockResolvedValue([root]);
      const { drain } = build();
      const ledger = await drain.readPushedHeads(recipient);
      expect(ledger).toEqual(new Set(['b'.repeat(40)]));
    });

    it('refuses a watch owned by another session', async () => {
      const root = path.join(dir, 'clone');
      await fs.mkdir(root, { recursive: true });
      await seedState(root, { sessionId: 'someone-else' });
      cloneWorktreesOfMock.mockResolvedValue([root]);
      const { drain } = build();
      expect(await drain.readPushedHeads(recipient)).toBeUndefined();
    });

    it('refuses a watch for another repository', async () => {
      const root = path.join(dir, 'clone');
      await fs.mkdir(root, { recursive: true });
      await seedState(root, { repo: 'other' });
      cloneWorktreesOfMock.mockResolvedValue([root]);
      const { drain } = build();
      expect(await drain.readPushedHeads(recipient)).toBeUndefined();
    });

    it('runs no git in an untrusted primary checkout', async () => {
      const untrusted = runtime({ primary: true, trusted: false });
      const { drain } = build({ runtimes: [untrusted] });
      expect(await drain.readPushedHeads(recipient)).toBeUndefined();
      expect(cloneWorktreesOfMock).not.toHaveBeenCalled();
    });

    it('delivers when the clone cannot be enumerated', async () => {
      cloneWorktreesOfMock.mockRejectedValue(new Error('git failed'));
      const { drain } = build();
      expect(await drain.readPushedHeads(recipient)).toBeUndefined();
    });
  });
});
