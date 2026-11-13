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
import { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import {
  autofixPrPaths,
  type AutofixPrState,
} from '../../commands/autofix-pr/state.js';
import {
  SessionArchivedError,
  SessionArchivingError,
  SessionNotFoundError,
} from '../acp-session-bridge.js';
import {
  WorktreeMarkerMissingError,
  WorktreeResetInterruptedError,
  WorktreeSessionSupersededError,
} from './worktree-reset-errors.js';
import {
  createWorkspaceGenerationGuard,
  WorkspaceGenerationClosedError,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { SessionRestoreResult } from './session-restore.js';
import {
  DaemonDrainingError,
  SessionArchiveCoordinator,
} from './session-archive.js';
import type { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';

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
      // Present so "release does not kill" is a real assertion: against a
      // bridge that never had the method, `toBeUndefined()` holds no matter
      // what the code does.
      killSession: vi.fn(async () => {}),
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
  // A real coordinator: the admission envelope's shared hold and its
  // shutdown seal are the behaviour under test, so a stub would prove nothing.
  let coordinator: SessionArchiveCoordinator;
  let restore: ReturnType<
    typeof vi.fn<(input: unknown) => Promise<SessionRestoreResult>>
  >;

  beforeEach(async () => {
    vi.clearAllMocks();
    coordinator = new SessionArchiveCoordinator();
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
      activity?: ConversationRuntimeActivityGate;
    } = {},
  ) {
    const runtimes = overrides.runtimes ?? [runtime()];
    return createPrWatchDeps({
      workspaceRegistry: { listAll: () => runtimes } as never,
      archiveCoordinator: () =>
        overrides.withCoordinator === false ? undefined : coordinator,
      conversationRuntimeActivity: () => overrides.activity,
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

  it('reuses an injected lock registry across both seams', () => {
    // A rebuild after the hosted channels change must keep the registry, or a
    // channel committing between the observation's and the drain's read hands
    // them different in-process locks for the same files.
    const locks = new PathMutexRegistry();
    const { watch, drain } = createPrWatchDeps({
      workspaceRegistry: { listAll: () => [runtime()] } as never,
      archiveCoordinator: () => coordinator,
      restore: restore as never,
      hostedChannelBaseUrls: () => [],
      locks,
    });
    expect(watch.locks).toBe(locks);
    expect(drain.locks).toBe(locks);
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

  it('maps every Gone restore error to gone and any other to unavailable', async () => {
    const { drain } = build();
    // One cell per class isGone lists. A class missing from that predicate
    // would leave a permanently-gone recipient retried on every tick.
    const goneErrors = [
      new SessionNotFoundError(SESSION),
      new SessionArchivedError(SESSION),
      new WorktreeSessionSupersededError(SESSION, 'replacement'),
      new WorktreeMarkerMissingError(SESSION),
      new WorktreeResetInterruptedError(SESSION),
    ];
    // Collected and compared as one array so a failure names the class that
    // regressed, without a second expect argument.
    const outcomes: Array<{ name: string; kind: string }> = [];
    for (const error of goneErrors) {
      restore.mockRejectedValueOnce(error);
      const outcome = await drain.wakeSession(SESSION, CWD);
      outcomes.push({ name: error.name, kind: outcome.kind });
    }
    expect(outcomes).toEqual(
      goneErrors.map((error) => ({ name: error.name, kind: 'gone' })),
    );
    // Deliberately not Gone: another process holds the writer now and may
    // release it, so the drain retries instead of excluding the recipient.
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
    expect(target.bridge.killSession).not.toHaveBeenCalled();
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

  it('holds the coordinator shared lock across the admission', async () => {
    // The archive lane is refused only while a shared holder exists, so
    // attempting it from inside the admission is the witness. Without the
    // envelope it succeeds: a concurrent archive kills the session and drops
    // the turn this admission enqueues, while the drain records it delivered.
    let attempt: Promise<{ ran?: string; refused?: unknown }> | undefined;
    admitSessionPromptMock.mockImplementation(() => {
      attempt = coordinator
        .runExclusiveMany([SESSION], async () => 'archived')
        .then(
          (ran) => ({ ran }),
          (refused: unknown) => ({ refused }),
        );
      return { deduplicated: false };
    });
    const { drain } = build();
    await drain.admitPrompt(runtime(), SESSION, 'text', 'key-1');
    expect(admitSessionPromptMock).toHaveBeenCalledTimes(1);
    expect((await attempt)?.refused).toBeInstanceOf(SessionArchivingError);
  });

  it('rejects a sealed coordinator so the entry stays pending', async () => {
    await coordinator.sealMaintenanceAndWait();
    const { drain } = build();
    await expect(
      drain.admitPrompt(runtime(), SESSION, 'text', 'key-1'),
    ).rejects.toBeInstanceOf(DaemonDrainingError);
    expect(admitSessionPromptMock).not.toHaveBeenCalled();
  });

  it('asserts the generation open before admitting', async () => {
    admitSessionPromptMock.mockReturnValue({ deduplicated: false });
    // The real guard, closed: a hand-built stub would only prove the mock
    // throws, not that a retired generation refuses the admission.
    const guard = createWorkspaceGenerationGuard();
    guard.close();
    const guarded = runtime({ generationGuard: guard });
    const { drain } = build({ runtimes: [guarded] });
    await expect(
      drain.admitPrompt(guarded, SESSION, 'text', 'key-1'),
    ).rejects.toBeInstanceOf(WorkspaceGenerationClosedError);
    expect(admitSessionPromptMock).not.toHaveBeenCalled();
  });

  it('runs an internal runtime admission through the activity gate', async () => {
    admitSessionPromptMock.mockReturnValue({ deduplicated: false });
    const gate = {
      run: vi.fn(async (task: () => Promise<unknown>) => task()),
    };
    const internal = runtime({
      provenance: 'live-conversation',
    } as Partial<WorkspaceRuntime>);
    const { drain } = build({
      runtimes: [internal],
      activity: gate as unknown as ConversationRuntimeActivityGate,
    });
    await drain.admitPrompt(internal, SESSION, 'text', 'key-1');
    expect(gate.run).toHaveBeenCalledTimes(1);
    // An ordinary workspace runtime is not gated, so the gate must not be
    // consulted for it — otherwise every admission would need a conversations
    // gate this daemon may never have built.
    const plain = runtime();
    await drain.admitPrompt(plain, SESSION, 'text', 'key-2');
    expect(gate.run).toHaveBeenCalledTimes(1);
  });

  it('refuses an internal runtime admission with no activity gate', async () => {
    const internal = runtime({
      provenance: 'live-conversation',
    } as Partial<WorkspaceRuntime>);
    const { drain } = build({ runtimes: [internal] });
    await expect(
      drain.admitPrompt(internal, SESSION, 'text', 'key-1'),
    ).rejects.toThrow('no conversations runtime activity gate');
    expect(admitSessionPromptMock).not.toHaveBeenCalled();
  });

  it('refuses an untrusted non-primary recipient on every seam', async () => {
    // Trust revocation makes the tick partial, and a partial tick keeps the
    // retained rows — so the recipient can still arrive here after the
    // workspace stopped being observable.
    const untrusted = runtime({ primary: false, trusted: false });
    const { drain } = build({ runtimes: [untrusted] });
    expect(drain.resolveRuntime(CWD)).toBeUndefined();
    expect(await drain.wakeSession(SESSION, CWD)).toEqual({
      kind: 'unavailable',
    });
    expect(restore).not.toHaveBeenCalled();
    expect(
      await drain.readPushedHeads({
        sessionId: SESSION,
        workspaceCwd: CWD,
        url: URL,
      }),
    ).toBeUndefined();
    expect(cloneWorktreesOfMock).not.toHaveBeenCalled();
  });

  it('keeps the primary exempt from the recipient trust gate', async () => {
    const primary = runtime({ primary: true, trusted: false });
    const { drain } = build({ runtimes: [primary] });
    expect(drain.resolveRuntime(CWD)).toBe(primary);
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
