import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRouter } from './SessionRouter.js';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';

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

describe('SessionRouter', () => {
  let bridge: ChannelAgentBridge;
  let tempDirs: string[] = [];

  beforeEach(() => {
    sessionCounter = 0;
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
      expect(bridge.newSession).toHaveBeenCalledWith('/custom');
    });

    it('uses defaultCwd when no cwd provided', async () => {
      const router = new SessionRouter(bridge, '/default');
      await router.resolve('ch', 'alice', 'chat1');
      expect(bridge.newSession).toHaveBeenCalledWith('/default');
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
        'Session died before routing completed',
      );

      expect(newSession).toHaveBeenCalledTimes(2);
      expect(router.getSession('ch', 'alice', 'chat1')).toBeUndefined();
      expect(router.getTarget('dead-session')).toBeUndefined();
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

    it('returns false for non-existing session', () => {
      const router = new SessionRouter(bridge, '/tmp');
      expect(router.hasSession('ch', 'alice', 'chat1')).toBe(false);
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

    it('returns empty array when nothing to remove', () => {
      const router = new SessionRouter(bridge, '/tmp');
      expect(router.removeSession('ch', 'alice', 'chat1')).toEqual([]);
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
  });

  describe('restoreSessions', () => {
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
});
