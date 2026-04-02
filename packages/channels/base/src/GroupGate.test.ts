import { describe, it, expect } from 'vitest';
import { GroupGate } from './GroupGate.js';
import type { Envelope } from './types.js';

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    channelName: 'test',
    senderId: 'user1',
    senderName: 'User',
    chatId: 'chat1',
    text: 'hello',
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
    ...overrides,
  };
}

describe('GroupGate', () => {
  describe('non-group messages', () => {
    it('always allows DM messages regardless of policy', () => {
      for (const policy of ['disabled', 'allowlist', 'open'] as const) {
        const gate = new GroupGate(policy);
        expect(gate.check(envelope()).allowed).toBe(true);
      }
    });
  });

  describe('disabled policy', () => {
    it('rejects all group messages', () => {
      const gate = new GroupGate('disabled');
      const result = gate.check(envelope({ isGroup: true }));
      expect(result).toEqual({ allowed: false, reason: 'disabled' });
    });
  });

  describe('allowlist policy', () => {
    it('rejects groups not in allowlist', () => {
      const gate = new GroupGate('allowlist', { other: {} });
      const result = gate.check(envelope({ isGroup: true }));
      expect(result).toEqual({ allowed: false, reason: 'not_allowlisted' });
    });

    it('does not treat "*" as wildcard allow', () => {
      const gate = new GroupGate('allowlist', { '*': {} });
      const result = gate.check(envelope({ isGroup: true }));
      expect(result).toEqual({ allowed: false, reason: 'not_allowlisted' });
    });

    it('allows explicitly listed group with mention', () => {
      const gate = new GroupGate('allowlist', { chat1: {} });
      const result = gate.check(envelope({ isGroup: true, isMentioned: true }));
      expect(result.allowed).toBe(true);
    });

    it('requires mention by default for allowlisted group', () => {
      const gate = new GroupGate('allowlist', { chat1: {} });
      const result = gate.check(envelope({ isGroup: true }));
      expect(result).toEqual({ allowed: false, reason: 'mention_required' });
    });

    it('allows reply-to-bot as alternative to mention', () => {
      const gate = new GroupGate('allowlist', { chat1: {} });
      const result = gate.check(
        envelope({ isGroup: true, isReplyToBot: true }),
      );
      expect(result.allowed).toBe(true);
    });

    it('respects requireMention=false override', () => {
      const gate = new GroupGate('allowlist', {
        chat1: { requireMention: false },
      });
      const result = gate.check(envelope({ isGroup: true }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('open policy', () => {
    it('allows any group with mention', () => {
      const gate = new GroupGate('open');
      const result = gate.check(envelope({ isGroup: true, isMentioned: true }));
      expect(result.allowed).toBe(true);
    });

    it('requires mention by default', () => {
      const gate = new GroupGate('open');
      const result = gate.check(envelope({ isGroup: true }));
      expect(result).toEqual({ allowed: false, reason: 'mention_required' });
    });

    it('uses "*" as default config fallback', () => {
      const gate = new GroupGate('open', { '*': { requireMention: false } });
      const result = gate.check(envelope({ isGroup: true }));
      expect(result.allowed).toBe(true);
    });

    it('per-group config overrides "*" default', () => {
      const gate = new GroupGate('open', {
        '*': { requireMention: false },
        chat1: { requireMention: true },
      });
      const result = gate.check(envelope({ isGroup: true }));
      expect(result).toEqual({ allowed: false, reason: 'mention_required' });
    });
  });

  describe('defaults', () => {
    it('defaults to disabled policy', () => {
      const gate = new GroupGate();
      const result = gate.check(envelope({ isGroup: true }));
      expect(result).toEqual({ allowed: false, reason: 'disabled' });
    });
  });
});
