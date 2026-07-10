/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PairingService } from './pairing.js';
import { SESSION_READ } from './scopes.js';

describe('PairingService', () => {
  it('mints a code that redeems to its grant scopes', () => {
    const now = 1000;
    const svc = new PairingService(() => now);
    const { code, expiresAt } = svc.mint([SESSION_READ]);
    expect(code).toMatch(/.{6,}/);
    expect(expiresAt).toBeGreaterThan(now);
    expect(svc.redeem(code)).toEqual({
      grantScopes: [SESSION_READ],
      allowOrigin: false,
    });
  });

  it('mints codes with arbitrary grant sets (including empty)', () => {
    const svc = new PairingService(() => 0);
    const { code } = svc.mint([]);
    expect(svc.redeem(code)).toEqual({ grantScopes: [], allowOrigin: false });
  });

  it('allowOrigin defaults to false and can be set to true', () => {
    const svc = new PairingService(() => 0);
    const { code: c1 } = svc.mint([SESSION_READ]);
    expect(svc.redeem(c1)?.allowOrigin).toBe(false);
    const { code: c2 } = svc.mint([SESSION_READ], { allowOrigin: true });
    expect(svc.redeem(c2)?.allowOrigin).toBe(true);
  });

  it('is single-use: a redeemed code cannot be redeemed again', () => {
    const svc = new PairingService(() => 0);
    const { code } = svc.mint([SESSION_READ]);
    expect(svc.redeem(code)).not.toBeNull();
    expect(svc.redeem(code)).toBeNull();
  });

  it('rejects an expired code', () => {
    let now = 0;
    const svc = new PairingService(() => now);
    const { code, expiresAt } = svc.mint([SESSION_READ]);
    now = expiresAt + 1;
    expect(svc.redeem(code)).toBeNull();
  });

  it('rejects an unknown code', () => {
    const svc = new PairingService(() => 0);
    expect(svc.redeem('nope')).toBeNull();
  });
});
