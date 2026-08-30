import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRouter } from './SessionRouter.js';
import {
  DaemonChannelBridge,
  type DaemonChannelSessionClient,
} from './DaemonChannelBridge.js';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import type { SessionTarget } from './types.js';

const mockRenameSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      mockRenameSync(from, to);
      return actual.renameSync(from, to);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      mockWriteFileSync(...args);
      return actual.writeFileSync(...args);
    },
  };
});

let sessionCounter = 0;

function mockBridge(): ChannelAgentBridge {
  return {
    newSession: vi.fn().mockImplementation(() => `session-${++sessionCounter}`),
    loadSession: vi.fn().mockImplementation((id: string) => id),
    on: vi.fn(),
    off: vi.fn(),
    availableCommands: [],
    prompt: vi.fn().mockResolvedValue(''),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    discardSession: vi.fn().mockResolvedValue(undefined),
  };
}

function writePersistedSession(persistPath: string, key = 'key1'): void {
  writeFileSync(
    persistPath,
    JSON.stringify({
      [key]: {
        sessionId: 'old-session',
        target: {
          channelName: 'ch',
          senderId: 'alice',
          chatId: 'chat1',
        },
        cwd: '/tmp',
      },
    }),
  );
}

function rotationCounters(router: SessionRouter): {
  toTurns: Map<string, number>;
  toStartedAt: Map<string, number>;
} {
  return router as unknown as {
    toTurns: Map<string, number>;
    toStartedAt: Map<string, number>;
  };
}

function routingLeases(router: SessionRouter): Map<string, number> {
  return (router as unknown as { sessionRoutingLeases: Map<string, number> })
    .sessionRoutingLeases;
}

function invalidationMetadataSize(router: SessionRouter): number {
  const state = router as unknown as {
    routeGenerations?: Map<string, unknown>;
    routeTokens?: Map<string, unknown>;
  };
  return (state.routeTokens ?? state.routeGenerations)?.size ?? 0;
}

function daemonSession(
  sessionId: string,
  detach?: () => Promise<void>,
): DaemonChannelSessionClient & { detach?: () => Promise<void> } {
  return {
    sessionId,
    workspaceCwd: '/tmp',
    prompt: vi.fn().mockResolvedValue({}),
    uploadAttachment: vi.fn(),
    removeAttachment: vi.fn().mockResolvedValue(true),
    events: vi.fn(async function* (options?: { signal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) {
          resolve();
        } else {
          options?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }
      });
      yield* [];
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue({}),
    respondToPermission: vi.fn().mockResolvedValue(true),
    ...(detach ? { detach } : {}),
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
  }
}

describe('SessionRouter', () => {
  let bridge: ChannelAgentBridge;
  let tempDirs: string[] = [];

  beforeEach(() => {
    sessionCounter = 0;
    mockRenameSync.mockClear();
    mockWriteFileSync.mockClear();
    bridge = mockBridge();
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('routing key scopes', () => {
    it('user scope: routes by channel + sender + chat', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const s1 = await router.resolve('ch', 'alice', 'chat1');
      const s2 = await router.resolve('ch', 'alice', 'chat2');
      const s3 = await router.resolve('ch', 'bob', 'chat1');
      expect(new Set([s1, s2, s3]).size).toBe(3);
    });

    it('passes channel approval mode when creating sessions', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelApprovalMode('ch', 'yolo');

      await router.resolve('ch', 'alice', 'chat1');

      expect(bridge.newSession).toHaveBeenCalledWith(
        '/tmp',
        { approvalMode: 'yolo', sourceId: 'ch' },
        expect.any(Object),
      );
    });

    it('stamps channel name as sourceId when creating sessions', async () => {
      const router = new SessionRouter(bridge, '/tmp');

      await router.resolve('dingtalk-main', 'alice', 'chat1');

      expect(bridge.newSession).toHaveBeenCalledWith(
        '/tmp',
        { sourceId: 'dingtalk-main' },
        expect.any(Object),
      );
    });

    it('user scope: same sender+chat reuses session', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const s1 = await router.resolve('ch', 'alice', 'chat1');
      const s2 = await router.resolve('ch', 'alice', 'chat1');
      expect(s1).toBe(s2);
      expect(bridge.newSession).toHaveBeenCalledTimes(1);
    });

    it('thread scope: routes by channel + threadId', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const s1 = await router.resolve('ch', 'alice', 'chat1', 'thread1');
      const s2 = await router.resolve('ch', 'bob', 'chat1', 'thread1');
      expect(s1).toBe(s2); // same thread = same session
    });

    it('thread scope: keeps original target owner when reusing a session', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const sessionId = await router.resolve('ch', 'alice', 'chat1', 'thread1');

      await router.resolve('ch', 'bob', 'chat1', 'thread1');

      expect(router.getTarget(sessionId)).toMatchObject({
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
        threadId: 'thread1',
      });
    });

    it('thread scope: never downgrades group target metadata', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const sessionId = await router.resolve(
        'ch',
        'alice',
        'chat1',
        'thread1',
        undefined,
        true,
      );

      await router.resolve('ch', 'bob', 'chat1', 'thread1');

      expect(router.getTarget(sessionId)).toMatchObject({
        senderId: 'alice',
        chatId: 'chat1',
        threadId: 'thread1',
        isGroup: true,
      });
    });

    it('thread scope: upgrades group target metadata', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const sessionId = await router.resolve('ch', 'alice', 'chat1', 'thread1');

      await router.resolve('ch', 'alice', 'chat1', 'thread1', undefined, true);

      expect(router.getTarget(sessionId)).toMatchObject({
        senderId: 'alice',
        chatId: 'chat1',
        threadId: 'thread1',
        isGroup: true,
      });
    });

    it('thread scope: falls back to chatId when no threadId', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const s1 = await router.resolve('ch', 'alice', 'chat1');
      const s2 = await router.resolve('ch', 'bob', 'chat1');
      expect(s1).toBe(s2);
    });

    it('single scope: all messages share one session per channel', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'single');
      const s1 = await router.resolve('ch', 'alice', 'chat1');
      const s2 = await router.resolve('ch', 'bob', 'chat2');
      expect(s1).toBe(s2);
    });

    it('single scope: different channels get different sessions', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'single');
      const s1 = await router.resolve('ch1', 'alice', 'chat1');
      const s2 = await router.resolve('ch2', 'alice', 'chat1');
      expect(s1).not.toBe(s2);
    });

    it('per-channel scope overrides default scope', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'user');
      router.setChannelScope('telegram', 'single');

      // 'telegram' uses single scope: same session for different users
      const t1 = await router.resolve('telegram', 'alice', 'chat1');
      const t2 = await router.resolve('telegram', 'bob', 'chat2');
      expect(t1).toBe(t2);

      // other channel still uses default 'user' scope
      const d1 = await router.resolve('dingtalk', 'alice', 'chat1');
      const d2 = await router.resolve('dingtalk', 'bob', 'chat1');
      expect(d1).not.toBe(d2);
    });

    it('chat_thread scope: routes by channel + chatId + threadId', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'chat_thread');
      const s1 = await router.resolve('ch', 'alice', 'repo-a', 'issue:1');
      const s2 = await router.resolve('ch', 'bob', 'repo-a', 'issue:1');
      expect(s1).toBe(s2); // same chat+thread = same session

      const s3 = await router.resolve('ch', 'alice', 'repo-b', 'issue:1');
      expect(s1).not.toBe(s3); // different chatId = different session
    });

    it('chat_thread scope: falls back to chatId when no threadId', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'chat_thread');
      const s1 = await router.resolve('ch', 'alice', 'repo-a');
      const s2 = await router.resolve('ch', 'bob', 'repo-a');
      expect(s1).toBe(s2);
    });

    it('mixed per-channel scopes work independently', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelScope('ch-thread', 'thread');
      router.setChannelScope('ch-single', 'single');
      router.setChannelScope('ch-user', 'user');

      // thread scope: same thread = same session
      const t1 = await router.resolve('ch-thread', 'alice', 'c1', 'thread1');
      const t2 = await router.resolve('ch-thread', 'bob', 'c1', 'thread1');
      expect(t1).toBe(t2);

      // single scope: one session for all
      const s1 = await router.resolve('ch-single', 'alice', 'c1');
      const s2 = await router.resolve('ch-single', 'bob', 'c2');
      expect(s1).toBe(s2);

      // user scope: per-sender-per-chat
      const u1 = await router.resolve('ch-user', 'alice', 'c1');
      const u2 = await router.resolve('ch-user', 'alice', 'c2');
      expect(u1).not.toBe(u2);
    });
  });

  describe('resolve', () => {
    it('passes cwd to bridge.newSession', async () => {
      const router = new SessionRouter(bridge, '/default');
      await router.resolve('ch', 'alice', 'chat1', undefined, '/custom');
      expect(bridge.newSession).toHaveBeenCalledWith(
        '/custom',
        { sourceId: 'ch' },
        expect.any(Object),
      );
    });

    it('uses defaultCwd when no cwd provided', async () => {
      const router = new SessionRouter(bridge, '/default');
      await router.resolve('ch', 'alice', 'chat1');
      expect(bridge.newSession).toHaveBeenCalledWith(
        '/default',
        { sourceId: 'ch' },
        expect.any(Object),
      );
    });

    it('uses defaultCwd when cwd is empty', async () => {
      const router = new SessionRouter(bridge, '/default');
      await router.resolve('ch', 'alice', 'chat1', undefined, '');
      expect(bridge.newSession).toHaveBeenCalledWith(
        '/default',
        { sourceId: 'ch' },
        expect.any(Object),
      );
    });

    it('deduplicates concurrent session creation for the same route', async () => {
      let resolveNewSession!: (sessionId: string) => void;
      const newSession = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveNewSession = resolve;
          }),
      );
      bridge = {
        ...mockBridge(),
        newSession,
      };
      const router = new SessionRouter(bridge, '/default');

      const first = router.resolve('ch', 'alice', 'chat1');
      const second = router.resolve('ch', 'alice', 'chat1');
      await Promise.resolve();
      resolveNewSession('session-1');

      await expect(Promise.all([first, second])).resolves.toEqual([
        'session-1',
        'session-1',
      ]);
      expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('reserves a route before synchronously entering the bridge', async () => {
      let calls = 0;
      let reentered = false;
      let nested!: Promise<string>;
      const router = new SessionRouter(mockBridge(), '/default');
      const newSession = vi.fn(() => {
        const sessionId = `session-${++calls}`;
        if (!reentered) {
          reentered = true;
          nested = router.resolve('ch', 'alice', 'chat1');
        }
        return sessionId;
      });
      router.setBridge({ ...mockBridge(), newSession });

      const first = router.resolve('ch', 'alice', 'chat1');
      await Promise.resolve();

      await expect(Promise.all([first, nested])).resolves.toEqual([
        'session-1',
        'session-1',
      ]);
      expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('retries if a new session dies before the route is stored', async () => {
      let calls = 0;
      const router = new SessionRouter(mockBridge(), '/default');
      const newSession = vi.fn(async () => {
        calls++;
        const sessionId = calls === 1 ? 'dead-session' : 'live-session';
        if (sessionId === 'dead-session') {
          router.removeSessionId(sessionId);
        }
        return sessionId;
      });
      router.setBridge({
        ...mockBridge(),
        newSession,
      });

      await expect(router.resolve('ch', 'alice', 'chat1')).resolves.toBe(
        'live-session',
      );

      expect(newSession).toHaveBeenCalledTimes(2);
      expect(router.getSession('ch', 'alice', 'chat1')).toBe('live-session');
      expect(router.getTarget('dead-session')).toBeUndefined();
      expect(router.getTarget('live-session')).toEqual({
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
        threadId: undefined,
      });
    });

    it('does not store a route if session creation keeps dying', async () => {
      const router = new SessionRouter(mockBridge(), '/default');
      const newSession = vi.fn(async () => {
        router.removeSessionId('dead-session');
        return 'dead-session';
      });
      router.setBridge({
        ...mockBridge(),
        newSession,
      });

      await expect(router.resolve('ch', 'alice', 'chat1')).rejects.toThrow(
        'Session dead-session died before routing completed (2/2 attempts, key ch:alice:chat1)',
      );

      expect(newSession).toHaveBeenCalledTimes(2);
      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      expect(router.getTarget('dead-session')).toBeUndefined();
      expect(router.getAll()).toEqual([]);
    });

    it.each([
      ['empty string', ''],
      ['non-string value', 42],
    ])('rejects a %s returned by newSession', async (_label, sessionId) => {
      const router = new SessionRouter(mockBridge(), '/default');
      const newSession = vi.fn(
        async (): Promise<string> => sessionId as string,
      );
      router.setBridge({
        ...mockBridge(),
        newSession,
      });

      await expect(router.resolve('ch', 'alice', 'chat1')).rejects.toThrow(
        'Invalid session ID from bridge',
      );

      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      expect(router.getAll()).toEqual([]);
    });
  });

  describe('getTarget', () => {
    it('returns target for existing session', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sid = await router.resolve('ch', 'alice', 'chat1', 'thread1');
      const target = router.getTarget(sid);
      expect(target).toEqual({
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
        threadId: 'thread1',
      });
    });

    it('returns undefined for unknown session', () => {
      const router = new SessionRouter(bridge, '/tmp');
      expect(router.getTarget('nonexistent')).toBeUndefined();
    });
  });

  describe('getSession', () => {
    it('returns the session for the configured scope without creating one', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const sid = await router.resolve('ch', 'alice', 'chat1', 'thread1');

      expect(router.getSession('ch', 'bob', 'chat1', 'thread1')).toBe(sid);
      expect(
        router.getSession('ch', 'bob', 'chat1', 'thread2'),
      ).toBeUndefined();
      expect(bridge.newSession).toHaveBeenCalledTimes(1);
    });

    it('respects per-channel single scope overrides', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelScope('telegram', 'single');
      const sid = await router.resolve('telegram', 'alice', 'chat1');

      expect(router.getSession('telegram', 'bob', 'chat2')).toBe(sid);
      expect(router.getSession('other', 'bob', 'chat2')).toBeUndefined();
    });
  });

  describe('hasSession', () => {
    it('returns true for existing session with chatId', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      await router.resolve('ch', 'alice', 'chat1');
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(true);
    });

    it('uses threadId for exact lookups in thread scope', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      await router.resolve('ch', 'alice', 'chat1', 'thread1');
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
      expect(router.hasSession('ch', 'alice', 'chat1', 'thread1')).toBe(true);
    });

    it('returns false for non-existing session', () => {
      const router = new SessionRouter(bridge, '/tmp');
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
    });

    it('single scope: any sender/chat sees the one shared session', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'single');
      await router.resolve('ch', 'alice', 'chat1');
      // Different sender and chat still resolve to the same single session.
      expect(router.hasSession('ch', 'bob', 'other-chat')).toBe(true);
    });

    it('single scope: no-chat lookup does not assign the shared session to one sender', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'single');
      await router.resolve('ch', 'alice', 'chat1');

      expect(router.hasSession('ch', 'alice')).toBe(false);
    });

    it('prefix-scans when chatId omitted', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      await router.resolve('ch', 'alice', 'chat1');
      expect(router.hasSession('ch', 'alice')).toBe(true);
      expect(router.hasSession('ch', 'bob')).toBe(false);
    });

    it('does not match a different sender that shares an id prefix', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      await router.resolve('ch', 'bobby', 'chat1');
      // 'bob' is a prefix of 'bobby' but is a distinct sender with no session.
      expect(router.hasSession('ch', 'bob')).toBe(false);
      expect(router.hasSession('ch', 'bobby')).toBe(true);
    });

    it('finds sender sessions outside user-scope routing keys', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      await router.resolve('ch', 'alice', 'chat1', 'thread1');

      expect(router.hasSession('ch', 'alice')).toBe(true);
      expect(router.hasSession('ch', 'bob')).toBe(false);
    });
  });

  describe('managed sessions', () => {
    it.each(['create', 'load'] as const)(
      'rejects a managed %s that completes on a replaced bridge',
      async (operation) => {
        let finish!: (sessionId: string) => void;
        const oldDiscardSession = vi.fn(
          () => new Promise<void>(() => undefined),
        );
        const oldBridge = {
          ...mockBridge(),
          discardSession: oldDiscardSession,
          newSession: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                finish = resolve;
              }),
          ),
          loadSession: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                finish = resolve;
              }),
          ),
        } satisfies ChannelAgentBridge;
        const router = new SessionRouter(oldBridge, '/tmp', 'user', undefined, {
          recoveryMode: 'lazy',
        });
        const target = {
          channelName: 'ch',
          senderId: 'alice',
          chatId: 'chat1',
        };
        const pending =
          operation === 'create'
            ? router.createManagedSession(target, '/tmp')
            : router.loadManagedSession('old-session', target, '/tmp');
        await Promise.resolve();
        const replacementDiscardSession = vi.fn().mockResolvedValue(undefined);
        const replacementBridge = {
          ...mockBridge(),
          discardSession: replacementDiscardSession,
        } satisfies ChannelAgentBridge;

        router.setBridge(replacementBridge);
        finish(operation === 'create' ? 'new-session' : 'old-session');

        await expect(pending).rejects.toThrow('invalidated');
        expect(oldDiscardSession).toHaveBeenCalledWith(
          operation === 'create' ? 'new-session' : 'old-session',
          expect.anything(),
        );
        expect(replacementDiscardSession).not.toHaveBeenCalled();
        expect(router.getAll()).toEqual([]);
      },
    );

    it('disables loop tools for managed sessions when configured', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'user', undefined, {
        recoveryMode: 'lazy',
      });
      const target = {
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
      };
      router.setChannelLoopsEnabled('ch', false);

      await router.createManagedSession(target, '/tmp');
      await router.loadManagedSession('dormant-session', target, '/tmp');

      expect(bridge.newSession).toHaveBeenCalledWith(
        '/tmp',
        { enableChannelLoops: false, sourceId: 'ch' },
        expect.anything(),
      );
      expect(bridge.loadSession).toHaveBeenCalledWith(
        'dormant-session',
        '/tmp',
        { enableChannelLoops: false, sourceId: 'ch' },
        expect.anything(),
      );
    });

    it('loads an exact dormant task without creating a replacement on failure', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'user', undefined, {
        recoveryMode: 'lazy',
      });
      const activeId = await router.createManagedSession(
        { channelName: 'ch', senderId: 'alice', chatId: 'chat1' },
        '/tmp',
      );
      router.activateManagedSession(
        activeId,
        { channelName: 'ch', senderId: 'alice', chatId: 'chat1' },
        '/tmp',
      );
      vi.mocked(bridge.loadSession).mockRejectedValueOnce(new Error('gone'));

      await expect(
        router.loadManagedSession(
          'dormant-session',
          { channelName: 'ch', senderId: 'alice', chatId: 'chat1' },
          '/tmp',
        ),
      ).rejects.toThrow('gone');
      expect(router.getSession('ch', 'alice', 'chat1')).toBe(activeId);
      expect(bridge.newSession).toHaveBeenCalledTimes(1);
    });

    it('rebinds live tasks without loading or dropping inactive delivery metadata', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'user', undefined, {
        recoveryMode: 'lazy',
      });
      const firstTarget = {
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
      };
      const secondTarget = { ...firstTarget, threadId: 'feature' };
      const first = await router.createManagedSession(firstTarget, '/tmp');
      const second = await router.createManagedSession(secondTarget, '/tmp');

      router.activateManagedSession(first, firstTarget, '/tmp');
      await expect(
        router.loadManagedSession(second, secondTarget, '/tmp'),
      ).resolves.toEqual({ loaded: false });
      router.activateManagedSession(second, secondTarget, '/tmp');
      await expect(
        router.loadManagedSession(first, firstTarget, '/tmp'),
      ).resolves.toEqual({ loaded: false });
      router.activateManagedSession(first, firstTarget, '/tmp');

      expect(bridge.loadSession).not.toHaveBeenCalled();
      expect(router.getTarget(second)).toEqual(secondTarget);
      expect(router.getSession('ch', 'alice', 'chat1')).toBe(first);
    });

    it('reloads inactive managed tasks after the bridge is replaced', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'user', undefined, {
        recoveryMode: 'lazy',
      });
      const target = {
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
      };
      const first = await router.createManagedSession(target, '/tmp');
      const second = await router.createManagedSession(target, '/tmp');
      router.activateManagedSession(first, target, '/tmp');
      const replacementBridge = mockBridge();

      router.setBridge(replacementBridge);
      await expect(
        router.loadManagedSession(second, target, '/tmp'),
      ).resolves.toEqual({ loaded: true });

      expect(replacementBridge.loadSession).toHaveBeenCalledWith(
        second,
        '/tmp',
        { sourceId: 'ch' },
        expect.anything(),
      );
    });

    it('keeps a restored selected task live after bridge recovery', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });
      const target = {
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
      };
      const sessionId = await router.createManagedSession(target, '/tmp');
      router.activateManagedSession(sessionId, target, '/tmp');
      const replacementBridge = mockBridge();

      router.setBridge(replacementBridge);
      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 1,
        failed: 0,
      });
      await expect(
        router.loadManagedSession(sessionId, target, '/tmp'),
      ).resolves.toEqual({ loaded: false });

      expect(replacementBridge.loadSession).toHaveBeenCalledTimes(1);
    });

    it('detaches closed tasks without deleting daemon session data', async () => {
      const discardSession = vi.fn().mockResolvedValue(undefined);
      const deleteSessionData = vi.fn().mockResolvedValue(undefined);
      const managedBridge = {
        ...mockBridge(),
        discardSession,
        deleteSessionData,
      } satisfies ChannelAgentBridge;
      const router = new SessionRouter(
        managedBridge,
        '/tmp',
        'user',
        undefined,
        { recoveryMode: 'lazy' },
      );
      const sessionId = await router.createManagedSession(
        { channelName: 'ch', senderId: 'alice', chatId: 'chat1' },
        '/tmp',
      );

      await router.detachManagedSession(sessionId);

      expect(discardSession).toHaveBeenCalledWith(sessionId);
      expect(deleteSessionData).not.toHaveBeenCalled();
      expect(router.getTarget(sessionId)).toBeUndefined();
    });

    it('forgets managed routing even when runtime detachment fails', async () => {
      const managedBridge = {
        ...mockBridge(),
        discardSession: vi.fn().mockRejectedValue(new Error('detach failed')),
      } satisfies ChannelAgentBridge;
      const router = new SessionRouter(
        managedBridge,
        '/tmp',
        'user',
        undefined,
        { recoveryMode: 'lazy' },
      );
      const target = {
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
      };
      const sessionId = await router.createManagedSession(target, '/tmp');
      router.activateManagedSession(sessionId, target, '/tmp');

      await expect(router.detachManagedSession(sessionId)).rejects.toThrow(
        'detach failed',
      );
      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      expect(router.getTarget(sessionId)).toBeUndefined();
    });
  });

  describe('removeSession', () => {
    it('removes session by key and returns session IDs', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sid = await router.resolve('ch', 'alice', 'chat1');
      const removed = router.removeSession('ch', 'alice', 'chat1');
      expect(removed).toEqual([sid]);
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
    });

    it('removes thread-scoped sessions by threadId', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const sid = await router.resolve('ch', 'alice', 'chat1', 'thread1');
      expect(router.removeSession('ch', 'alice', 'chat1')).toEqual([]);
      expect(router.removeSession('ch', 'alice', 'chat1', 'thread1')).toEqual([
        sid,
      ]);
      expect(router.hasSession('ch', 'alice', 'chat1', 'thread1')).toBe(false);
    });

    it('returns empty array when nothing to remove', () => {
      const router = new SessionRouter(bridge, '/tmp');
      expect(router.removeSession('ch', 'alice', 'chat1')).toEqual([]);
    });

    it('single scope: removeSession clears the shared session for everyone', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'single');
      const sid = await router.resolve('ch', 'alice', 'chat1');
      // Any sender/chat removes the one shared session.
      expect(router.removeSession('ch', 'bob', 'other-chat')).toEqual([sid]);
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
    });

    it('single scope: no-chat removal does not assign the shared session to one sender', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'single');
      const sid = await router.resolve('ch', 'alice', 'chat1');

      expect(router.removeSession('ch', 'alice')).toEqual([]);
      expect(router.getTarget(sid)).toBeDefined();
    });

    it('removes all sender sessions when chatId omitted', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      await router.resolve('ch', 'alice', 'chat1');
      await router.resolve('ch', 'alice', 'chat2');
      const removed = router.removeSession('ch', 'alice');
      expect(removed).toHaveLength(2);
      expect(router.hasSession('ch', 'alice')).toBe(false);
    });

    it('does not remove a different sender that shares an id prefix', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const bobby = await router.resolve('ch', 'bobby', 'chat1');
      // Removing 'bob' (a prefix of 'bobby') must not tear down 'bobby'.
      expect(router.removeSession('ch', 'bob')).toEqual([]);
      expect(router.hasSession('ch', 'bobby')).toBe(true);
      expect(router.getTarget(bobby)).toBeDefined();
    });

    it('removes sender sessions outside user-scope routing keys', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const sid = await router.resolve('ch', 'alice', 'chat1', 'thread1');

      expect(router.removeSession('ch', 'alice')).toEqual([sid]);
      expect(router.hasSession('ch', 'alice')).toBe(false);
      expect(router.getTarget(sid)).toBeUndefined();
    });

    it('cleans up target mapping after removal', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sid = await router.resolve('ch', 'alice', 'chat1');
      router.removeSession('ch', 'alice', 'chat1');
      expect(router.getTarget(sid)).toBeUndefined();
    });

    it('removes a thread-scoped session using threadId', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const sid = await router.resolve('ch', 'alice', 'chat1', 'thread1');

      expect(router.removeSession('ch', 'alice', 'chat1', 'thread1')).toEqual([
        sid,
      ]);
      expect(router.getTarget(sid)).toBeUndefined();
    });

    it('reports thread-scoped sessions using threadId', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      await router.resolve('ch', 'alice', 'chat1', 'thread1');

      expect(router.hasSession('ch', 'bob', 'chat1', 'thread1')).toBe(true);
      expect(router.hasSession('ch', 'bob', 'chat1', 'thread2')).toBe(false);
    });

    it('releases invalidation metadata for cleared and failed routes', async () => {
      const router = new SessionRouter(bridge, '/tmp');

      for (let index = 0; index < 20; index++) {
        router.removeSession('ch', `missing-${index}`, `chat-${index}`);
      }

      for (let index = 0; index < 20; index++) {
        await router.resolve('ch', `complete-${index}`, `chat-${index}`);
        router.removeSession('ch', `complete-${index}`, `chat-${index}`);
      }

      router.setBridge({
        ...mockBridge(),
        newSession: vi.fn().mockRejectedValue(new Error('unavailable')),
      });
      for (let index = 0; index < 20; index++) {
        await expect(
          router.resolve('ch', `failed-${index}`, `chat-${index}`),
        ).rejects.toThrow('unavailable');
      }

      expect(router.getAll()).toEqual([]);
      expect(invalidationMetadataSize(router)).toBe(0);
    });
  });

  describe('removeSessionId', () => {
    it('removes mappings by daemon session id', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sid = await router.resolve('ch', 'alice', 'chat1');

      expect(router.removeSessionId(sid)).toBe(true);
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
      expect(router.getTarget(sid)).toBeUndefined();
      expect(router.removeSessionId('missing')).toBe(false);
    });

    it('persists after removing by daemon session id', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const sid = await router.resolve('ch', 'alice', 'chat1');

      expect(existsSync(persistPath)).toBe(true);
      expect(router.removeSessionId(sid)).toBe(true);

      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
    });

    it('updates persisted target metadata when reusing a restored session', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath, 'ch:chat1');
      const router = new SessionRouter(bridge, '/tmp', 'thread', persistPath);

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 1,
        failed: 0,
      });
      const sid = await router.resolve(
        'ch',
        'alice',
        'chat1',
        undefined,
        '/tmp',
        true,
      );

      expect(sid).toBe('old-session');
      expect(router.getTarget(sid)).toEqual({
        channelName: 'ch',
        senderId: 'alice',
        chatId: 'chat1',
        threadId: undefined,
        isGroup: true,
      });
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:chat1': {
          sessionId: 'old-session',
          target: {
            channelName: 'ch',
            senderId: 'alice',
            chatId: 'chat1',
            isGroup: true,
          },
          cwd: '/tmp',
        },
      });
    });
  });

  describe('restoreSessions', () => {
    it('passes channel approval mode when restoring sessions', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath);
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelApprovalMode('ch', 'yolo');

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 1,
        failed: 0,
      });

      expect(bridge.loadSession).toHaveBeenCalledWith(
        'old-session',
        '/tmp',
        { approvalMode: 'yolo', sourceId: 'ch' },
        expect.any(Object),
      );
    });

    it('stamps channel name as sourceId when restoring sessions', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath);
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 1,
        failed: 0,
      });

      expect(bridge.loadSession).toHaveBeenCalledWith(
        'old-session',
        '/tmp',
        { sourceId: 'ch' },
        expect.any(Object),
      );
    });

    it('logs malformed persisted session files', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writeFileSync(persistPath, '{bad');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await expect(router.restoreSessions()).resolves.toEqual({
          restored: 0,
          failed: 0,
        });

        const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
        expect(logged).toContain('[SessionRouter] Corrupted persist file at');
        expect(logged).toContain('sessions.json');
      } finally {
        stderr.mockRestore();
      }
    });

    it('logs failed restores with sanitized persisted fields', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice\nforged:chat1': {
            sessionId: 'old\nsession',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
          },
        }),
      );
      bridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockRejectedValue(new Error('bad\nreason')),
      } as unknown as ChannelAgentBridge;
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        await expect(router.restoreSessions()).resolves.toEqual({
          restored: 0,
          failed: 1,
        });

        const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
        expect(logged).toContain('old\\nsession');
        expect(logged).toContain('ch:alice\\nforged:chat1');
        expect(logged).toContain('bad\\nreason');
        expect(logged).not.toContain('old\nsession');
        expect(logged).not.toContain('bad\nreason');
      } finally {
        stderr.mockRestore();
      }
    });

    it('treats falsy restored session ids as failed restores', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      bridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockResolvedValue(''),
      } as unknown as ChannelAgentBridge;
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 0,
        failed: 1,
      });
      expect(router.getAll()).toEqual([]);
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
    });

    it('treats non-string restored session ids as failed restores', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      bridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChannelAgentBridge;
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 0,
        failed: 1,
      });
      expect(router.getAll()).toEqual([]);
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
    });

    it('drops existing in-memory mappings when restore fails after restart', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const sid = await router.resolve('ch', 'alice', 'chat1');
      const restartedBridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockResolvedValue(''),
      } as unknown as ChannelAgentBridge;

      router.setBridge(restartedBridge);

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 0,
        failed: 1,
      });
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
      expect(router.getTarget(sid)).toBeUndefined();
      expect(router.getAll()).toEqual([]);
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
    });

    it('drops malformed persisted routes from existing eager state', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const aliceSession = await router.resolve('ch', 'alice', 'chat1');
      await router.resolve('ch', 'bob', 'chat2');
      const persisted = JSON.parse(
        readFileSync(persistPath, 'utf-8'),
      ) as Record<string, unknown>;
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': persisted['ch:alice:chat1'],
          'ch:bob:chat2': { sessionId: 42 },
        }),
      );
      const restartedBridge = {
        ...mockBridge(),
        loadSession: vi
          .fn()
          .mockImplementation((sessionId: string) =>
            Promise.resolve(sessionId),
          ),
      } as unknown as ChannelAgentBridge;

      router.setBridge(restartedBridge);

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 1,
        failed: 0,
      });
      expect(restartedBridge.loadSession).toHaveBeenCalledWith(
        aliceSession,
        '/tmp',
        { sourceId: 'ch' },
        expect.any(Object),
      );
      expect(router.getSession('ch', 'alice', 'chat1')).toBe(aliceSession);
      expect(router.getSession('ch', 'bob', 'chat2')).toBeUndefined();
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:alice:chat1': expect.objectContaining({ sessionId: aliceSession }),
      });
    });

    it('persists replacement ids returned by loadSession', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      await router.resolve('ch', 'alice', 'chat1');
      const restartedBridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockResolvedValue('replacement-session'),
      } as unknown as ChannelAgentBridge;

      router.setBridge(restartedBridge);

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 1,
        failed: 0,
      });
      expect(router.getSession('ch', 'alice', 'chat1')).toBe(
        'replacement-session',
      );
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:alice:chat1': expect.objectContaining({
          sessionId: 'replacement-session',
        }),
      });
    });

    it('does not restore a session that dies before the route is stored', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const state: { router?: SessionRouter } = {};
      bridge = {
        ...mockBridge(),
        loadSession: vi.fn(async () => {
          state.router?.removeSessionId('dead-restored-session');
          return 'dead-restored-session';
        }),
      };
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      state.router = router;

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 0,
        failed: 1,
      });

      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      expect(router.getTarget('dead-restored-session')).toBeUndefined();
      expect(router.getAll()).toEqual([]);
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
    });

    it('shares an in-flight restore with concurrent resolve for the same route', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      let resolveLoadSession!: (sessionId: string) => void;
      const loadSession = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoadSession = resolve;
          }),
      );
      bridge = {
        ...mockBridge(),
        loadSession,
      };
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

      const restore = router.restoreSessions();
      await Promise.resolve();
      const resolved = router.resolve('ch', 'alice', 'chat1');
      resolveLoadSession('restored-session');

      await expect(resolved).resolves.toBe('restored-session');
      await expect(restore).resolves.toEqual({ restored: 1, failed: 0 });
      expect(bridge.newSession).not.toHaveBeenCalled();
      expect(router.getSession('ch', 'alice', 'chat1')).toBe(
        'restored-session',
      );
      expect(router.getAll()).toHaveLength(1);
    });

    it.each(['removeSession', 'removeSessionId'] as const)(
      'invalidates a restore waiter when %s runs after reservation resolution',
      async (removal) => {
        const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
        tempDirs.push(dir);
        const persistPath = join(dir, 'sessions.json');
        writePersistedSession(persistPath, 'ch:alice:chat1');
        let resolveLoadSession!: (sessionId: string) => void;
        bridge = {
          ...mockBridge(),
          loadSession: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                resolveLoadSession = resolve;
              }),
          ),
        };
        const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

        const restore = router.restoreSessions();
        await Promise.resolve();
        const resolved = router.resolve('ch', 'alice', 'chat1');
        resolveLoadSession('restored-session');
        queueMicrotask(() => {
          if (removal === 'removeSession') {
            router.removeSession('ch', 'alice', 'chat1');
          } else {
            router.removeSessionId('restored-session');
          }
        });

        await expect(resolved).rejects.toThrow('invalidated');
        await expect(restore).resolves.toEqual({ restored: 1, failed: 0 });
        expect(bridge.newSession).not.toHaveBeenCalled();
        expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
        expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
      },
    );

    it('creates a fresh session for concurrent resolve when restore fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      let resolveLoadSession!: (sessionId: string) => void;
      const loadSession = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoadSession = resolve;
          }),
      );
      bridge = {
        ...mockBridge(),
        loadSession,
      };
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

      const restore = router.restoreSessions();
      await Promise.resolve();
      const resolved = router.resolve('ch', 'alice', 'chat1');
      resolveLoadSession('');

      await expect(resolved).resolves.toBe('session-1');
      await expect(restore).resolves.toEqual({ restored: 0, failed: 1 });
      expect(bridge.newSession).toHaveBeenCalledTimes(1);
      expect(router.getSession('ch', 'alice', 'chat1')).toBe('session-1');
      expect(router.getAll()).toHaveLength(1);
    });

    it('reserves all persisted routes before restoring them', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      await router.resolve('ch', 'alice', 'chat1');
      await router.resolve('ch', 'bob', 'chat2');
      const loadResolvers: Array<(sessionId: string) => void> = [];
      const restartedBridge = {
        ...mockBridge(),
        loadSession: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              loadResolvers.push(resolve);
            }),
        ),
      };
      router.setBridge(restartedBridge);

      const restore = router.restoreSessions();
      await Promise.resolve();
      const bobResolved = router.resolve('ch', 'bob', 'chat2');
      loadResolvers[0]!('restored-alice');
      await Promise.resolve();
      loadResolvers[1]!('restored-bob');

      await expect(bobResolved).resolves.toBe('restored-bob');
      await expect(restore).resolves.toEqual({ restored: 2, failed: 0 });
      expect(restartedBridge.newSession).not.toHaveBeenCalled();
      expect(router.getSession('ch', 'alice', 'chat1')).toBe('restored-alice');
      expect(router.getSession('ch', 'bob', 'chat2')).toBe('restored-bob');
      expect(router.getTarget('session-2')).toBeUndefined();
    });

    it('keeps dead session ids within the active restore window', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'sessions.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
        }),
      );
      const state: { router?: SessionRouter } = {};
      bridge = {
        ...mockBridge(),
        loadSession: vi.fn(async (sessionId: string) => {
          if (sessionId === 'old-alice') {
            state.router?.removeSessionId('restored-bob');
            return 'restored-alice';
          }
          return 'restored-bob';
        }),
      };
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      state.router = router;

      await expect(router.restoreSessions()).resolves.toEqual({
        restored: 1,
        failed: 1,
      });

      expect(router.getSession('ch', 'alice', 'chat1')).toBe('restored-alice');
      expect(router.getSession('ch', 'bob', 'chat2')).toBeUndefined();
      expect(router.getTarget('restored-bob')).toBeUndefined();
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:alice:chat1': expect.objectContaining({
          sessionId: 'restored-alice',
        }),
      });
    });
  });

  describe('persistence safety', () => {
    it('quarantines invalid JSON and starts with no routes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(persistPath, '{bad');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });

      expect(router.restoreRoutes()).toEqual({ restored: 0, dropped: 0 });
      expect(existsSync(persistPath)).toBe(false);
      expect(
        readdirSync(dir).some((name) =>
          name.startsWith('routes.json.corrupt-'),
        ),
      ).toBe(true);
    });

    it('drops malformed entries but keeps valid siblings', () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'valid-session',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
          },
          broken: { sessionId: 42 },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });

      expect(router.restoreRoutes()).toEqual({ restored: 1, dropped: 1 });
      expect(router.getSession('ch', 'alice', 'chat1')).toBe('valid-session');
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:alice:chat1': expect.objectContaining({
          sessionId: 'valid-session',
        }),
      });
    });

    it('persists through a same-directory temporary file and rename', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

      await router.resolve('ch', 'alice', 'chat1');

      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:alice:chat1': expect.objectContaining({ sessionId: 'session-1' }),
      });
      expect(mockRenameSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.tmp$/),
        persistPath,
      );
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(
        [],
      );
      if (process.platform !== 'win32') {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(persistPath).mode & 0o777).toBe(0o600);
      }
    });
  });

  describe('getAll', () => {
    it('returns all session entries', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      await router.resolve('ch', 'alice', 'chat1');
      await router.resolve('ch', 'bob', 'chat2');
      const all = router.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.target.senderId).sort()).toEqual([
        'alice',
        'bob',
      ]);
    });

    it('returns empty array when no sessions', () => {
      const router = new SessionRouter(bridge, '/tmp');
      expect(router.getAll()).toEqual([]);
    });
  });

  describe('session rotation', () => {
    /**
     * Emulate the channel contract: every message resolve() hands out
     * releases its routing lease once settled (its turn was enqueued, or it
     * exited without one). Rotation defers while a lease is held.
     */
    async function routed(
      router: SessionRouter,
      ...args: Parameters<SessionRouter['resolve']>
    ): Promise<string> {
      const sessionId = await router.resolve(...args);
      router.releaseRoutingLease(sessionId);
      return sessionId;
    }

    it('keeps reusing the session when no rotation is configured', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const first = await routed(router, 'ch', 'alice', 'chat1');
      for (let index = 0; index < 20; index++) {
        expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
      }
    });

    it('starts a new session once maxTurns is reached', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 3 });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);

      const rotated = await routed(router, 'ch', 'alice', 'chat1');
      expect(rotated).not.toBe(first);
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(rotated);
    });

    it('rotates only the route that hit the bound', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 2 });

      const busy = await routed(router, 'ch', 'alice', 'chat1');
      const quiet = await routed(router, 'ch', 'bob', 'chat2');
      await routed(router, 'ch', 'alice', 'chat1');

      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(busy);
      expect(await routed(router, 'ch', 'bob', 'chat2')).toBe(quiet);
    });

    it('does not rotate a channel that has no bound configured', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('bounded', { maxTurns: 2 });

      const unbounded = await routed(router, 'other', 'alice', 'chat1');
      for (let index = 0; index < 5; index++) {
        expect(await routed(router, 'other', 'alice', 'chat1')).toBe(unbounded);
      }
    });

    it('starts a new session once maxAgeHours has elapsed', async () => {
      vi.useFakeTimers();
      try {
        const router = new SessionRouter(bridge, '/tmp');
        router.setChannelRotation('ch', { maxAgeHours: 2 });

        const first = await routed(router, 'ch', 'alice', 'chat1');
        vi.advanceTimersByTime(90 * 60 * 1000);
        expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);

        vi.advanceTimersByTime(31 * 60 * 1000);
        expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores non-positive bounds instead of rotating every message', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 0, maxAgeHours: -1 });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
    });

    it('persists turn counts so a restart cannot reset the bound', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');

      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      const first = await routed(router, 'ch', 'alice', 'chat1');
      await routed(router, 'ch', 'alice', 'chat1');

      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1'].turns).toBe(2);

      const revived = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });
      revived.setChannelRotation('ch', { maxTurns: 3 });
      revived.restoreRoutes();

      expect(await routed(revived, 'ch', 'alice', 'chat1')).toBe(first);
      expect(await routed(revived, 'ch', 'alice', 'chat1')).not.toBe(first);
    });

    it('accepts route stores written before rotation existed', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');

      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });
      router.setChannelRotation('ch', { maxAgeHours: 1 });

      expect(router.restoreRoutes()).toEqual({ restored: 1, dropped: 0 });
      // No recorded start: the clock starts now rather than rotating on sight.
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe('old-session');
    });

    it('persists the stamped start of a pre-rotation route across restarts', async () => {
      vi.useFakeTimers();
      try {
        const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
        tempDirs.push(dir);
        const persistPath = join(dir, 'routes.json');
        writePersistedSession(persistPath, 'ch:alice:chat1');

        const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
          recoveryMode: 'lazy',
        });
        router.setChannelRotation('ch', { maxAgeHours: 1 });
        router.restoreRoutes();

        expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(
          'old-session',
        );
        const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
        expect(typeof persisted['ch:alice:chat1'].startedAt).toBe('number');

        // The stamp write happens once; later messages stay write-free.
        mockWriteFileSync.mockClear();
        expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(
          'old-session',
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();

        // A restart restores the stamped clock instead of re-arming it.
        vi.advanceTimersByTime(61 * 60 * 1000);
        const revived = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
          recoveryMode: 'lazy',
        });
        revived.setChannelRotation('ch', { maxAgeHours: 1 });
        revived.restoreRoutes();

        expect(await routed(revived, 'ch', 'alice', 'chat1')).not.toBe(
          'old-session',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('discards the retired session when rotating', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      const first = await routed(router, 'ch', 'alice', 'chat1');

      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
      await drainMicrotasks();

      expect(bridge.discardSession).toHaveBeenCalledWith(first);
    });

    it('notifies rotation listeners with the retired session and target', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      const rotated: Array<{
        sessionId: string;
        target: SessionTarget | undefined;
      }> = [];
      router.onSessionRotated((sessionId, target) => {
        rotated.push({ sessionId, target });
      });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      await routed(router, 'ch', 'alice', 'chat1');

      expect(rotated).toEqual([
        {
          sessionId: first,
          target: {
            channelName: 'ch',
            senderId: 'alice',
            chatId: 'chat1',
            threadId: undefined,
            isGroup: undefined,
          },
        },
      ]);
    });

    it('unsubscribes rotation listeners', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      const listener = vi.fn();
      const unsubscribe = router.onSessionRotated(listener);
      unsubscribe();

      await routed(router, 'ch', 'alice', 'chat1');
      await routed(router, 'ch', 'alice', 'chat1');

      expect(listener).not.toHaveBeenCalled();
    });

    it('keeps rotating when a rotation listener throws', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      const seen: string[] = [];
      router.onSessionRotated(() => {
        throw new Error('listener boom');
      });
      router.onSessionRotated((sessionId) => {
        seen.push(sessionId);
      });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      // The throwing listener must not skip the discard, silence the rest,
      // or fail the message after the retirement already landed.
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
      await drainMicrotasks();

      expect(seen).toEqual([first]);
      expect(bridge.discardSession).toHaveBeenCalledWith(first);
    });

    it('defers rotation while the outgoing session is still active', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      let busy = true;
      router.setSessionActivityChecker('ch', () => busy);

      const first = await routed(router, 'ch', 'alice', 'chat1');
      // At the bound but mid-turn: the route stays and nothing is discarded.
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
      expect(bridge.discardSession).not.toHaveBeenCalled();

      busy = false;
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
      await drainMicrotasks();
      expect(bridge.discardSession).toHaveBeenCalledWith(first);
    });

    it('defers rotation while a routed message has not settled yet', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });

      const first = await routed(router, 'ch', 'alice', 'chat1');

      // The second message rotates, and its routing lease stays held while
      // the message is still between resolve() and turn registration.
      const second = await router.resolve('ch', 'alice', 'chat1');
      expect(second).not.toBe(first);

      // A third message must not rotate the successor out from under the
      // second: the second resolved it and is about to prompt it.
      expect(await router.resolve('ch', 'alice', 'chat1')).toBe(second);
      expect(bridge.discardSession).toHaveBeenCalledTimes(1);
      expect(bridge.discardSession).toHaveBeenCalledWith(first);

      // Release one of the two leases: with one still outstanding the
      // rotation must keep deferring.
      router.releaseRoutingLease(second);
      const held = await router.resolve('ch', 'alice', 'chat1');
      expect(held).toBe(second);

      router.releaseRoutingLease(held);
      router.releaseRoutingLease(second);
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(second);
      await drainMicrotasks();
      expect(bridge.discardSession).toHaveBeenCalledWith(second);
    });

    it('does not rotate a route while its reload is in flight', async () => {
      vi.useFakeTimers();
      try {
        const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
        tempDirs.push(dir);
        const persistPath = join(dir, 'routes.json');
        writeFileSync(
          persistPath,
          JSON.stringify({
            'ch:alice:chat1': {
              sessionId: 'old-session',
              target: {
                channelName: 'ch',
                senderId: 'alice',
                chatId: 'chat1',
              },
              cwd: '/tmp',
              startedAt: Date.now(),
            },
          }),
        );
        const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
          recoveryMode: 'lazy',
        });
        router.setChannelRotation('ch', { maxAgeHours: 1 });
        let releaseLoad!: (sessionId: string) => void;
        (bridge.loadSession as ReturnType<typeof vi.fn>).mockReturnValue(
          new Promise<string>((resolve) => {
            releaseLoad = resolve;
          }),
        );
        router.restoreRoutes();

        // The first resolve starts the reload; once the age bound passes
        // mid-reload, a second resolve must wait for the reload instead of
        // rotating (which would invalidate the concurrent message).
        const first = router.resolve('ch', 'alice', 'chat1');
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
        const second = router.resolve('ch', 'alice', 'chat1');
        releaseLoad('reloaded-session');

        expect(await first).toBe('reloaded-session');
        expect(await second).toBe('reloaded-session');
        expect(bridge.discardSession).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops deferring rotation once the activity checker is unregistered', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      router.setSessionActivityChecker('ch', () => true);

      const first = await routed(router, 'ch', 'alice', 'chat1');
      // The checker reports the session as active forever, so the bound
      // never fires while it is registered.
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);

      router.setSessionActivityChecker('ch', undefined);
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
    });

    it('restores rotation counters in eager recovery', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-session',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 2,
            startedAt: Date.now(),
          },
        }),
      );
      // Default (eager) recovery: channel start uses restoreSessions().
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });

      await router.restoreSessions();

      // Carried turns (2) plus this message reach the bound: next rotates.
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe('old-session');
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(
        'old-session',
      );
    });

    it('rotates an at-bound session handed back by an in-flight restore', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-session',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 3,
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      let releaseRestore!: (sessionId: string) => void;
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<string>((resolve) => {
          releaseRestore = resolve;
        }),
      );

      // The message parks on the restore reservation; the restored session
      // comes back already at its bound and must be rotated, not reused.
      const restoring = router.restoreSessions();
      const waiter = router.resolve('ch', 'alice', 'chat1');
      releaseRestore('old-session');
      await restoring;

      const sessionId = await waiter;
      router.releaseRoutingLease(sessionId);
      expect(sessionId).not.toBe('old-session');
      await drainMicrotasks();
      expect(bridge.discardSession).toHaveBeenCalledWith('old-session');

      // The waiter was the successor's first turn: the remaining bound of
      // turns reuses it, and only then does it rotate.
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(sessionId);
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(sessionId);
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(sessionId);
    });

    it('routes every waiter when an at-bound restore rotates under them', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-session',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 3,
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      let releaseRestore!: (sessionId: string) => void;
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<string>((resolve) => {
          releaseRestore = resolve;
        }),
      );

      // Two messages park on the same restore reservation. The restored
      // session is already at its bound, so the first waiter rotates it —
      // destroying the route token the second waiter's reservation still
      // references. The second must follow the successor, not fail with
      // the invalidation.
      const restoring = router.restoreSessions();
      const first = router.resolve('ch', 'alice', 'chat1');
      const second = router.resolve('ch', 'alice', 'chat1');
      releaseRestore('old-session');
      await restoring;

      const firstId = await first;
      const secondId = await second;
      router.releaseRoutingLease(firstId);
      router.releaseRoutingLease(secondId);
      expect(firstId).not.toBe('old-session');
      expect(secondId).toBe(firstId);
      expect(bridge.newSession).toHaveBeenCalledTimes(1);
      await drainMicrotasks();
      expect(bridge.discardSession).toHaveBeenCalledWith('old-session');

      // The retried message's turn is carried and counts against the bound:
      // one more reuse reaches it, and only then does the route rotate.
      expect(rotationCounters(router).toTurns.get(firstId)).toBe(2);
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(firstId);
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(firstId);
    });

    it('never persists a truncated store while an eager restore is mid-flight', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 3,
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );

      const restoring = router.restoreSessions();
      await Promise.resolve();
      // The message parks on alice's reservation and is released while
      // bob's key is still unrestored; its rotation then persists.
      const waiter = router.resolve('ch', 'alice', 'chat1');
      loadResolvers[0]!('old-alice');

      // The waiter settles (rotating the at-bound session and persisting)
      // before bob's restore is released: this is the truncation window.
      const sessionId = await waiter;
      router.releaseRoutingLease(sessionId);
      expect(sessionId).not.toBe('old-alice');

      loadResolvers[1]!('old-bob');
      await restoring;

      // Every write must hold the whole store: a truncated prefix becoming
      // durable silently loses bob's route on the next restart.
      for (const call of mockWriteFileSync.mock.calls) {
        const written = JSON.parse(String(call[1])) as Record<
          string,
          { sessionId: string }
        >;
        expect(written['ch:bob:chat2']?.sessionId).toBe('old-bob');
      }
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:bob:chat2'].sessionId).toBe('old-bob');
      expect(persisted['ch:alice:chat1'].sessionId).toBe(sessionId);
    });

    it('keeps the store whole when a second restore overlaps the first', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
          'ch:carol:chat3': {
            sessionId: 'old-carol',
            target: {
              channelName: 'ch',
              senderId: 'carol',
              chatId: 'chat3',
            },
            cwd: '/tmp',
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );

      // Drop the setup write: only router writes count below.
      mockWriteFileSync.mockClear();

      // A reconnect READY fires a second restore while the cold-start one
      // still runs: the first has restored alice already, and the second's
      // reservation pass drops alice back out of the store before the first
      // finishes — the truncation window.
      const first = router.restoreSessions();
      await drainMicrotasks();
      loadResolvers[0]!('old-alice');
      await drainMicrotasks();
      const second = router.restoreSessions();
      await drainMicrotasks();
      expect(loadResolvers).toHaveLength(3);

      // A new route created mid-overlap persists only through the flush of
      // the LAST restore to finish: the earlier finisher must not consume
      // the request or lift the suspension.
      const dave = await router.resolve('ch', 'dave', 'chat4');
      router.releaseRoutingLease(dave);

      loadResolvers[1]!('old-bob');
      await drainMicrotasks();
      loadResolvers[3]!('old-carol');
      await drainMicrotasks();
      loadResolvers[2]!('old-alice');
      await drainMicrotasks();
      loadResolvers[4]!('old-bob');
      await drainMicrotasks();
      loadResolvers[5]!('old-carol');

      await expect(first).resolves.toEqual({ restored: 3, failed: 0 });
      await expect(second).resolves.toEqual({ restored: 3, failed: 0 });

      // Every write holds the whole store: an earlier finisher flushing the
      // later restore's partial prefix is the truncation this guards.
      expect(mockWriteFileSync).toHaveBeenCalled();
      for (const call of mockWriteFileSync.mock.calls) {
        const written = JSON.parse(String(call[1])) as Record<
          string,
          { sessionId: string }
        >;
        expect(written['ch:alice:chat1']?.sessionId).toBe('old-alice');
        expect(written['ch:bob:chat2']?.sessionId).toBe('old-bob');
        expect(written['ch:carol:chat3']?.sessionId).toBe('old-carol');
        expect(written['ch:dave:chat4']).toBeDefined();
      }
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(Object.keys(persisted)).toHaveLength(4);
    });

    it('keeps live rotation counters when a second restore overlaps the first', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 2,
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 4 });
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );

      const first = router.restoreSessions();
      await drainMicrotasks();
      loadResolvers[0]!('old-alice');
      await drainMicrotasks();

      // A message routes onto the restored session while bob still loads:
      // its turn and lease must survive the second restore's reservation
      // pass instead of being rewound to the stale on-disk snapshot.
      expect(await router.resolve('ch', 'alice', 'chat1')).toBe('old-alice');

      const second = router.restoreSessions();
      await drainMicrotasks();
      expect(loadResolvers).toHaveLength(3);

      loadResolvers[2]!('old-alice');
      await drainMicrotasks();
      loadResolvers[1]!('old-bob');
      await drainMicrotasks();
      loadResolvers[3]!('old-bob');

      await expect(first).resolves.toEqual({ restored: 2, failed: 0 });
      await expect(second).resolves.toEqual({ restored: 2, failed: 0 });

      expect(rotationCounters(router).toTurns.get('old-alice')).toBe(3);
      expect(routingLeases(router).get('old-alice')).toBe(1);
      router.releaseRoutingLease('old-alice');

      // The last finisher's flush persisted the live counter, not the
      // snapshot's stale turns: 2.
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1'].sessionId).toBe('old-alice');
      expect(persisted['ch:alice:chat1'].turns).toBe(3);
      expect(persisted['ch:bob:chat2'].sessionId).toBe('old-bob');
    });

    it('drains a routing lease released while a restore holds the route wiped', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 2,
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );

      const first = router.restoreSessions();
      await drainMicrotasks();
      loadResolvers[0]!('old-alice');
      await expect(first).resolves.toEqual({ restored: 1, failed: 0 });

      // A message routes onto the restored session and holds its lease
      // across an unsettled shell command when a reconnect restore wipes
      // the route.
      expect(await router.resolve('ch', 'alice', 'chat1')).toBe('old-alice');

      const second = router.restoreSessions();
      await drainMicrotasks();

      // The command settles in the wipe window: its release must net
      // against the carry instead of being swallowed by the wipe and
      // re-added as a phantom lease that defers rotation forever.
      router.releaseRoutingLease('old-alice');

      loadResolvers[1]!('old-alice');
      await expect(second).resolves.toEqual({ restored: 1, failed: 0 });

      expect(routingLeases(router).has('old-alice')).toBe(false);
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(
        'old-alice',
      );
    });

    it('nets a turn uncounted mid-restore instead of rewinding to the snapshot', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 1,
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );

      const first = router.restoreSessions();
      await drainMicrotasks();
      loadResolvers[0]!('old-alice');
      await expect(first).resolves.toEqual({ restored: 1, failed: 0 });

      // A message resolves the restored session, then buffers (collect
      // mode) and settles without a turn while the next restore wipes it.
      expect(await router.resolve('ch', 'alice', 'chat1')).toBe('old-alice');

      const second = router.restoreSessions();
      await drainMicrotasks();
      router.uncountTurn('ch', 'old-alice');
      router.releaseRoutingLease('old-alice');

      loadResolvers[1]!('old-alice');
      await expect(second).resolves.toEqual({ restored: 1, failed: 0 });

      // The give-back survived the wipe window: one counted message, not
      // the snapshot's pre-decrement count re-counted by the drain.
      expect(rotationCounters(router).toTurns.get('old-alice')).toBe(1);
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1'].turns).toBe(1);
    });

    it('does not resurrect a route cleared before an overlapping restore', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );

      const first = router.restoreSessions();
      await drainMicrotasks();
      loadResolvers[0]!('old-alice');
      await drainMicrotasks();

      // /clear lands while the first restore still loads bob; the removal
      // is suspended with everything else. A reconnect READY then fires a
      // second restore against the stale pre-clear snapshot.
      router.removeSession('ch', 'alice', 'chat1');

      const second = router.restoreSessions();
      await drainMicrotasks();
      expect(loadResolvers).toHaveLength(3);

      loadResolvers[1]!('old-bob');
      await drainMicrotasks();
      loadResolvers[2]!('old-bob');

      await expect(first).resolves.toEqual({ restored: 2, failed: 0 });
      await expect(second).resolves.toEqual({ restored: 1, failed: 0 });

      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1']).toBeUndefined();
      expect(persisted['ch:bob:chat2'].sessionId).toBe('old-bob');
    });

    it('does not resurrect a rotated route when a second restore overlaps', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 3,
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );

      const restoring = router.restoreSessions();
      await drainMicrotasks();
      const waiter = router.resolve('ch', 'alice', 'chat1');
      loadResolvers[0]!('old-alice');

      // The restored session is at its bound: the waiter rotates it
      // mid-restore, retiring the key while persistence stays suspended.
      const successor = await waiter;
      router.releaseRoutingLease(successor);
      expect(successor).not.toBe('old-alice');

      // A reconnect READY fires a second restore against the stale
      // snapshot that still lists the rotated route.
      const second = router.restoreSessions();
      await drainMicrotasks();
      expect(loadResolvers).toHaveLength(3);

      loadResolvers[1]!('old-bob');
      await drainMicrotasks();
      loadResolvers[2]!('old-bob');

      await expect(restoring).resolves.toEqual({ restored: 2, failed: 0 });
      await expect(second).resolves.toEqual({ restored: 1, failed: 0 });

      expect(router.getSession('ch', 'alice', 'chat1')).toBe(successor);
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1'].sessionId).toBe(successor);
      expect(persisted['ch:bob:chat2'].sessionId).toBe('old-bob');
    });

    it('flushes the whole store when an earlier finisher dropped a key', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      const loads: Array<{
        resolve: (sessionId: string) => void;
        reject: (error: Error) => void;
      }> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve, reject) => {
            loads.push({ resolve, reject });
          }),
      );
      mockWriteFileSync.mockClear();

      const first = router.restoreSessions();
      await drainMicrotasks();
      loads[0]!.resolve('old-alice');
      await drainMicrotasks();

      // The overlap's reservation pass wipes the alice route the first
      // restore already brought back; its own alice load then fails.
      const second = router.restoreSessions();
      await drainMicrotasks();
      expect(loads).toHaveLength(3);

      loads[2]!.reject(new Error('session file gone'));
      await drainMicrotasks();
      loads[3]!.resolve('old-bob');
      await drainMicrotasks();
      loads[1]!.resolve('old-bob');

      await expect(first).resolves.toEqual({ restored: 2, failed: 0 });
      await expect(second).resolves.toEqual({ restored: 1, failed: 1 });

      // The earlier finisher's drop must reach disk through the last
      // finisher's flush even though the last one dropped nothing itself:
      // memory no longer maps alice, so the store must not keep her.
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1']).toBeUndefined();
      expect(persisted['ch:bob:chat2'].sessionId).toBe('old-bob');
    });

    it('defers a mid-restore rotation persist to the restore end flush', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-alice',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 3,
          },
          'ch:bob:chat2': {
            sessionId: 'old-bob',
            target: {
              channelName: 'ch',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/tmp',
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      const loadResolvers: Array<(sessionId: string) => void> = [];
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            loadResolvers.push(resolve);
          }),
      );
      mockWriteFileSync.mockClear();

      const restoring = router.restoreSessions();
      await drainMicrotasks();
      const waiter = router.resolve('ch', 'alice', 'chat1');
      loadResolvers[0]!('old-alice');

      // The restored session is already at its bound: the waiter rotates it
      // mid-restore. The retirement persist is suspended with everything
      // else while bob still loads; a crash in that window re-fires the
      // rotation once on the next start, per the rotateRoute contract.
      const successor = await waiter;
      router.releaseRoutingLease(successor);
      expect(successor).not.toBe('old-alice');
      expect(bridge.discardSession).toHaveBeenCalledWith('old-alice');
      expect(mockWriteFileSync).not.toHaveBeenCalled();

      loadResolvers[1]!('old-bob');
      await restoring;

      // Durability arrives with the end flush: the store is whole and the
      // retirement is kept.
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1'].sessionId).toBe(successor);
      expect(persisted['ch:alice:chat1'].turns).toBe(1);
      expect(persisted['ch:bob:chat2'].sessionId).toBe('old-bob');
    });

    it('rejects a parked waiter once the invalidation retry budget runs out', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const creations: Array<(sessionId: string) => void> = [];
      (bridge.newSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            creations.push(resolve);
          }),
      );

      // The waiter parks on someone else's in-flight creation; each dispose
      // invalidates it, and the next resolve recreates the route, leaving a
      // successor for the retry. The creators of invalidated operations
      // reject outright (creation carries no retry), so swallow theirs.
      const creator1 = router.resolve('ch', 'alice', 'chat1');
      void creator1.catch(() => undefined);
      const waiter = router.resolve('ch', 'alice', 'chat1');
      await drainMicrotasks();

      router.dispose();
      const creator2 = router.resolve('ch', 'alice', 'chat1');
      void creator2.catch(() => undefined);
      creations[0]!('session-a');
      await drainMicrotasks();

      router.dispose();
      const creator3 = router.resolve('ch', 'alice', 'chat1');
      void creator3.catch(() => undefined);
      creations[1]!('session-b');
      await drainMicrotasks();

      router.dispose();
      const creator4 = router.resolve('ch', 'alice', 'chat1');
      void creator4.catch(() => undefined);
      creations[2]!('session-c');
      await drainMicrotasks();

      router.dispose();
      const creator5 = router.resolve('ch', 'alice', 'chat1');
      creations[3]!('session-d');
      await drainMicrotasks();

      // The waiter survived three invalidations and rejects on the fourth
      // instead of parking on yet another successor.
      await expect(waiter).rejects.toThrow(
        'Session route operation was invalidated',
      );
      expect(bridge.discardSession).toHaveBeenCalledWith(
        'session-a',
        expect.anything(),
      );
      expect(bridge.discardSession).toHaveBeenCalledWith(
        'session-b',
        expect.anything(),
      );
      expect(bridge.discardSession).toHaveBeenCalledWith(
        'session-c',
        expect.anything(),
      );

      // The churn ends with the last creation: it still routes.
      creations[4]!('session-e');
      expect(await creator5).toBe('session-e');
    });

    it('routes a waiter that outlives consecutive invalidations', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const creations: Array<(sessionId: string) => void> = [];
      (bridge.newSession as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            creations.push(resolve);
          }),
      );

      // The waiter parks on someone else's in-flight creation; two disposes
      // invalidate it back to back, and it must route the third successor.
      const creator1 = router.resolve('ch', 'alice', 'chat1');
      void creator1.catch(() => undefined);
      const waiter = router.resolve('ch', 'alice', 'chat1');
      await drainMicrotasks();

      router.dispose();
      const creator2 = router.resolve('ch', 'alice', 'chat1');
      void creator2.catch(() => undefined);
      creations[0]!('session-a');
      await drainMicrotasks();

      router.dispose();
      const creator3 = router.resolve('ch', 'alice', 'chat1');
      creations[1]!('session-b');
      await drainMicrotasks();

      creations[2]!('session-c');

      expect(await waiter).toBe('session-c');
      expect(await creator3).toBe('session-c');
      // The stale results of the invalidated creations were discarded.
      expect(bridge.discardSession).toHaveBeenCalledWith(
        'session-a',
        expect.anything(),
      );
      expect(bridge.discardSession).toHaveBeenCalledWith(
        'session-b',
        expect.anything(),
      );
    });

    it('clears a bound when the channel re-registers without one', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 2 });
      const first = await routed(router, 'ch', 'alice', 'chat1');
      await routed(router, 'ch', 'alice', 'chat1'); // turns: 2, at the bound

      router.setChannelRotation('ch', undefined);
      for (let index = 0; index < 3; index++) {
        expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
      }

      router.setChannelRotation('ch', { maxTurns: 0 }); // normalized away
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
    });

    it('carries counters over an ID-changing reload', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-session',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 2,
            startedAt: Date.now(),
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });
      router.setChannelRotation('ch', { maxTurns: 3 });
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(
        'reloaded-session',
      );
      router.restoreRoutes();

      // The ID-changing reload persists once: countTurn's write subsumes the
      // carry-over, so maxTurns channels must not pay two whole-store writes.
      mockWriteFileSync.mockClear();
      const carried = await routed(router, 'ch', 'alice', 'chat1');
      expect(carried).toBe('reloaded-session');
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      // Carried turns (2) plus this message reach the bound: next rotates.
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(carried);
    });

    it('carries the start stamp over an ID-changing reload', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const stamp = Date.now() - 30 * 60 * 1000;
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-session',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 1,
            startedAt: stamp,
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });
      router.setChannelRotation('ch', { maxAgeHours: 24 });
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(
        'reloaded-session',
      );
      router.restoreRoutes();

      mockWriteFileSync.mockClear();
      await router.resolve('ch', 'alice', 'chat1');

      // Without the carry-over the reload would re-stamp 'now', silently
      // re-arming the age clock on every restart that mints a fresh ID.
      expect(rotationCounters(router).toStartedAt.get('reloaded-session')).toBe(
        stamp,
      );
      // Age-only channels keep the carry-over persist: countTurn writes
      // nothing for them, so this is the only write of the new ID + stamp.
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    });

    it('counts messages that waited on an in-flight creation', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 2 });
      let releaseCreation!: (sessionId: string) => void;
      (bridge.newSession as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise<string>((resolve) => {
          releaseCreation = resolve;
        }),
      );

      const creator = router.resolve('ch', 'alice', 'chat1');
      const waiter = router.resolve('ch', 'alice', 'chat1');
      releaseCreation('busy-session');

      expect(await creator).toBe('busy-session');
      router.releaseRoutingLease('busy-session');
      expect(await waiter).toBe('busy-session');
      // The waiter takes its own lease before returning: without it, a
      // message arriving before its turn registers could rotate the session
      // out from under it.
      expect(routingLeases(router).get('busy-session')).toBe(1);
      router.releaseRoutingLease('busy-session');

      // Creator and waiter both counted: the next message hits the bound.
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(
        'busy-session',
      );
    });

    it('persists once per routed message instead of stacking writes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 2 });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1); // creation = turn 1
      mockWriteFileSync.mockClear();

      await routed(router, 'ch', 'alice', 'chat1');
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1); // counter update
      mockWriteFileSync.mockClear();

      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
      // Rotation persists the retirement so a failed successor creation
      // cannot re-fire it after a restart; the successor creation persists
      // again.
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);

      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1'].turns).toBe(1);
    });

    it('keeps a retirement durable when the successor creation fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 1 });
      let rotations = 0;
      router.onSessionRotated(() => {
        rotations++;
      });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      (bridge.newSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('at capacity'),
      );

      // The rotation retires and persists BEFORE the successor is created;
      // the creation failure must surface without un-retiring the route.
      await expect(router.resolve('ch', 'alice', 'chat1')).rejects.toThrow(
        'at capacity',
      );
      const persisted = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(persisted['ch:alice:chat1']).toBeUndefined();

      // A restart therefore cannot restore the stale at-bound route and
      // re-fire the rotation (a second notice + discard for one rotation).
      const revived = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });
      revived.setChannelRotation('ch', { maxTurns: 1 });
      expect(revived.restoreRoutes()).toEqual({ restored: 0, dropped: 0 });

      expect(await routed(revived, 'ch', 'alice', 'chat1')).not.toBe(first);
      expect(rotations).toBe(1);
      await drainMicrotasks();
      expect(bridge.discardSession).toHaveBeenCalledTimes(1);
      expect(bridge.discardSession).toHaveBeenCalledWith(first);
    });

    it('does not write per message when only maxAgeHours is configured', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxAgeHours: 24 });

      await routed(router, 'ch', 'alice', 'chat1');
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      mockWriteFileSync.mockClear();

      await routed(router, 'ch', 'alice', 'chat1');
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('drops persisted entries with impossible rotation counters', () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const entry = {
        sessionId: 'old-session',
        target: {
          channelName: 'ch',
          senderId: 'alice',
          chatId: 'chat1',
        },
        cwd: '/tmp',
      };
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': { ...entry, turns: -3 },
          'ch:bob:chat2': { ...entry, sessionId: 's2', turns: 0.5 },
          'ch:carol:chat3': { ...entry, sessionId: 's3', startedAt: 0 },
          'ch:dave:chat4': { ...entry, sessionId: 's4', turns: 2 },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });

      expect(router.restoreRoutes()).toEqual({ restored: 1, dropped: 3 });
    });

    it('drops counters when a session is removed by ID', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 5, maxAgeHours: 24 });
      const sessionId = await routed(router, 'ch', 'alice', 'chat1');

      router.removeSessionId(sessionId);

      expect(rotationCounters(router).toTurns.size).toBe(0);
      expect(rotationCounters(router).toStartedAt.size).toBe(0);
    });

    it('drops counters when a route is removed by key', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 5, maxAgeHours: 24 });
      await routed(router, 'ch', 'alice', 'chat1');

      router.removeSession('ch', 'alice', 'chat1');

      expect(rotationCounters(router).toTurns.size).toBe(0);
      expect(rotationCounters(router).toStartedAt.size).toBe(0);
    });

    it('clears counters on dispose', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 5, maxAgeHours: 24 });
      await routed(router, 'ch', 'alice', 'chat1');

      router.dispose();

      expect(rotationCounters(router).toTurns.size).toBe(0);
      expect(rotationCounters(router).toStartedAt.size).toBe(0);
    });

    it('gives the seed count back when the first message never prompts', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 2 });

      const first = await router.resolve('ch', 'alice', 'chat1');
      router.releaseRoutingLease(first);
      // The first firing is dropped before it prompts (a skipped loop
      // firing): the uncount must give the seed count back, or the session
      // would rotate one turn early for the rest of its life.
      router.uncountTurn('ch', first);
      expect(rotationCounters(router).toTurns.has(first)).toBe(false);

      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
    });

    it('reclaims routing leases when a session is removed by ID', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sessionId = await router.resolve('ch', 'alice', 'chat1');
      expect(routingLeases(router).get(sessionId)).toBe(1);

      router.removeSessionId(sessionId);

      expect(routingLeases(router).has(sessionId)).toBe(false);
    });

    it('enforces both bounds when they are configured together', async () => {
      vi.useFakeTimers();
      try {
        const router = new SessionRouter(bridge, '/tmp');
        router.setChannelRotation('ch', { maxTurns: 10, maxAgeHours: 1 });

        const first = await routed(router, 'ch', 'alice', 'chat1');
        expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(first);

        // Only 2 of 10 turns used, but the age bound passes: the age
        // rotation must still fire on a channel that also sets maxTurns.
        vi.advanceTimersByTime(61 * 60 * 1000);
        const aged = await routed(router, 'ch', 'alice', 'chat1');
        expect(aged).not.toBe(first);

        // Symmetrically, the turns bound fires while the successor is
        // still age-fresh.
        router.setChannelRotation('ch', { maxTurns: 2, maxAgeHours: 24 });
        expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(aged);
        expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(aged);
      } finally {
        vi.useRealTimers();
      }
    });

    it('carries rotation counters over an ID-changing eager restore', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writeFileSync(
        persistPath,
        JSON.stringify({
          'ch:alice:chat1': {
            sessionId: 'old-session',
            target: {
              channelName: 'ch',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/tmp',
            turns: 2,
          },
        }),
      );
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);
      router.setChannelRotation('ch', { maxTurns: 3 });
      (bridge.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(
        'replacement-session',
      );

      await router.restoreSessions();

      // The counters follow the id loadSession resolved to, not the
      // persisted id: carried turns (2) plus this message reach the bound.
      expect(await routed(router, 'ch', 'alice', 'chat1')).toBe(
        'replacement-session',
      );
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(
        'replacement-session',
      );
      expect(rotationCounters(router).toTurns.has('old-session')).toBe(false);
    });

    it('keeps rotating when discarding the retired session throws', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      (
        bridge.discardSession as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => {
        throw new Error('connection down');
      });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);
      await drainMicrotasks();
      expect(bridge.discardSession).toHaveBeenCalledWith(first);
    });

    it('attaches a catch handler to the fire-and-forget rotation discard', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelRotation('ch', { maxTurns: 1 });
      const attachCatch = vi.fn();
      (bridge.discardSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        catch: attachCatch,
      });

      const first = await routed(router, 'ch', 'alice', 'chat1');
      expect(await routed(router, 'ch', 'alice', 'chat1')).not.toBe(first);

      // Without the catch handler a rejected close RPC becomes an unhandled
      // rejection, taking the channel process down after the retirement
      // already landed.
      expect(attachCatch).toHaveBeenCalledOnce();
    });
  });
  describe('clearAll', () => {
    it('clears all in-memory state', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      await router.resolve('ch', 'alice', 'chat1');
      router.clearAll();
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
      expect(router.getAll()).toEqual([]);
    });
  });

  describe('setBridge', () => {
    it('replaces the bridge instance', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const newBridge = mockBridge();
      router.setBridge(newBridge);
      await router.resolve('ch', 'alice', 'chat1');
      expect(newBridge.newSession).toHaveBeenCalled();
      expect(bridge.newSession).not.toHaveBeenCalled();
    });
  });

  describe('lazy recovery', () => {
    it('rejects route restoration outside lazy recovery mode', () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const router = new SessionRouter(bridge, '/tmp', 'user', persistPath);

      expect(() => router.restoreRoutes()).toThrow(
        'restoreRoutes requires lazy recovery mode',
      );
    });

    function createLazyRouter(persistPath: string, customBridge = bridge) {
      return new SessionRouter(customBridge, '/tmp', 'user', persistPath, {
        recoveryMode: 'lazy',
      });
    }

    it('restores route metadata without loading daemon sessions', () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const router = createLazyRouter(persistPath);

      expect(router.restoreRoutes()).toEqual({ restored: 1, dropped: 0 });
      expect(bridge.loadSession).not.toHaveBeenCalled();
      expect(router.getSession('ch', 'alice', 'chat1')).toBe('old-session');
    });

    it('loads a dormant route once and then reuses the live binding', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const router = createLazyRouter(persistPath);
      router.restoreRoutes();

      await expect(router.resolve('ch', 'alice', 'chat1')).resolves.toBe(
        'old-session',
      );
      await expect(router.resolve('ch', 'alice', 'chat1')).resolves.toBe(
        'old-session',
      );
      expect(bridge.loadSession).toHaveBeenCalledTimes(1);
      expect(bridge.newSession).not.toHaveBeenCalled();
    });

    it('coalesces concurrent loads for one dormant route', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      let finishLoad!: (value: string) => void;
      const lazyBridge = {
        ...mockBridge(),
        loadSession: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              finishLoad = resolve;
            }),
        ),
      } satisfies ChannelAgentBridge;
      const router = createLazyRouter(persistPath, lazyBridge);
      router.restoreRoutes();

      const first = router.resolve('ch', 'alice', 'chat1');
      const second = router.resolve('ch', 'alice', 'chat1');
      await Promise.resolve();
      finishLoad('old-session');

      await expect(Promise.all([first, second])).resolves.toEqual([
        'old-session',
        'old-session',
      ]);
      expect(lazyBridge.loadSession).toHaveBeenCalledTimes(1);
    });

    it('discards a daemon client created after an absent route is cleared', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const detach = vi.fn().mockResolvedValue(undefined);
      const session = daemonSession('late-session', detach);
      let finishFactory!: (session: DaemonChannelSessionClient) => void;
      const daemonBridge = new DaemonChannelBridge({
        cwd: '/tmp',
        sessionFactory: vi.fn(
          () =>
            new Promise<DaemonChannelSessionClient>((resolve) => {
              finishFactory = resolve;
            }),
        ),
      });
      const sessionDied = vi.fn();
      daemonBridge.on('sessionDied', sessionDied);
      await daemonBridge.start();
      const router = createLazyRouter(persistPath, daemonBridge);

      const resolving = router.resolve('ch', 'alice', 'chat1');
      await Promise.resolve();
      router.removeSession('ch', 'alice', 'chat1');
      finishFactory(session);

      await expect(resolving).rejects.toThrow('invalidated');
      expect(daemonBridge.listSessions()).toEqual([]);
      expect(detach).toHaveBeenCalledOnce();
      expect(session.cancel).not.toHaveBeenCalled();
      expect(sessionDied).not.toHaveBeenCalled();
      await daemonBridge.discardSession('late-session');
      expect(detach).toHaveBeenCalledOnce();
    });

    it('discards a loaded daemon client after its dormant route is cleared', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const session = daemonSession('old-session');
      let finishFactory!: (session: DaemonChannelSessionClient) => void;
      const daemonBridge = new DaemonChannelBridge({
        cwd: '/tmp',
        sessionFactory: vi.fn(
          () =>
            new Promise<DaemonChannelSessionClient>((resolve) => {
              finishFactory = resolve;
            }),
        ),
      });
      await daemonBridge.start();
      const router = createLazyRouter(persistPath, daemonBridge);
      router.restoreRoutes();

      const resolving = router.resolve('ch', 'alice', 'chat1');
      await Promise.resolve();
      router.removeSession('ch', 'alice', 'chat1');
      finishFactory(session);

      await expect(resolving).rejects.toThrow('invalidated');
      expect(daemonBridge.listSessions()).toEqual([]);
      expect(session.cancel).toHaveBeenCalledOnce();
    });

    it('falls back to cancel when detach fails for an invalidated replacement', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const detach = vi.fn().mockRejectedValue(new Error('detach failed'));
      const session = daemonSession('replacement-session', detach);
      let finishFactory!: (session: DaemonChannelSessionClient) => void;
      const factory = vi
        .fn()
        .mockRejectedValueOnce(new Error('gone'))
        .mockImplementationOnce(
          () =>
            new Promise<DaemonChannelSessionClient>((resolve) => {
              finishFactory = resolve;
            }),
        );
      const daemonBridge = new DaemonChannelBridge({
        cwd: '/tmp',
        sessionFactory: factory,
      });
      await daemonBridge.start();
      const router = createLazyRouter(persistPath, daemonBridge);
      router.restoreRoutes();

      const resolving = router.resolve('ch', 'alice', 'chat1');
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      router.removeSession('ch', 'alice', 'chat1');
      finishFactory(session);

      await expect(resolving).rejects.toThrow('invalidated');
      expect(daemonBridge.listSessions()).toEqual([]);
      expect(detach).toHaveBeenCalledOnce();
      expect(session.cancel).toHaveBeenCalledOnce();
    });

    it('does not discard a same-id binding owned by another in-flight route', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const firstSession = daemonSession('shared-session');
      const secondDetach = vi.fn().mockResolvedValue(undefined);
      const secondSession = daemonSession('shared-session', secondDetach);
      const finishFactories: Array<
        (session: DaemonChannelSessionClient) => void
      > = [];
      const daemonBridge = new DaemonChannelBridge({
        cwd: '/tmp',
        sessionFactory: vi.fn(
          () =>
            new Promise<DaemonChannelSessionClient>((resolve) => {
              finishFactories.push(resolve);
            }),
        ),
      });
      await daemonBridge.start();
      const router = createLazyRouter(persistPath, daemonBridge);

      const first = router.resolve('ch', 'alice', 'chat1');
      const second = router.resolve('ch', 'bob', 'chat2');
      await drainMicrotasks();
      expect(finishFactories).toHaveLength(2);
      router.removeSession('ch', 'alice', 'chat1');
      finishFactories[0]!(firstSession);
      finishFactories[1]!(secondSession);

      await expect(first).rejects.toThrow('invalidated');
      await expect(second).resolves.toBe('shared-session');
      expect(router.getSession('ch', 'bob', 'chat2')).toBe('shared-session');
      expect(daemonBridge.listSessions()).toEqual([
        {
          sessionId: 'shared-session',
          workspaceCwd: '/tmp',
          hasActivePrompt: false,
        },
      ]);
      expect(secondDetach).not.toHaveBeenCalled();

      daemonBridge.stop();
    });

    it.each(['detach', 'cancel'] as const)(
      'does not wait for a hanging %s while rejecting invalidated creation',
      async (cleanup) => {
        const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
        tempDirs.push(dir);
        const persistPath = join(dir, 'routes.json');
        const neverSettles = vi.fn(() => new Promise<void>(() => undefined));
        const session = daemonSession(
          'late-session',
          cleanup === 'detach' ? neverSettles : undefined,
        );
        if (cleanup === 'cancel') {
          session.cancel = neverSettles;
        }
        let finishFactory!: (session: DaemonChannelSessionClient) => void;
        const daemonBridge = new DaemonChannelBridge({
          cwd: '/tmp',
          sessionFactory: vi.fn(
            () =>
              new Promise<DaemonChannelSessionClient>((resolve) => {
                finishFactory = resolve;
              }),
          ),
        });
        await daemonBridge.start();
        const router = createLazyRouter(persistPath, daemonBridge);

        let rejection: unknown;
        const resolving = router.resolve('ch', 'alice', 'chat1');
        void resolving.catch((error: unknown) => {
          rejection = error;
        });
        await drainMicrotasks();
        router.removeSession('ch', 'alice', 'chat1');
        finishFactory(session);
        await drainMicrotasks();

        expect(rejection).toEqual(
          expect.objectContaining({
            message: 'Session route operation was invalidated',
          }),
        );
        expect(neverSettles).toHaveBeenCalledOnce();
        expect(daemonBridge.listSessions()).toEqual([]);
      },
    );

    it('discards invalidated bindings despite an unrelated hung operation', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const finishFactories: Array<
        (session: DaemonChannelSessionClient) => void
      > = [];
      const factory = vi.fn(() => {
        if (factory.mock.calls.length === 1) {
          return new Promise<DaemonChannelSessionClient>(() => undefined);
        }
        return new Promise<DaemonChannelSessionClient>((resolve) => {
          finishFactories.push(resolve);
        });
      });
      const daemonBridge = new DaemonChannelBridge({
        cwd: '/tmp',
        sessionFactory: factory,
      });
      await daemonBridge.start();
      const router = createLazyRouter(persistPath, daemonBridge);

      const hung = router.resolve('ch', 'hung', 'hung-chat');
      void hung.catch(() => undefined);
      const first = router.resolve('ch', 'alice', 'chat1');
      const second = router.resolve('ch', 'bob', 'chat2');
      await drainMicrotasks();
      expect(factory).toHaveBeenCalledTimes(3);
      expect(finishFactories).toHaveLength(2);
      router.removeSession('ch', 'alice', 'chat1');
      router.removeSession('ch', 'bob', 'chat2');
      finishFactories[0]!(daemonSession('late-alice'));
      finishFactories[1]!(daemonSession('late-bob'));

      await expect(first).rejects.toThrow('invalidated');
      await expect(second).rejects.toThrow('invalidated');
      await drainMicrotasks();
      expect(daemonBridge.listSessions()).toEqual([]);

      router.dispose();
      expect(daemonBridge.listSessions()).toEqual([]);
    });

    it.each(['removeSession', 'removeSessionId'] as const)(
      'rejects a dormant load invalidated by %s',
      async (removal) => {
        const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
        tempDirs.push(dir);
        const persistPath = join(dir, 'routes.json');
        writePersistedSession(persistPath, 'ch:alice:chat1');
        let finishLoad!: (value: string) => void;
        const lazyBridge = {
          ...mockBridge(),
          loadSession: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                finishLoad = resolve;
              }),
          ),
        } satisfies ChannelAgentBridge;
        const router = createLazyRouter(persistPath, lazyBridge);
        router.restoreRoutes();

        const resolving = router.resolve('ch', 'alice', 'chat1');
        await Promise.resolve();
        if (removal === 'removeSession') {
          router.removeSession('ch', 'alice', 'chat1');
        } else {
          router.removeSessionId('old-session');
        }
        finishLoad('old-session');

        await expect(resolving).rejects.toThrow('invalidated');
        expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
        expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
      },
    );

    it('does not install a replacement created after route removal', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      let finishCreation!: (value: string) => void;
      const lazyBridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockRejectedValue(new Error('gone')),
        newSession: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              finishCreation = resolve;
            }),
        ),
      } satisfies ChannelAgentBridge;
      const router = createLazyRouter(persistPath, lazyBridge);
      router.restoreRoutes();

      const resolving = router.resolve('ch', 'alice', 'chat1');
      await vi.waitFor(() => expect(lazyBridge.newSession).toHaveBeenCalled());
      router.removeSession('ch', 'alice', 'chat1');
      finishCreation('replacement-session');

      await expect(resolving).rejects.toThrow('invalidated');
      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      expect(router.getTarget('replacement-session')).toBeUndefined();
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
    });

    it('does not retry an invalidated shared recovery operation', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      let failLoad!: (error: Error) => void;
      const lazyBridge = {
        ...mockBridge(),
        loadSession: vi.fn(
          () =>
            new Promise<string>((_resolve, reject) => {
              failLoad = reject;
            }),
        ),
        newSession: vi.fn().mockResolvedValue('replacement-session'),
      } satisfies ChannelAgentBridge;
      const router = createLazyRouter(persistPath, lazyBridge);
      router.restoreRoutes();

      const first = router.resolve('ch', 'alice', 'chat1');
      const second = router.resolve('ch', 'alice', 'chat1');
      await Promise.resolve();
      router.removeSession('ch', 'alice', 'chat1');
      failLoad(new Error('gone'));

      await expect(first).rejects.toThrow('invalidated');
      await expect(second).rejects.toThrow('invalidated');
      expect(lazyBridge.loadSession).toHaveBeenCalledTimes(1);
      expect(lazyBridge.newSession).not.toHaveBeenCalled();
      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
    });

    it('does not install an absent route created after its removal', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      let finishCreation!: (value: string) => void;
      const lazyBridge = {
        ...mockBridge(),
        newSession: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              finishCreation = resolve;
            }),
        ),
      } satisfies ChannelAgentBridge;
      const router = createLazyRouter(persistPath, lazyBridge);

      const resolving = router.resolve('ch', 'alice', 'chat1');
      await Promise.resolve();
      expect(router.removeSession('ch', 'alice', 'chat1')).toEqual([]);
      finishCreation('late-session');

      await expect(resolving).rejects.toThrow('invalidated');
      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      expect(router.getTarget('late-session')).toBeUndefined();
      expect(existsSync(persistPath)).toBe(false);
    });

    it.each(['dormant load', 'absent creation'] as const)(
      'rejects a late %s after disposal',
      async (operation) => {
        const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
        tempDirs.push(dir);
        const persistPath = join(dir, 'routes.json');
        let finish!: (value: string) => void;
        const lazyBridge = {
          ...mockBridge(),
          loadSession: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                finish = resolve;
              }),
          ),
          newSession: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                finish = resolve;
              }),
          ),
        } satisfies ChannelAgentBridge;
        const router = createLazyRouter(persistPath, lazyBridge);
        if (operation === 'dormant load') {
          writePersistedSession(persistPath, 'ch:alice:chat1');
          router.restoreRoutes();
        }

        const resolving = router.resolve('ch', 'alice', 'chat1');
        await Promise.resolve();
        router.dispose();
        finish(operation === 'dormant load' ? 'old-session' : 'late-session');

        await expect(resolving).rejects.toThrow('invalidated');
        expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
        expect(router.getAll()).toEqual([]);
      },
    );

    it('replaces a route only after fallback creation succeeds', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const lazyBridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockRejectedValue(new Error('gone')),
        newSession: vi.fn().mockResolvedValue('replacement-session'),
      } satisfies ChannelAgentBridge;
      const router = createLazyRouter(persistPath, lazyBridge);
      router.restoreRoutes();

      await expect(router.resolve('ch', 'alice', 'chat1')).resolves.toBe(
        'replacement-session',
      );
      // Load-failure replacement also stamps the channel name as sourceId.
      expect(lazyBridge.newSession).toHaveBeenCalledWith(
        '/tmp',
        { sourceId: 'ch' },
        expect.any(Object),
      );
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:alice:chat1': expect.objectContaining({
          sessionId: 'replacement-session',
        }),
      });
    });

    it('retains the dormant route when load and fallback creation both fail', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const lazyBridge = {
        ...mockBridge(),
        loadSession: vi.fn().mockRejectedValue(new Error('temporarily gone')),
        newSession: vi.fn().mockRejectedValue(new Error('at capacity')),
      } satisfies ChannelAgentBridge;
      const router = createLazyRouter(persistPath, lazyBridge);
      router.restoreRoutes();

      await expect(router.resolve('ch', 'alice', 'chat1')).rejects.toThrow(
        'at capacity',
      );
      expect(router.getSession('ch', 'alice', 'chat1')).toBe('old-session');
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({
        'ch:alice:chat1': expect.objectContaining({ sessionId: 'old-session' }),
      });
    });

    it('marks a dead lazy session dormant and reloads it on next resolve', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const router = createLazyRouter(persistPath);
      router.restoreRoutes();
      await router.resolve('ch', 'alice', 'chat1');

      expect(router.handleSessionDied('old-session')).toBe(true);
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(true);
      await router.resolve('ch', 'alice', 'chat1');

      expect(bridge.loadSession).toHaveBeenCalledTimes(2);
    });

    it('does not eagerly load route counts above the daemon live-session cap', () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      const entries = Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [
          `ch:user-${index}:chat-${index}`,
          {
            sessionId: `old-${index}`,
            target: {
              channelName: 'ch',
              senderId: `user-${index}`,
              chatId: `chat-${index}`,
            },
            cwd: '/tmp',
          },
        ]),
      );
      writeFileSync(persistPath, JSON.stringify(entries));
      const router = createLazyRouter(persistPath);

      expect(router.restoreRoutes()).toEqual({ restored: 25, dropped: 0 });
      expect(bridge.loadSession).not.toHaveBeenCalled();
    });

    it('clears a dormant route destructively', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-router-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'routes.json');
      writePersistedSession(persistPath, 'ch:alice:chat1');
      const router = createLazyRouter(persistPath);
      router.restoreRoutes();

      expect(router.removeSession('ch', 'alice', 'chat1')).toEqual([
        'old-session',
      ]);
      expect(JSON.parse(readFileSync(persistPath, 'utf-8'))).toEqual({});
      await expect(router.resolve('ch', 'alice', 'chat1')).resolves.toBe(
        'session-1',
      );
      expect(bridge.loadSession).not.toHaveBeenCalled();
    });

    it('keeps eager session-death behavior as the default', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sessionId = await router.resolve('ch', 'alice', 'chat1');

      expect(router.handleSessionDied(sessionId)).toBe(true);
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
    });
  });
});
