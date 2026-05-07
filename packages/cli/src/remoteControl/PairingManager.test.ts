/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PairingManager } from './PairingManager.js';

describe('PairingManager', () => {
  it('verifies pairing tokens without storing the raw token', () => {
    const manager = new PairingManager();
    const { token } = manager.createPairingToken();

    expect(manager.verifyPairingToken(token)).toBe(true);
    expect(manager.verifyPairingToken(token)).toBe(false);
    expect(manager.verifyPairingToken('wrong-token')).toBe(false);
  });

  it('expires pairing tokens and client tokens', () => {
    vi.useFakeTimers();
    try {
      const manager = new PairingManager();
      const pairing = manager.createPairingToken(1000);
      const client = manager.issueClientToken(1000);

      expect(manager.verifyClientToken(client.token)).toBe(true);

      vi.advanceTimersByTime(1001);

      expect(manager.verifyPairingToken(pairing.token)).toBe(false);
      expect(manager.verifyClientToken(client.token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
