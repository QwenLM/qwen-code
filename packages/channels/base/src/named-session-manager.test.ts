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
import { SessionRouter } from './SessionRouter.js';

function createBridge(): ChannelAgentBridge {
  let nextId = 0;
  const live = new Set<string>();
  return {
    availableCommands: [],
    on: vi.fn(),
    off: vi.fn(),
    newSession: vi.fn(async () => {
      const sessionId = `session-${++nextId}`;
      live.add(sessionId);
      return sessionId;
    }),
    loadSession: vi.fn(async (sessionId: string) => {
      live.add(sessionId);
      return sessionId;
    }),
    prompt: vi.fn().mockResolvedValue(''),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    discardSession: vi.fn(async (sessionId: string) => {
      live.delete(sessionId);
    }),
    listSessions: vi.fn(() =>
      [...live].map((sessionId) => ({
        sessionId,
        workspaceCwd: '/workspace',
        hasActivePrompt: false,
      })),
    ),
  };
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
      true,
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
    ).resolves.toBe(false);
    await expect(named.close(alice, 'review')).resolves.toBeDefined();
    await expect(named.resumeReserved(alice, review.sessionId)).resolves.toBe(
      false,
    );
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

  it('replaces the indexed session ID when resetting a task', async () => {
    const named = manager();
    const review = await named.create(alice, 'review');

    const reset = await named.reset(alice);

    expect(reset?.previousSessionId).toBe(review.sessionId);
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
