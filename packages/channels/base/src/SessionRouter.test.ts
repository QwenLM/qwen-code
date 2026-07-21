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

const mockRenameSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      mockRenameSync(from, to);
      return actual.renameSync(from, to);
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

    it('thread scope: different chatIds with same threadId get different sessions', async () => {
      const router = new SessionRouter(bridge, '/tmp', 'thread');
      const s1 = await router.resolve('ch', 'alice', 'repo-a', 'issue:42');
      const s2 = await router.resolve('ch', 'alice', 'repo-b', 'issue:42');
      expect(s1).not.toBe(s2);
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
        { approvalMode: 'yolo' },
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
        undefined,
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
