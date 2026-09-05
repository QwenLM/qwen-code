import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import { NamedSessionManager } from './named-session-manager.js';
import { canonicalizeWorkspacePath } from './paths.js';
import { readDaemonHttpErrorCode, SessionRouter } from './SessionRouter.js';

function createBridge(): ChannelAgentBridge {
  let nextId = 0;
  const live = new Map<
    string,
    {
      workspaceCwd: string;
      worktree?: { slug: string; path: string; branch: string };
      worktreeState?: 'persisted-v1';
    }
  >();
  const known = new Map(live);
  return {
    availableCommands: [],
    on: vi.fn(),
    off: vi.fn(),
    newSession: vi.fn(async (workspaceCwd: string, options) => {
      const sessionId = `session-${++nextId}`;
      const info = options?.worktree
        ? {
            workspaceCwd,
            worktree: {
              slug: sessionId,
              path: `/worktrees/${sessionId}`,
              branch: sessionId,
            },
            worktreeState: 'persisted-v1',
          }
        : { workspaceCwd };
      live.set(sessionId, info);
      known.set(sessionId, info);
      return sessionId;
    }),
    loadSession: vi.fn(async (sessionId: string, workspaceCwd: string) => {
      live.set(
        sessionId,
        live.get(sessionId) ?? known.get(sessionId) ?? { workspaceCwd },
      );
      return sessionId;
    }),
    resetWorktreeSession: vi.fn(
      async (sessionId: string, workspaceCwd: string) => {
        // The daemon transfers the checkout: the replacement session owns the
        // SAME worktree path, and the superseded session leaves the live set.
        const previous = known.get(sessionId);
        const replacementId = `session-${++nextId}`;
        const info = previous?.worktree
          ? {
              workspaceCwd,
              worktree: { ...previous.worktree },
              worktreeState: 'persisted-v1' as const,
            }
          : { workspaceCwd };
        live.set(replacementId, info);
        known.set(replacementId, info);
        live.delete(sessionId);
        return replacementId;
      },
    ),
    prompt: vi.fn().mockResolvedValue(''),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    discardSession: vi.fn(async (sessionId: string) => {
      live.delete(sessionId);
    }),
    listSessions: vi.fn(() =>
      [...live].map(([sessionId, info]) => ({
        sessionId,
        ...info,
        hasActivePrompt: false,
      })),
    ),
  };
}

/** A daemon conflict error by shape (channels/base keeps no SDK dependency). */
function daemonError(
  code: string,
  extraBody: Record<string, unknown> = {},
): Error {
  const error = new Error(`daemon rejected with ${code}`);
  error.name = 'DaemonHttpError';
  Object.assign(error, { status: 409, body: { code, ...extraBody } });
  return error;
}

const alice = {
  senderId: 'alice',
  chatId: 'group-1',
  threadId: 'topic-1',
  isGroup: true,
};

describe('NamedSessionManager', () => {
  let dir: string;
  let bridge: ChannelAgentBridge;
  let router: SessionRouter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-named-sessions-'));
    bridge = createBridge();
    router = new SessionRouter(bridge, '/workspace', 'user', undefined, {
      recoveryMode: 'lazy',
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function manager(isBusy = vi.fn().mockReturnValue(false)) {
    return new NamedSessionManager({
      channelName: 'channel-a',
      cwd: '/workspace',
      filePath: join(dir, 'named-sessions.json'),
      router,
      isBusy,
      now: () => 1_000,
    });
  }

  /**
   * Restart harness for superseded-redirect tests: a fresh bridge whose daemon
   * "moved" the checkout of `oldSessionId` to session-2 (loading the old id
   * fails with the typed conflict), plus a fresh router and manager on the
   * same registry file so nothing is live yet.
   */
  function supersededRestart(filePath: string, oldSessionId: string) {
    const restartedBridge = createBridge();
    vi.mocked(restartedBridge.loadSession).mockImplementation(
      async (sessionId: string) => {
        if (sessionId === oldSessionId) {
          throw daemonError('worktree_session_superseded', {
            replacementSessionId: 'session-2',
          });
        }
        return sessionId;
      },
    );
    vi.mocked(restartedBridge.listSessions).mockReturnValue([
      {
        sessionId: 'session-2',
        workspaceCwd: '/workspace',
        hasActivePrompt: false,
        worktree: {
          slug: 'feature',
          path: `/worktrees/${oldSessionId}`,
          branch: 'feature',
        },
        worktreeState: 'persisted-v1',
      },
    ]);
    const restartedRouter = new SessionRouter(
      restartedBridge,
      '/workspace',
      'user',
      undefined,
      { recoveryMode: 'lazy' },
    );
    const restartedManager = new NamedSessionManager({
      channelName: 'channel-a',
      cwd: '/workspace',
      filePath,
      router: restartedRouter,
      isBusy: () => false,
    });
    return {
      bridge: restartedBridge,
      router: restartedRouter,
      manager: restartedManager,
    };
  }

  it('adopts the existing route as default without changing its session', async () => {
    const legacyId = await router.resolve(
      'channel-a',
      alice.senderId,
      alice.chatId,
      alice.threadId,
      '/workspace',
      true,
    );
    const named = manager();

    await expect(named.list(alice, false)).resolves.toEqual([
      expect.objectContaining({
        name: 'default',
        active: true,
        status: 'open',
      }),
    ]);
    expect(router.getSession('channel-a', 'alice', 'group-1')).toBe(legacyId);
    expect(bridge.loadSession).not.toHaveBeenCalled();
  });

  it('indexes open and closed tasks and returns copied targets', async () => {
    const named = manager();
    const review = await named.create(alice, 'review');
    const feature = await named.create(alice, 'feature');
    await named.close(alice, 'review');

    const closed = named.presentation(review.sessionId);
    expect(closed).toEqual({
      taskName: 'review',
      status: 'closed',
      target: expect.objectContaining(alice),
    });
    expect(named.presentation(feature.sessionId)).toEqual({
      taskName: 'feature',
      status: 'open',
      target: expect.objectContaining(alice),
    });

    closed!.target.chatId = 'mutated';
    expect(named.presentation(review.sessionId)?.target.chatId).toBe(
      alice.chatId,
    );

    const restarted = manager();
    expect(restarted.presentation(review.sessionId)?.status).toBe('closed');
    expect(restarted.presentation(feature.sessionId)?.status).toBe('open');
  });

  it('bootstraps presentation only from the exact selected legacy route', async () => {
    const legacyId = await router.resolve(
      'channel-a',
      alice.senderId,
      alice.chatId,
      alice.threadId,
      '/workspace',
      true,
    );
    const named = manager();

    await expect(named.resolvePresentation(legacyId)).resolves.toEqual({
      taskName: 'default',
      status: 'open',
      target: expect.objectContaining(alice),
    });
    expect(named.presentation(legacyId)).toEqual(
      expect.objectContaining({ taskName: 'default' }),
    );
    expect(bridge.newSession).toHaveBeenCalledTimes(1);
    expect(bridge.loadSession).not.toHaveBeenCalled();
  });

  it('does not bootstrap unknown, stale-workspace, or cataloged-owner routes', async () => {
    const named = manager();
    await expect(named.resolvePresentation('missing')).resolves.toBeUndefined();

    const staleId = await router.createManagedSession(
      { channelName: 'channel-a', ...alice },
      '/other-workspace',
    );
    router.activateManagedSession(
      staleId,
      { channelName: 'channel-a', ...alice },
      '/other-workspace',
    );
    await expect(named.resolvePresentation(staleId)).resolves.toBeUndefined();

    const review = await named.create(alice, 'review');
    const extraId = await router.createManagedSession(
      { channelName: 'channel-a', ...alice },
      '/workspace',
    );
    router.activateManagedSession(
      extraId,
      { channelName: 'channel-a', ...alice },
      '/workspace',
    );
    await expect(named.resolvePresentation(extraId)).resolves.toBeUndefined();
    expect(named.presentation(review.sessionId)?.taskName).toBe('review');
    await expect(named.list(alice, true)).resolves.toHaveLength(1);
  });

  it('forgets a legacy route outside the channel workspace', async () => {
    const legacyId = await router.createManagedSession(
      {
        channelName: 'channel-a',
        senderId: alice.senderId,
        chatId: alice.chatId,
      },
      '/other-workspace',
    );
    router.activateManagedSession(
      legacyId,
      {
        channelName: 'channel-a',
        senderId: alice.senderId,
        chatId: alice.chatId,
      },
      '/other-workspace',
    );

    const named = manager();
    await expect(named.list(alice, false)).resolves.toEqual([]);
    expect(bridge.discardSession).toHaveBeenCalledWith(legacyId);
    expect(router.getSession('channel-a', 'alice', 'group-1')).toBeUndefined();

    const freshSessionId = await named.resolve(alice);
    expect(freshSessionId).not.toBe(legacyId);
    expect(router.getSessionCwd(freshSessionId!)).toBe('/workspace');
  });

  it('continues after stale-route discard fails', async () => {
    const legacyId = await router.createManagedSession(
      {
        channelName: 'channel-a',
        senderId: alice.senderId,
        chatId: alice.chatId,
      },
      '/other-workspace',
    );
    router.activateManagedSession(
      legacyId,
      {
        channelName: 'channel-a',
        senderId: alice.senderId,
        chatId: alice.chatId,
      },
      '/other-workspace',
    );
    vi.mocked(bridge.discardSession).mockRejectedValueOnce(
      new Error('daemon IPC error'),
    );

    const named = manager();
    const freshSessionId = await named.resolve(alice);
    expect(freshSessionId).not.toBe(legacyId);
    expect(router.getSessionCwd(freshSessionId!)).toBe('/workspace');
  });

  it('does not adopt a legacy route owned by a colliding sender and chat', async () => {
    const first = { senderId: 'alice:x', chatId: 'group' };
    const colliding = { senderId: 'alice', chatId: 'x:group' };
    const firstSessionId = await router.resolve(
      'channel-a',
      first.senderId,
      first.chatId,
      undefined,
      '/workspace',
    );
    const named = manager();
    await expect(named.list(first, false)).resolves.toEqual([
      expect.objectContaining({ name: 'default' }),
    ]);

    const created = await named.create(colliding, 'review');

    expect(created.sessionId).not.toBe(firstSessionId);
    await expect(named.list(first, false)).resolves.toEqual([
      expect.objectContaining({ name: 'default' }),
    ]);
    await expect(named.list(colliding, false)).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
    ]);
  });

  it('forgets a colliding route that conflicts with its true owner catalog', async () => {
    const first = { senderId: 'alice:x', chatId: 'group' };
    const colliding = { senderId: 'alice', chatId: 'x:group' };
    const named = manager();
    const firstTask = await named.create(first, 'review');
    const staleSessionId = await router.createManagedSession(
      { channelName: 'channel-a', ...first },
      '/workspace',
    );

    const collidingSessionId = await named.resolve(colliding);

    expect(collidingSessionId).not.toBe(staleSessionId);
    await expect(named.list(colliding, false)).resolves.toEqual([
      expect.objectContaining({ name: 'default', active: true }),
    ]);
    await expect(named.resolve(first)).resolves.toBe(firstTask.sessionId);
  });

  it('forgets a colliding route from another workspace', async () => {
    const first = { senderId: 'alice:x', chatId: 'group' };
    const colliding = { senderId: 'alice', chatId: 'x:group' };
    const staleSessionId = await router.createManagedSession(
      { channelName: 'channel-a', ...first },
      '/other-workspace',
    );
    const named = manager();

    const collidingSessionId = await named.resolve(colliding);

    expect(collidingSessionId).not.toBe(staleSessionId);
    await expect(named.list(colliding, false)).resolves.toEqual([
      expect.objectContaining({ name: 'default', active: true }),
    ]);
  });

  it('preserves an unvisited foreign legacy route before a colliding owner creates a task', async () => {
    const first = { senderId: 'alice:x', chatId: 'group' };
    const colliding = { senderId: 'alice', chatId: 'x:group' };
    const firstSessionId = await router.resolve(
      'channel-a',
      first.senderId,
      first.chatId,
      undefined,
      '/workspace',
    );
    const named = manager();

    const created = await named.create(colliding, 'review');

    expect(created.sessionId).not.toBe(firstSessionId);
    await expect(named.current(first)).resolves.toEqual(
      expect.objectContaining({
        name: 'default',
        sessionId: firstSessionId,
      }),
    );
    await expect(named.resolve(first)).resolves.toBe(firstSessionId);
  });

  it('isolates catalogs by sender and treats names case-insensitively', async () => {
    const named = manager();
    await named.create(alice, 'Review');
    await expect(named.create(alice, 'review')).rejects.toThrow(
      'already exists',
    );

    const bob = { ...alice, senderId: 'bob' };
    await expect(named.create(bob, 'review')).resolves.toEqual(
      expect.objectContaining({ name: 'review', active: true }),
    );
    await expect(named.list(alice, false)).resolves.toEqual([
      expect.objectContaining({ name: 'Review' }),
    ]);
    await expect(named.list(bob, false)).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
    ]);
  });

  it('reloads a reserved task without changing the current selection', async () => {
    const named = manager();
    const review = await named.create(alice, 'review');
    const feature = await named.create(alice, 'feature');
    await named.use(alice, 'review');
    vi.mocked(bridge.loadSession).mockClear();

    await expect(named.resumeReserved(alice, feature.sessionId)).resolves.toBe(
      feature.sessionId,
    );

    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({
        name: 'review',
        sessionId: review.sessionId,
      }),
    );
    expect(router.getSession('channel-a', 'alice', 'group-1')).toBe(
      review.sessionId,
    );
    expect(bridge.loadSession).not.toHaveBeenCalled();
  });

  it('fails closed when a reserved task is foreign or unavailable', async () => {
    const named = manager();
    const review = await named.create(alice, 'review');

    await expect(
      named.resumeReserved({ ...alice, senderId: 'bob' }, review.sessionId),
    ).resolves.toBeUndefined();
    await expect(named.close(alice, 'review')).resolves.toBeDefined();
    await expect(
      named.resumeReserved(alice, review.sessionId),
    ).resolves.toBeUndefined();
    expect(bridge.loadSession).not.toHaveBeenCalled();
  });

  it('caps each owner at eight open tasks', async () => {
    const named = manager();
    for (let index = 0; index < 8; index++) {
      await named.create(alice, `task-${index}`);
    }

    await expect(named.create(alice, 'task-8')).rejects.toThrow(
      'eight open tasks',
    );
  });

  it('allows creating and switching while named tasks are busy', async () => {
    const busy = vi.fn().mockReturnValue(false);
    const named = manager(busy);
    const first = await named.create(alice, 'first');
    const second = await named.create(alice, 'second');
    await named.use(alice, 'first');
    busy.mockReturnValue(true);

    await expect(named.use(alice, 'second')).resolves.toEqual(
      expect.objectContaining({ name: 'second', sessionId: second.sessionId }),
    );
    await expect(named.create(alice, 'third')).resolves.toEqual(
      expect.objectContaining({ name: 'third', active: true }),
    );
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it('looks up owned tasks without loading or changing selection', async () => {
    const named = manager();
    const review = await named.create(alice, 'Review');
    await named.create(alice, 'feature');
    vi.mocked(bridge.loadSession).mockClear();

    await expect(named.lookup(alice, 'review')).resolves.toEqual(
      expect.objectContaining({
        name: 'Review',
        sessionId: review.sessionId,
        active: false,
      }),
    );
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({ name: 'feature', active: true }),
    );
    await expect(
      named.lookup({ ...alice, senderId: 'bob' }, 'review'),
    ).resolves.toBeUndefined();
    expect(bridge.loadSession).not.toHaveBeenCalled();
  });

  it('rebinds an already live task without loading and replacing its client', async () => {
    const named = manager();
    await named.create(alice, 'first');
    await named.create(alice, 'second');
    vi.mocked(bridge.loadSession).mockClear();

    await named.use(alice, 'first');
    await named.use(alice, 'second');
    await named.use(alice, 'first');

    expect(bridge.loadSession).not.toHaveBeenCalled();
  });

  it('keeps the prior selection when an exact dormant load fails', async () => {
    const filePath = join(dir, 'named-sessions.json');
    const firstManager = manager();
    const first = await firstManager.create(alice, 'first');
    const second = await firstManager.create(alice, 'second');
    await firstManager.use(alice, 'first');

    const restartedBridge = createBridge();
    vi.mocked(restartedBridge.loadSession).mockRejectedValue(
      new Error('transcript unavailable'),
    );
    const restartedRouter = new SessionRouter(
      restartedBridge,
      '/workspace',
      'user',
      undefined,
      { recoveryMode: 'lazy' },
    );
    restartedRouter.activateManagedSession(
      first.sessionId,
      {
        channelName: 'channel-a',
        senderId: alice.senderId,
        chatId: alice.chatId,
        threadId: alice.threadId,
        isGroup: true,
      },
      '/workspace',
    );
    const restarted = new NamedSessionManager({
      channelName: 'channel-a',
      cwd: '/workspace',
      filePath,
      router: restartedRouter,
      isBusy: () => false,
    });

    await expect(restarted.use(alice, 'second')).rejects.toThrow(
      'The current task was not changed',
    );
    expect(restartedRouter.getSession('channel-a', 'alice', 'group-1')).toBe(
      first.sessionId,
    );
    await expect(restarted.current(alice)).resolves.toEqual(
      expect.objectContaining({ name: 'first' }),
    );
    expect(restartedBridge.newSession).not.toHaveBeenCalled();
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('rejects unsupported registry versions instead of resetting ownership', () => {
    writeFileSync(
      join(dir, 'named-sessions.json'),
      JSON.stringify({ version: 2, owners: [] }),
    );

    expect(() => manager()).toThrow('Invalid named-session registry');
  });

  it('archives the registry after the channel workspace changes', async () => {
    const named = manager();
    await named.create(alice, 'review');
    const filePath = join(dir, 'named-sessions.json');

    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const restarted = new NamedSessionManager({
        channelName: 'channel-a',
        cwd: '/other-workspace',
        filePath,
        router,
        isBusy: () => false,
      });
      await expect(restarted.list(alice, true)).resolves.toEqual([]);
      expect(readdirSync(dir)).toEqual([
        expect.stringMatching(/^named-sessions\.json\.stale-/u),
      ]);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('working directory changed'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('preserves tasks and legacy routes across equivalent workspace paths', async () => {
    const realWorkspace = join(dir, 'real-workspace');
    const linkedWorkspace = join(dir, 'linked-workspace');
    mkdirSync(realWorkspace);
    symlinkSync(
      realWorkspace,
      linkedWorkspace,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const filePath = join(dir, 'named-sessions.json');
    const firstManager = new NamedSessionManager({
      channelName: 'channel-a',
      cwd: linkedWorkspace,
      filePath,
      router,
      isBusy: () => false,
    });
    await firstManager.create(alice, 'review');
    const bob = { ...alice, senderId: 'bob' };
    const bobSessionId = await router.resolve(
      'channel-a',
      bob.senderId,
      bob.chatId,
      bob.threadId,
      linkedWorkspace,
      true,
    );
    vi.mocked(bridge.discardSession).mockClear();

    const restarted = new NamedSessionManager({
      channelName: 'channel-a',
      cwd: realWorkspace,
      filePath,
      router,
      isBusy: () => false,
    });

    await expect(restarted.list(alice, false)).resolves.toEqual([
      expect.objectContaining({ name: 'review', active: true }),
    ]);
    await expect(restarted.resolve(bob)).resolves.toBe(bobSessionId);
    expect(readdirSync(dir)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^named-sessions\.json\.stale-/u),
      ]),
    );
    expect(bridge.discardSession).not.toHaveBeenCalled();
  });

  it('serializes concurrent changes for one owner and leaves no temp files', async () => {
    const named = manager();

    await Promise.all([
      named.create(alice, 'review'),
      named.create(alice, 'feature-a'),
      named.create(alice, 'feature-b'),
    ]);

    await expect(named.list(alice, false)).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
      expect.objectContaining({ name: 'feature-a' }),
      expect.objectContaining({ name: 'feature-b', active: true }),
    ]);
    expect(readdirSync(dir)).toEqual(['named-sessions.json']);
  });

  it('detaches a newly created session when ownership persistence fails', async () => {
    const blockingFile = join(dir, 'not-a-directory');
    writeFileSync(blockingFile, 'block');
    const named = new NamedSessionManager({
      channelName: 'channel-a',
      cwd: '/workspace',
      filePath: join(blockingFile, 'named-sessions.json'),
      router,
      isBusy: () => false,
    });

    await expect(named.create(alice, 'review')).rejects.toThrow();
    expect(bridge.discardSession).toHaveBeenCalledWith('session-1');
    expect(router.getSession('channel-a', 'alice', 'group-1')).toBeUndefined();
  });

  it('publishes neither registry nor presentation index after a write failure', async () => {
    const registryDir = join(dir, 'registry');
    const named = new NamedSessionManager({
      channelName: 'channel-a',
      cwd: '/workspace',
      filePath: join(registryDir, 'named-sessions.json'),
      router,
      isBusy: () => false,
    });
    const review = await named.create(alice, 'review');
    rmSync(registryDir, { recursive: true, force: true });
    writeFileSync(registryDir, 'block');

    await expect(named.create(alice, 'feature')).rejects.toThrow(
      'Failed to persist',
    );
    expect(named.presentation(review.sessionId)?.taskName).toBe('review');
    await expect(named.list(alice, true)).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
    ]);
  });

  it('does not expose daemon session identifiers in creation errors', async () => {
    vi.mocked(bridge.newSession).mockRejectedValueOnce(
      new Error('session secret-session-id failed'),
    );

    const error = await manager()
      .create(alice, 'review')
      .catch((caught) =>
        caught instanceof Error ? caught : new Error(String(caught)),
      );

    expect(error.message).toBe('Could not create task "review".');
    expect(error.message).not.toContain('secret-session-id');
  });

  it('closes and reopens the exact session without exposing IDs in views', async () => {
    const named = manager();
    const review = await named.create(alice, 'review');
    await named.close(alice, 'review');

    await expect(named.list(alice, false)).resolves.toEqual([]);
    await expect(named.list(alice, true)).resolves.toEqual([
      {
        name: 'review',
        status: 'closed',
        isolation: 'shared',
        active: false,
      },
    ]);
    await named.use(alice, 'review');
    expect(bridge.loadSession).toHaveBeenCalledWith(
      review.sessionId,
      '/workspace',
      { sourceId: 'channel-a' },
      expect.anything(),
    );

    const persisted = JSON.parse(
      readFileSync(join(dir, 'named-sessions.json'), 'utf8'),
    ) as { version: number };
    expect(persisted.version).toBe(1);
  });

  it('creates, persists, closes, and reopens an exact worktree task', async () => {
    const named = manager();
    const created = await named.create(alice, 'feature', 'worktree');

    expect(created).toMatchObject({
      name: 'feature',
      isolation: 'worktree',
      active: true,
    });
    const worktreeCwd = canonicalizeWorkspacePath(
      `/worktrees/${created.sessionId}`,
    );
    expect(router.getSessionCwd(created.sessionId)).toBe(worktreeCwd);
    await named.close(alice, 'feature');
    await expect(named.use(alice, 'feature')).resolves.toMatchObject({
      sessionId: created.sessionId,
      isolation: 'worktree',
    });
    expect(bridge.loadSession).toHaveBeenCalledWith(
      created.sessionId,
      '/workspace',
      { sourceId: 'channel-a' },
      expect.anything(),
    );

    const persisted = JSON.parse(
      readFileSync(join(dir, 'named-sessions.json'), 'utf8'),
    ) as {
      workspaceCwd: string;
      owners: Array<{ tasks: Array<{ cwd: string; isolation: string }> }>;
    };
    expect(persisted.workspaceCwd).toBe(
      canonicalizeWorkspacePath('/workspace'),
    );
    expect(persisted.owners[0]?.tasks[0]).toMatchObject({
      cwd: worktreeCwd,
      isolation: 'worktree',
    });
  });

  it('resets a worktree task onto a fresh session that keeps the worktree', async () => {
    const named = manager();
    const created = await named.create(alice, 'feature', 'worktree');
    const worktreeCwd = canonicalizeWorkspacePath(
      `/worktrees/${created.sessionId}`,
    );
    const before = JSON.parse(
      readFileSync(join(dir, 'named-sessions.json'), 'utf8'),
    ) as { owners: Array<{ tasks: Array<{ createdAt: number }> }> };
    const createdAt = before.owners[0]?.tasks[0]?.createdAt;
    vi.mocked(bridge.newSession).mockClear();

    const reset = await named.reset(alice);

    expect(reset).toEqual({
      name: 'feature',
      previousSessionId: created.sessionId,
      sessionId: 'session-2',
      worktreeKept: true,
    });
    expect(bridge.resetWorktreeSession).toHaveBeenCalledWith(
      created.sessionId,
      '/workspace',
      { sourceId: 'channel-a' },
      expect.anything(),
    );
    // The reset is an ownership transfer: no fresh conversation session is
    // created and nothing is discarded.
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.discardSession).not.toHaveBeenCalled();
    // The replacement keeps the same worktree checkout and takes over routing.
    expect(router.getSessionCwd('session-2')).toBe(worktreeCwd);
    expect(router.getSession('channel-a', 'alice', 'group-1')).toBe(
      'session-2',
    );
    expect(named.presentation(created.sessionId)).toBeUndefined();
    expect(named.presentation('session-2')).toEqual(
      expect.objectContaining({ taskName: 'feature', status: 'open' }),
    );
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({ name: 'feature', sessionId: 'session-2' }),
    );

    // The registry swap preserves the task's identity and creation timestamp.
    const persisted = JSON.parse(
      readFileSync(join(dir, 'named-sessions.json'), 'utf8'),
    ) as {
      owners: Array<{
        tasks: Array<{ sessionId: string; cwd: string; createdAt: number }>;
      }>;
    };
    expect(persisted.owners[0]?.tasks[0]).toMatchObject({
      sessionId: 'session-2',
      cwd: worktreeCwd,
      createdAt,
    });
  });

  it('rejects resetting a busy worktree task before any daemon call', async () => {
    const named = manager(vi.fn().mockReturnValue(true));
    const created = await named.create(alice, 'feature', 'worktree');
    vi.mocked(bridge.newSession).mockClear();

    await expect(named.reset(alice)).rejects.toThrow(
      'Task "feature" is busy. Wait for the running prompt to finish (or cancel it), then try again.',
    );

    expect(bridge.resetWorktreeSession).not.toHaveBeenCalled();
    expect(bridge.newSession).not.toHaveBeenCalled();
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({
        name: 'feature',
        sessionId: created.sessionId,
      }),
    );
  });

  it('attempts a worktree reset once and keeps the daemon cause', async () => {
    const named = manager();
    const created = await named.create(alice, 'feature', 'worktree');
    vi.mocked(bridge.resetWorktreeSession).mockRejectedValue(
      daemonError('worktree_reset_invalid_state'),
    );

    const error: unknown = await named
      .reset(alice)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Could not reset task "feature".');
    expect(readDaemonHttpErrorCode(error)).toBe('worktree_reset_invalid_state');
    // The daemon resumes an interrupted transfer itself, so the manager never
    // retries a rejected reset.
    expect(bridge.resetWorktreeSession).toHaveBeenCalledTimes(1);
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({ sessionId: created.sessionId }),
    );
  });

  it('keeps the typed daemon code on a load failure for the channel', async () => {
    const named = manager();
    const created = await named.create(alice, 'feature', 'worktree');
    router.handleSessionDied(created.sessionId);
    vi.mocked(bridge.loadSession).mockRejectedValue(
      daemonError('worktree_reset_interrupted'),
    );

    const error: unknown = await named
      .use(alice, 'feature')
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      'Could not load task "feature". The current task was not changed.',
    );
    expect(readDaemonHttpErrorCode(error)).toBe('worktree_reset_interrupted');
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({ sessionId: created.sessionId }),
    );
  });

  it('detaches the replacement when the registry commit fails after a worktree reset', async () => {
    const registryDir = join(dir, 'registry');
    const named = new NamedSessionManager({
      channelName: 'channel-a',
      cwd: '/workspace',
      filePath: join(registryDir, 'named-sessions.json'),
      router,
      isBusy: () => false,
      now: () => 1_000,
    });
    const created = await named.create(alice, 'feature', 'worktree');
    rmSync(registryDir, { recursive: true, force: true });
    writeFileSync(registryDir, 'block');

    await expect(named.reset(alice)).rejects.toThrow('Failed to persist');

    // The freshly created replacement is released again; the registry keeps
    // pointing at the superseded id, which the next load heals via the
    // superseded redirect.
    expect(bridge.discardSession).toHaveBeenCalledWith('session-2');
    expect(router.getTarget('session-2')).toBeUndefined();
    expect(router.getTarget(created.sessionId)).toBeUndefined();
    expect(router.getSession('channel-a', 'alice', 'group-1')).toBeUndefined();
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({ sessionId: created.sessionId }),
    );
  });

  it('heals the registry when the daemon reports the task session superseded', async () => {
    const filePath = join(dir, 'named-sessions.json');
    const firstManager = manager();
    const created = await firstManager.create(alice, 'feature', 'worktree');
    const worktreeCwd = canonicalizeWorkspacePath(
      `/worktrees/${created.sessionId}`,
    );
    const restarted = supersededRestart(filePath, created.sessionId);

    const selected = await restarted.manager.use(alice, 'feature');

    // The selection, the registry, and the router all name the replacement.
    expect(selected.sessionId).toBe('session-2');
    await expect(restarted.manager.current(alice)).resolves.toEqual(
      expect.objectContaining({ name: 'feature', sessionId: 'session-2' }),
    );
    expect(restarted.manager.presentation(created.sessionId)).toBeUndefined();
    expect(restarted.manager.presentation('session-2')).toEqual(
      expect.objectContaining({ taskName: 'feature', status: 'open' }),
    );
    expect(restarted.router.getSession('channel-a', 'alice', 'group-1')).toBe(
      'session-2',
    );
    expect(restarted.router.getSessionCwd('session-2')).toBe(worktreeCwd);
    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      owners: Array<{ tasks: Array<{ sessionId: string }> }>;
    };
    expect(persisted.owners[0]?.tasks[0]?.sessionId).toBe('session-2');
  });

  it('moves the resolve reservation to the replacement session', async () => {
    const filePath = join(dir, 'named-sessions.json');
    const firstManager = manager();
    const created = await firstManager.create(alice, 'feature', 'worktree');
    const restarted = supersededRestart(filePath, created.sessionId);
    const reserved: string[] = [];
    const released: string[] = [];

    const sessionId = await restarted.manager.resolve(alice, (id) => {
      reserved.push(id);
      return () => {
        released.push(id);
      };
    });

    expect(sessionId).toBe('session-2');
    expect(reserved).toEqual([created.sessionId, 'session-2']);
    expect(released).toEqual([created.sessionId]);
  });

  it('reports the healed replacement session from a reserved reload', async () => {
    const filePath = join(dir, 'named-sessions.json');
    const firstManager = manager();
    const created = await firstManager.create(alice, 'feature', 'worktree');
    const restarted = supersededRestart(filePath, created.sessionId);

    // A queued turn is bound to the superseded id; the reload must hand back
    // the id the caller dispatches on, not just a success flag.
    await expect(
      restarted.manager.resumeReserved(alice, created.sessionId),
    ).resolves.toBe('session-2');
    await expect(restarted.manager.current(alice)).resolves.toEqual(
      expect.objectContaining({ name: 'feature', sessionId: 'session-2' }),
    );
  });

  it('loads a legacy shared-only v1 registry and writes its workspace root next', async () => {
    const first = manager();
    await first.create(alice, 'review');
    const filePath = join(dir, 'named-sessions.json');
    const legacy = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete legacy['workspaceCwd'];
    writeFileSync(filePath, JSON.stringify(legacy));

    const restarted = manager();
    await expect(restarted.current(alice)).resolves.toMatchObject({
      name: 'review',
      isolation: 'shared',
    });
    await restarted.create(alice, 'feature');

    const normalized = JSON.parse(readFileSync(filePath, 'utf8')) as {
      workspaceCwd?: string;
    };
    expect(normalized.workspaceCwd).toBe(
      canonicalizeWorkspacePath('/workspace'),
    );
  });

  it('restores the open presentation when close detachment rolls back', async () => {
    const named = manager();
    const review = await named.create(alice, 'review');
    vi.mocked(bridge.discardSession).mockRejectedValueOnce(
      new Error('detach failed'),
    );

    await expect(named.close(alice, 'review')).rejects.toThrow(
      'Failed to close',
    );
    expect(named.presentation(review.sessionId)).toEqual(
      expect.objectContaining({ taskName: 'review', status: 'open' }),
    );
  });

  it('keeps a fallback session healed mid-close when detachment rolls back', async () => {
    const filePath = join(dir, 'named-sessions.json');
    const named = manager();
    const fallback = await named.create(alice, 'fallback', 'worktree');
    const closing = await named.create(alice, 'feature', 'worktree');
    const healedId = 'session-1b';
    // The fallback's session was superseded out of band, so loading it during
    // the close heals the registry onto the replacement before the detach of
    // the closing task fails and the snapshot is restored.
    router.handleSessionDied(fallback.sessionId);
    vi.mocked(bridge.loadSession).mockImplementation(
      async (sessionId: string) => {
        if (sessionId === fallback.sessionId) {
          throw daemonError('worktree_session_superseded', {
            replacementSessionId: healedId,
          });
        }
        return sessionId;
      },
    );
    vi.mocked(bridge.listSessions).mockReturnValue([
      {
        sessionId: healedId,
        workspaceCwd: '/workspace',
        hasActivePrompt: false,
        worktree: {
          slug: 'fallback',
          path: `/worktrees/${fallback.sessionId}`,
          branch: 'fallback',
        },
        worktreeState: 'persisted-v1',
      },
      {
        sessionId: closing.sessionId,
        workspaceCwd: '/workspace',
        hasActivePrompt: false,
        worktree: {
          slug: 'feature',
          path: `/worktrees/${closing.sessionId}`,
          branch: 'feature',
        },
        worktreeState: 'persisted-v1',
      },
    ]);
    vi.mocked(bridge.discardSession).mockRejectedValueOnce(
      new Error('detach failed'),
    );

    await expect(named.close(alice, 'feature')).rejects.toThrow(
      'Failed to close',
    );

    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      owners: Array<{
        activeTaskName: string | null;
        tasks: Array<{ name: string; sessionId: string; status: string }>;
      }>;
    };
    const tasks = persisted.owners[0]?.tasks ?? [];
    // The committed heal survives the rollback ...
    expect(tasks.find((task) => task.name === 'fallback')?.sessionId).toBe(
      healedId,
    );
    // ... and the task that failed closed is restored under its original id.
    expect(tasks.find((task) => task.name === 'feature')).toMatchObject({
      sessionId: closing.sessionId,
      status: 'open',
    });
    expect(persisted.owners[0]?.activeTaskName).toBe('feature');
    expect(named.presentation(closing.sessionId)).toEqual(
      expect.objectContaining({ taskName: 'feature', status: 'open' }),
    );
    expect(named.presentation(healedId)).toEqual(
      expect.objectContaining({ taskName: 'fallback', status: 'open' }),
    );
  });

  it('replaces the indexed session ID when resetting a task', async () => {
    const named = manager();
    const review = await named.create(alice, 'review');

    const reset = await named.reset(alice);

    expect(reset?.previousSessionId).toBe(review.sessionId);
    expect(reset?.worktreeKept).toBe(false);
    expect(named.presentation(review.sessionId)).toBeUndefined();
    expect(named.presentation(reset!.sessionId)).toEqual(
      expect.objectContaining({ taskName: 'review', status: 'open' }),
    );
  });

  it('falls back to the most recently selected task when timestamps would tie', async () => {
    const named = manager();
    await named.create(alice, 'first');
    await named.create(alice, 'second');
    await named.create(alice, 'third');
    await named.use(alice, 'first');
    await named.use(alice, 'third');
    await named.use(alice, 'second');

    await expect(named.close(alice, 'second')).resolves.toEqual({
      closed: expect.objectContaining({ name: 'second' }),
      active: expect.objectContaining({ name: 'third', active: true }),
    });
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({ name: 'third', active: true }),
    );
  });

  it('allows a busy task to become the fallback when closing an idle task', async () => {
    const busySessions = new Set<string>();
    const named = manager((sessionId) => busySessions.has(sessionId));
    const fallback = await named.create(alice, 'fallback');
    const selected = await named.create(alice, 'selected');
    busySessions.add(fallback.sessionId);

    await expect(named.close(alice, selected.name)).resolves.toEqual({
      closed: expect.objectContaining({ name: 'selected' }),
      active: expect.objectContaining({ name: 'fallback', active: true }),
    });
    await expect(named.current(alice)).resolves.toEqual(
      expect.objectContaining({
        name: 'fallback',
        sessionId: fallback.sessionId,
      }),
    );
  });

  it('still rejects closing the busy task itself', async () => {
    const busySessions = new Set<string>();
    const named = manager((sessionId) => busySessions.has(sessionId));
    const task = await named.create(alice, 'review');
    busySessions.add(task.sessionId);

    await expect(named.close(alice, task.name)).rejects.toThrow(
      'still running or waiting for permission',
    );
  });

  it('rejects exhausted timestamps before creating or loading a session', async () => {
    const named = manager();
    await named.create(alice, 'review');
    await named.close(alice, 'review');
    const filePath = join(dir, 'named-sessions.json');
    const registry = JSON.parse(readFileSync(filePath, 'utf8')) as {
      owners: Array<{
        tasks: Array<{
          createdAt: number;
          updatedAt: number;
          lastSelectedAt: number;
        }>;
      }>;
    };
    const task = registry.owners[0]!.tasks[0]!;
    task.createdAt = Number.MAX_SAFE_INTEGER;
    task.updatedAt = Number.MAX_SAFE_INTEGER;
    task.lastSelectedAt = Number.MAX_SAFE_INTEGER;
    writeFileSync(filePath, JSON.stringify(registry));
    vi.mocked(bridge.newSession).mockClear();
    vi.mocked(bridge.loadSession).mockClear();
    const restarted = manager();

    await expect(restarted.create(alice, 'feature')).rejects.toThrow(
      'timestamp limit',
    );
    await expect(restarted.use(alice, 'review')).rejects.toThrow(
      'timestamp limit',
    );
    expect(bridge.newSession).not.toHaveBeenCalled();
    expect(bridge.loadSession).not.toHaveBeenCalled();
  });
});
