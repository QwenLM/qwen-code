import { describe, it, expect, vi } from 'vitest';
import { SenderGate } from './SenderGate.js';
import type { PairingStore } from './PairingStore.js';

function mockPairingStore(overrides: Partial<PairingStore> = {}): PairingStore {
  return {
    isApproved: vi.fn().mockReturnValue(false),
    createRequest: vi.fn().mockReturnValue('ABCD1234'),
    approve: vi.fn(),
    listPending: vi.fn().mockReturnValue([]),
    getAllowlist: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as PairingStore;
}

describe('SenderGate', () => {
  describe('open policy', () => {
    it('allows any sender', () => {
      const gate = new SenderGate('open');
      expect(gate.check('anyone').allowed).toBe(true);
    });
  });

  describe('allowlist policy', () => {
    it('allows listed users', () => {
      const gate = new SenderGate('allowlist', ['alice', 'bob']);
      expect(gate.check('alice').allowed).toBe(true);
    });

    it('rejects unlisted users', () => {
      const gate = new SenderGate('allowlist', ['alice']);
      const result = gate.check('eve');
      expect(result.allowed).toBe(false);
      expect(result.pairingCode).toBeUndefined();
    });

    it('works with empty allowlist', () => {
      const gate = new SenderGate('allowlist');
      expect(gate.check('anyone').allowed).toBe(false);
    });
  });

  describe('pairing policy', () => {
    it('allows static allowlisted users without checking store', () => {
      const store = mockPairingStore();
      const gate = new SenderGate('pairing', ['admin'], store);
      const result = gate.check('admin');
      expect(result.allowed).toBe(true);
      expect(store.isApproved).not.toHaveBeenCalled();
    });

    it('allows dynamically approved users', () => {
      const store = mockPairingStore({
        isApproved: vi.fn().mockReturnValue(true),
      });
      const gate = new SenderGate('pairing', [], store);
      expect(gate.check('user1').allowed).toBe(true);
    });

    it('generates pairing code for unknown sender', () => {
      const store = mockPairingStore({
        createRequest: vi.fn().mockReturnValue('XYZW5678'),
      });
      const gate = new SenderGate('pairing', [], store);
      const result = gate.check('stranger', 'Stranger Name');
      expect(result.allowed).toBe(false);
      expect(result.pairingCode).toBe('XYZW5678');
      expect(store.createRequest).toHaveBeenCalledWith(
        'stranger',
        'Stranger Name',
      );
    });

    it('returns null pairingCode when cap reached', () => {
      const store = mockPairingStore({
        createRequest: vi.fn().mockReturnValue(null),
      });
      const gate = new SenderGate('pairing', [], store);
      const result = gate.check('stranger');
      expect(result.allowed).toBe(false);
      expect(result.pairingCode).toBeNull();
    });

    it('uses senderId as senderName fallback', () => {
      const store = mockPairingStore();
      const gate = new SenderGate('pairing', [], store);
      gate.check('user42');
      expect(store.createRequest).toHaveBeenCalledWith('user42', 'user42');
    });

    it('works without pairing store (no store provided)', () => {
      const gate = new SenderGate('pairing');
      const result = gate.check('anyone');
      expect(result.allowed).toBe(false);
      expect(result.pairingCode).toBeNull();
    });
  });

  describe('unknown policy', () => {
    it('throws on unknown policy', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gate = new SenderGate('unknown' as any);
      expect(() => gate.check('user')).toThrow('Unknown sender policy');
    });
  });
});
