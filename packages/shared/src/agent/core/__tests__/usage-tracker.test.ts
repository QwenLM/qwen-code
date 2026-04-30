/**
 * Tests for UsageTracker
 *
 * Tests the token usage and context window tracking
 * used by backend agents.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  UsageTracker,
  createUsageTracker,
} from '../usage-tracker.ts';

describe('UsageTracker', () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = new UsageTracker({
      contextWindow: 200000, // 200k context
    });
  });

  describe('Message Usage Tracking', () => {
    it('should start with no usage', () => {
      expect(tracker.getLastMessageUsage()).toBe(null);
      expect(tracker.getCurrentInputTokens()).toBe(0);
    });

    it('should record message usage', () => {
      tracker.recordMessageUsage({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
      });

      const usage = tracker.getLastMessageUsage();
      expect(usage).not.toBe(null);
      expect(usage!.inputTokens).toBe(1300); // 1000 + 200 + 100
      expect(usage!.outputTokens).toBe(500);
      expect(usage!.cacheReadTokens).toBe(200);
      expect(usage!.cacheCreationTokens).toBe(100);
    });

    it('should handle missing optional fields', () => {
      tracker.recordMessageUsage({
        inputTokens: 1000,
      });

      const usage = tracker.getLastMessageUsage();
      expect(usage!.inputTokens).toBe(1000);
      expect(usage!.outputTokens).toBe(0);
      expect(usage!.cacheReadTokens).toBe(0);
    });

    it('should return current input tokens', () => {
      tracker.recordMessageUsage({
        inputTokens: 5000,
        cacheReadTokens: 1000,
        cacheCreationTokens: 500,
      });
      expect(tracker.getCurrentInputTokens()).toBe(6500);
    });
  });

  describe('Session Usage Tracking', () => {
    it('should start with zero session totals', () => {
      const session = tracker.getSessionUsage();
      expect(session.totalInputTokens).toBe(0);
      expect(session.totalOutputTokens).toBe(0);
      expect(session.messageCount).toBe(0);
    });

    it('should accumulate usage on turn complete', () => {
      tracker.recordMessageUsage({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
      });
      tracker.recordTurnComplete();

      tracker.recordMessageUsage({
        inputTokens: 2000,
        outputTokens: 800,
        cacheReadTokens: 300,
      });
      tracker.recordTurnComplete();

      const session = tracker.getSessionUsage();
      expect(session.totalInputTokens).toBe(3500); // (1000+200) + (2000+300)
      expect(session.totalOutputTokens).toBe(1300);
      expect(session.messageCount).toBe(2);
    });

    it('should accept explicit usage on turn complete', () => {
      tracker.recordTurnComplete({
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadTokens: 500,
      });

      const session = tracker.getSessionUsage();
      expect(session.totalInputTokens).toBe(5000);
      expect(session.totalOutputTokens).toBe(2000);
      expect(session.totalCacheReadTokens).toBe(500);
    });
  });

  describe('Context Window', () => {
    it('should return configured context window', () => {
      expect(tracker.getContextWindow()).toBe(200000);
    });

    it('should allow updating context window', () => {
      tracker.setContextWindow(100000);
      expect(tracker.getContextWindow()).toBe(100000);
    });

    it('should calculate context usage percentage', () => {
      tracker.recordMessageUsage({ inputTokens: 50000 });
      expect(tracker.getContextUsagePercent()).toBe(25); // 50k / 200k
    });

    it('should return undefined percentage when no context window set', () => {
      const noContextTracker = new UsageTracker();
      noContextTracker.recordMessageUsage({ inputTokens: 1000 });
      expect(noContextTracker.getContextUsagePercent()).toBe(undefined);
    });

    it('should detect filling context (> 80%)', () => {
      tracker.recordMessageUsage({ inputTokens: 170000 }); // 85%
      expect(tracker.isContextFilling()).toBe(true);

      tracker.recordMessageUsage({ inputTokens: 100000 }); // 50%
      expect(tracker.isContextFilling()).toBe(false);
    });

    it('should detect critical context (> 95%)', () => {
      tracker.recordMessageUsage({ inputTokens: 196000 }); // 98%
      expect(tracker.isContextCritical()).toBe(true);

      tracker.recordMessageUsage({ inputTokens: 180000 }); // 90%
      expect(tracker.isContextCritical()).toBe(false);
    });
  });

  describe('Cache Efficiency', () => {
    it('should calculate cache hit rate', () => {
      tracker.recordTurnComplete({
        inputTokens: 8000,
        outputTokens: 1000,
        cacheReadTokens: 2000, // 2k of 8k from cache = 25%
      });

      expect(tracker.getCacheHitRate()).toBe(0.25);
    });

    it('should return 0 cache hit rate when no usage', () => {
      expect(tracker.getCacheHitRate()).toBe(0);
    });

    it('should accumulate cache stats across turns', () => {
      tracker.recordTurnComplete({
        inputTokens: 5000,
        outputTokens: 500,
        cacheReadTokens: 1000,
      });
      tracker.recordTurnComplete({
        inputTokens: 5000,
        outputTokens: 500,
        cacheReadTokens: 3000,
      });

      // Total: 10k input, 4k cache read = 40%
      expect(tracker.getCacheHitRate()).toBe(0.4);
    });
  });

  describe('Usage Updates', () => {
    it('should build usage update object', () => {
      tracker.recordMessageUsage({
        inputTokens: 50000,
        outputTokens: 1000,
        cacheReadTokens: 10000,
      });
      tracker.recordTurnComplete();

      const update = tracker.buildUsageUpdate();
      expect(update.inputTokens).toBe(60000); // 50k + 10k cache
      expect(update.contextWindow).toBe(200000);
      expect(update.cacheHitRate).toBeGreaterThan(0);
    });

    it('should call onUsageUpdate callback', () => {
      const updates: any[] = [];
      const callbackTracker = new UsageTracker({
        contextWindow: 100000,
        onUsageUpdate: (update) => updates.push(update),
      });

      callbackTracker.recordMessageUsage({ inputTokens: 1000 });
      expect(updates.length).toBe(1);
      expect(updates[0].inputTokens).toBe(1000);
    });
  });

  describe('Reset', () => {
    it('should reset all tracking state', () => {
      // Build up some state
      tracker.recordMessageUsage({
        inputTokens: 5000,
        outputTokens: 1000,
      });
      tracker.recordTurnComplete();
      tracker.recordTurnComplete({
        inputTokens: 3000,
        outputTokens: 500,
      });

      // Reset
      tracker.reset();

      expect(tracker.getLastMessageUsage()).toBe(null);
      expect(tracker.getCurrentInputTokens()).toBe(0);

      const session = tracker.getSessionUsage();
      expect(session.totalInputTokens).toBe(0);
      expect(session.messageCount).toBe(0);
    });

    it('should preserve context window on reset', () => {
      tracker.reset();
      expect(tracker.getContextWindow()).toBe(200000);
    });
  });

  describe('Factory Function', () => {
    it('should create tracker via factory', () => {
      const factoryTracker = createUsageTracker({
        contextWindow: 50000,
      });
      expect(factoryTracker.getContextWindow()).toBe(50000);
    });

    it('should create tracker with default config', () => {
      const defaultTracker = createUsageTracker();
      expect(defaultTracker).toBeInstanceOf(UsageTracker);
    });
  });
});
