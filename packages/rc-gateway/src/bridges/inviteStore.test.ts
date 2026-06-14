/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { InviteStore } from './inviteStore.js';

describe('InviteStore', () => {
  it('mints an inv_-prefixed token and redeems it to the bound session', () => {
    const store = new InviteStore();
    const { token } = store.mint('telegram', 'sess_42');
    expect(token.startsWith('inv_')).toBe(true);
    expect(store.redeem(token)).toEqual({
      kind: 'telegram',
      sessionId: 'sess_42',
    });
  });

  it('is single-use — a second redeem of the same token fails', () => {
    const store = new InviteStore();
    const { token } = store.mint('discord', 'sess_1');
    expect(store.redeem(token)).not.toBeNull();
    expect(store.redeem(token)).toBeNull();
  });

  it('rejects an unknown token', () => {
    const store = new InviteStore();
    expect(store.redeem('inv_nope')).toBeNull();
  });

  it('rejects an expired token (and still burns it)', () => {
    let now = 1000;
    const store = new InviteStore(() => now, 60_000);
    const { token, expiresAt } = store.mint('matrix', 'sess_x');
    expect(expiresAt).toBe(61_000);
    now = 61_001; // just past expiry
    expect(store.redeem(token)).toBeNull();
    // burned even though it was expired: a later (impossible) in-window retry still fails
    now = 500;
    expect(store.redeem(token)).toBeNull();
  });

  it('mints unique tokens', () => {
    const store = new InviteStore();
    const a = store.mint('telegram', 's').token;
    const b = store.mint('telegram', 's').token;
    expect(a).not.toBe(b);
  });

  it('carries kind through for audit but does not constrain redemption', () => {
    const store = new InviteStore();
    const { token } = store.mint('discord', 'sess_9');
    // redeem returns the recorded kind; the store itself never gates on it.
    expect(store.redeem(token)?.kind).toBe('discord');
  });
});
