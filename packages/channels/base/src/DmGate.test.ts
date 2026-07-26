import { describe, it, expect } from 'vitest';
import { DmGate } from './DmGate.js';
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

describe('DmGate', () => {
  describe('group messages', () => {
    it('always allows group messages regardless of policy', () => {
      for (const policy of ['disabled', 'open'] as const) {
        const gate = new DmGate(policy);
        expect(gate.check(envelope({ isGroup: true })).allowed).toBe(true);
      }
    });
  });

  describe('disabled policy', () => {
    it('rejects all DM messages', () => {
      const gate = new DmGate('disabled');
      const result = gate.check(envelope());
      expect(result).toEqual({ allowed: false, reason: 'disabled' });
    });
  });

  describe('open policy', () => {
    it('allows all DM messages', () => {
      const gate = new DmGate('open');
      const result = gate.check(envelope());
      expect(result.allowed).toBe(true);
    });
  });

  describe('defaults', () => {
    it('defaults to open policy', () => {
      const gate = new DmGate();
      const result = gate.check(envelope());
      expect(result.allowed).toBe(true);
    });
  });
});
