import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRouter } from './SessionRouter.js';
import type { AcpBridge } from './AcpBridge.js';

let sessionCounter = 0;

function mockBridge(): AcpBridge {
  return {
    newSession: vi.fn().mockImplementation(() => `session-${++sessionCounter}`),
    loadSession: vi.fn().mockImplementation((id: string) => id),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    availableCommands: [],
  } as unknown as AcpBridge;
}

describe('SessionRouter', () => {
  let bridge: AcpBridge;

  beforeEach(() => {
    sessionCounter = 0;
    bridge = mockBridge();
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

    it('cleans up target mapping after removal', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sid = await router.resolve('ch', 'alice', 'chat1');
      router.removeSession('ch', 'alice', 'chat1');
      expect(router.getTarget(sid)).toBeUndefined();
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

    it('preserves persist file for restoration on next start', async () => {
      const { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } =
        await import('node:fs');
      const { join } = await import('node:path');
      const tmpDir = join('/tmp', `test-cleara11-persist-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      const persistFile = join(tmpDir, 'sessions.json');
      const originalEntries = {
        'telegram:alice:chat1': {
          sessionId: 'session-xyz',
          target: {
            channelName: 'telegram',
            senderId: 'alice',
            chatId: 'chat1',
          },
          cwd: '/workspace',
        },
      };

      try {
        // Create a router, write a session, then clearAll
        const router = new SessionRouter(bridge, '/tmp', 'user', persistFile);
        await router.resolve('telegram', 'alice', 'chat1');

        // Populate the persist file with known data
        writeFileSync(persistFile, JSON.stringify(originalEntries, null, 2));

        router.clearAll();

        // Memory should be cleared
        expect(router.hasSession('telegram', 'alice', 'chat1')).toBe(false);
        expect(router.getAll()).toEqual([]);

        // Persist file should still exist with original content
        expect(existsSync(persistFile)).toBe(true);
        const onDisk = JSON.parse(readFileSync(persistFile, 'utf-8'));
        expect(onDisk).toEqual(originalEntries);

        // A fresh router should be able to restore from it
        const freshRouter = new SessionRouter(
          bridge,
          '/tmp',
          'user',
          persistFile,
        );
        const result = await freshRouter.restoreSessions();

        expect(result.restored).toBe(1);
        expect(result.failed).toBe(0);
        expect(freshRouter.hasSession('telegram', 'alice', 'chat1')).toBe(true);
        expect(freshRouter.getTarget('session-xyz')).toEqual({
          channelName: 'telegram',
          senderId: 'alice',
          chatId: 'chat1',
        });
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
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

  describe('restoreSessions', () => {
    it('restores sessions from persist file', async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tmpDir = join('/tmp', `test-restore-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        const persistFile = join(tmpDir, 'sessions.json');
        const entries = {
          'telegram:alice:chat1': {
            sessionId: 'old-session-1',
            target: {
              channelName: 'telegram',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/workspace',
          },
          'telegram:bob:chat2': {
            sessionId: 'old-session-2',
            target: {
              channelName: 'telegram',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/workspace',
          },
        };
        writeFileSync(persistFile, JSON.stringify(entries, null, 2));

        const router = new SessionRouter(bridge, '/tmp', 'user', persistFile);
        const result = await router.restoreSessions();

        expect(result.restored).toBe(2);
        expect(result.failed).toBe(0);
        expect(bridge.loadSession).toHaveBeenCalledTimes(2);
        expect(router.hasSession('telegram', 'alice', 'chat1')).toBe(true);
        expect(router.hasSession('telegram', 'bob', 'chat2')).toBe(true);

        const target = router.getTarget('old-session-1');
        expect(target).toEqual({
          channelName: 'telegram',
          senderId: 'alice',
          chatId: 'chat1',
        });
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('skips entries whose loadSession throws', async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tmpDir = join('/tmp', `test-restore-fail-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        const persistFile = join(tmpDir, 'sessions.json');
        const entries = {
          'telegram:alice:chat1': {
            sessionId: 'good-session',
            target: {
              channelName: 'telegram',
              senderId: 'alice',
              chatId: 'chat1',
            },
            cwd: '/workspace',
          },
          'telegram:bob:chat2': {
            sessionId: 'stale-session',
            target: {
              channelName: 'telegram',
              senderId: 'bob',
              chatId: 'chat2',
            },
            cwd: '/workspace',
          },
        };
        writeFileSync(persistFile, JSON.stringify(entries, null, 2));

        // Make loadSession throw for the stale session
        (bridge.loadSession as ReturnType<typeof vi.fn>).mockImplementation(
          (id: string) => {
            if (id === 'stale-session') {
              throw new Error('Session not found');
            }
            return id;
          },
        );

        const router = new SessionRouter(bridge, '/tmp', 'user', persistFile);
        const result = await router.restoreSessions();

        expect(result.restored).toBe(1);
        expect(result.failed).toBe(1);
        expect(router.hasSession('telegram', 'alice', 'chat1')).toBe(true);
        expect(router.hasSession('telegram', 'bob', 'chat2')).toBe(false);

        // Persist file should be updated to remove the failed entry
        const { readFileSync } = await import('node:fs');
        const updated = JSON.parse(readFileSync(persistFile, 'utf-8'));
        expect(Object.keys(updated)).toEqual(['telegram:alice:chat1']);
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('returns zeros when no persist file exists', async () => {
      const router = new SessionRouter(
        bridge,
        '/tmp',
        'user',
        '/nonexistent/sessions.json',
      );
      const result = await router.restoreSessions();
      expect(result).toEqual({ restored: 0, failed: 0 });
    });

    it('returns zeros when persist file is empty', async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const tmpDir = join('/tmp', `test-restore-empty-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        const persistFile = join(tmpDir, 'sessions.json');
        writeFileSync(persistFile, '{}');

        const router = new SessionRouter(bridge, '/tmp', 'user', persistFile);
        const result = await router.restoreSessions();

        expect(result).toEqual({ restored: 0, failed: 0 });
        expect(bridge.loadSession).not.toHaveBeenCalled();
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });
  });
});
