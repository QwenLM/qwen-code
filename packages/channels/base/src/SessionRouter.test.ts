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

    it('does not collide on sender IDs with shared prefix', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      const sidA = await router.resolve('ch', 'user1', 'chat1');
      const sidB = await router.resolve('ch', 'user12', 'chat1');

      // hasSession must distinguish 'user1' from 'user12'
      expect(router.hasSession('ch', 'user1')).toBe(true);
      expect(router.hasSession('ch', 'user12')).toBe(true);

      // Removing 'user1' must NOT touch 'user12'
      const removed = router.removeSession('ch', 'user1');
      expect(removed).toEqual([sidA]);
      expect(router.hasSession('ch', 'user1')).toBe(false);
      expect(router.hasSession('ch', 'user12')).toBe(true);
      expect(router.getTarget(sidB)).toBeDefined();
    });

    it('finds and removes sessions under thread scope without senderId in key', async () => {
      const router = new SessionRouter(bridge, '/tmp');
      router.setChannelScope('ch', 'thread');
      const sid = await router.resolve('ch', 'alice', 'chat1', 'thread-1');

      // Under thread scope, the key is `ch:thread-1` — no senderId.
      // hasSession/removeSession by senderId must still find it via target metadata.
      expect(router.hasSession('ch', 'alice')).toBe(true);
      const removed = router.removeSession('ch', 'alice');
      expect(removed).toEqual([sid]);
      expect(router.hasSession('ch', 'alice')).toBe(false);
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
