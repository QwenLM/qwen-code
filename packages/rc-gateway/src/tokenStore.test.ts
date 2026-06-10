/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from './tokenStore.js';
import { SESSION_READ, SHARE, APPROVE } from './scopes.js';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rc-tokens-')), 'tokens.json');
}

describe('TokenStore', () => {
  let path: string;
  beforeEach(() => {
    path = freshPath();
  });

  it('issues a token that resolves to its id and scopes', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    expect(token).toMatch(/.{20,}/);
    const resolved = store.resolve(`Bearer ${token}`);
    expect(resolved).toEqual({ id, scopes: [SESSION_READ] });
  });

  it('returns null for an unknown or malformed bearer', async () => {
    const store = await TokenStore.open(path);
    await store.issue([SESSION_READ], 'phone');
    expect(store.resolve('Bearer not-a-real-token')).toBeNull();
    expect(store.resolve('')).toBeNull();
    expect(store.resolve('Basic abc')).toBeNull();
  });

  it('never stores the raw token, only a sha256 hash', async () => {
    const store = await TokenStore.open(path);
    const { token } = await store.issue([SESSION_READ], 'phone');
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain(token);
  });

  it('persists tokens across reopen', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    const reopened = await TokenStore.open(path);
    expect(reopened.resolve(`Bearer ${token}`)).toEqual({
      id,
      scopes: [SESSION_READ],
    });
  });

  it('writes the token file with 0600 permissions', async () => {
    const store = await TokenStore.open(path);
    await store.issue([SESSION_READ], 'phone');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('lists issued tokens as metadata only (no hash, no raw token)', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      scopes: [SESSION_READ],
      label: 'phone',
    });
    expect(typeof list[0].createdAt).toBe('number');
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('tokenHash');
  });

  it('revokes a token by id: removes it, persists, stops resolving', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    expect(await store.revoke(id)).toBe(true);
    expect(store.resolve(`Bearer ${token}`)).toBeNull();
    const reopened = await TokenStore.open(path);
    expect(reopened.list()).toHaveLength(0);
    expect(reopened.resolve(`Bearer ${token}`)).toBeNull();
  });

  it('revoke returns false for an unknown id', async () => {
    const store = await TokenStore.open(path);
    await store.issue([SESSION_READ], 'phone');
    expect(await store.revoke('does-not-exist')).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it('scopesFor returns a copy of a known token id scopes; undefined otherwise', async () => {
    const store = await TokenStore.open(path);
    const { id } = await store.issue([SESSION_READ], 'phone');
    const scopes = store.scopesFor(id);
    expect(scopes).toEqual([SESSION_READ]);
    // Returned array is a copy: mutating it must not affect the store.
    scopes!.push('owner');
    expect(store.scopesFor(id)).toEqual([SESSION_READ]);
    expect(store.scopesFor('does-not-exist')).toBeUndefined();
  });

  it('a normal issue token resolves with sessionLockId undefined', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    expect(store.resolve(`Bearer ${token}`)).toEqual({
      id,
      scopes: [SESSION_READ],
    });
    // Explicitly: no lock leaks onto a normal token.
    expect(store.resolve(`Bearer ${token}`)?.sessionLockId).toBeUndefined();
  });

  it('issueShare stamps expiresAt, sessionLockId, and parentId', async () => {
    const now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    expect(share.expiresAt).toBe(1_000_000 + 3600 * 1000);
    expect(typeof share.id).toBe('string');
    expect(share.token.length).toBeGreaterThan(20);

    const list = store.listShares();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: share.id,
      label: 'guest',
      scopes: [SHARE, SESSION_READ],
      sessionLockId: 's1',
      expiresAt: share.expiresAt,
      parentId: 'owner-1',
      expired: false,
    });
  });

  it('resolve of a not-yet-expired share returns scopes + sessionLockId', async () => {
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    now = 1_000_000 + 60 * 1000; // 1 minute later, still valid
    expect(store.resolve(`Bearer ${share.token}`)).toEqual({
      id: share.id,
      scopes: [SHARE, SESSION_READ, APPROVE],
      sessionLockId: 's1',
      shareLabel: 'guest',
    });
  });

  it('resolve surfaces shareLabel for a share, never for a normal token', async () => {
    const store = await TokenStore.open(path);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'review for Sam',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    expect(store.resolve(`Bearer ${share.token}`)?.shareLabel).toBe(
      'review for Sam',
    );
    const normal = await store.issue([SESSION_READ], 'phone');
    expect(store.resolve(`Bearer ${normal.token}`)?.shareLabel).toBeUndefined();
  });

  it('resolve of an expired share returns null (strict >= at expiresAt)', async () => {
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    // Exactly at expiresAt is already expired (strict >=).
    now = share.expiresAt;
    expect(store.resolve(`Bearer ${share.token}`)).toBeNull();
    // Well past expiry stays expired.
    now = share.expiresAt + 10_000;
    expect(store.resolve(`Bearer ${share.token}`)).toBeNull();
  });

  it('listShares returns only share records, with expired computed', async () => {
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    await store.issue([SESSION_READ], 'normal'); // not a share — excluded
    const a = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'short',
      sessionLockId: 's1',
      ttlSec: 60,
      parentId: 'owner-1',
    });
    const b = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'long',
      sessionLockId: 's2',
      ttlSec: 7200,
      parentId: 'owner-1',
    });
    now = a.expiresAt; // a is now expired, b is not
    const shares = store.listShares();
    expect(shares).toHaveLength(2);
    const byId = Object.fromEntries(shares.map((s) => [s.id, s]));
    expect(byId[a.id].expired).toBe(true);
    expect(byId[b.id].expired).toBe(false);
    // Never leaks secret material.
    const serialized = JSON.stringify(shares);
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain(a.token);
  });

  it('scopesFor drops an expired share (no push delivery after TTL)', async () => {
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    expect(store.scopesFor(share.id)).toEqual([SHARE, SESSION_READ, APPROVE]);
    now = share.expiresAt; // expired (strict >=)
    expect(store.scopesFor(share.id)).toBeUndefined();
  });

  it('sessionLockFor returns the lock for a share and undefined for a normal token', async () => {
    const store = await TokenStore.open(path);
    const normal = await store.issue([SESSION_READ], 'normal');
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    expect(store.sessionLockFor(share.id)).toBe('s1');
    expect(store.sessionLockFor(normal.id)).toBeUndefined();
    expect(store.sessionLockFor('does-not-exist')).toBeUndefined();
  });

  it('issueShare stamps maxUses + uses:0; listShares surfaces usesRemaining', async () => {
    const store = await TokenStore.open(path);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
      maxUses: 5,
    });
    expect(store.listShares()[0]).toMatchObject({
      id: share.id,
      maxUses: 5,
      uses: 0,
      usesRemaining: 5,
    });
  });

  it('consumeUse bumps uses and returns usesRemaining; exhausts at maxUses', async () => {
    const store = await TokenStore.open(path);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
      maxUses: 2,
    });
    expect(await store.consumeUse(share.id)).toEqual({
      ok: true,
      usesRemaining: 1,
    });
    expect(await store.consumeUse(share.id)).toEqual({
      ok: true,
      usesRemaining: 0,
    });
    // Third redemption is rejected; uses does not advance past maxUses.
    expect(await store.consumeUse(share.id)).toEqual({
      ok: false,
      reason: 'exhausted',
    });
    expect(store.listShares()[0]).toMatchObject({ uses: 2, usesRemaining: 0 });
  });

  it('consumeUse on an unlimited share (no maxUses) always succeeds, usesRemaining null', async () => {
    const store = await TokenStore.open(path);
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    expect(await store.consumeUse(share.id)).toEqual({
      ok: true,
      usesRemaining: null,
    });
    expect(await store.consumeUse(share.id)).toEqual({
      ok: true,
      usesRemaining: null,
    });
    expect(store.listShares()[0]).toMatchObject({
      uses: 2,
      maxUses: undefined,
      usesRemaining: null,
    });
  });

  it('consumeUse on an unknown id → not_found', async () => {
    const store = await TokenStore.open(path);
    expect(await store.consumeUse('nope')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('a share record persisted without a uses field reads as 0 (no NaN)', async () => {
    // Simulate a pre-cycle-26 record: write tokens.json by hand with no `uses`.
    const path2 = freshPath();
    const rec = {
      id: 'sh1',
      tokenHash: 'a'.repeat(64),
      scopes: [SHARE, SESSION_READ],
      label: 'old',
      createdAt: 1,
      expiresAt: 10_000_000_000_000,
      sessionLockId: 's1',
      parentId: 'owner-1',
      maxUses: 3,
      // NOTE: deliberately no `uses` field.
    };
    writeFileSync(path2, JSON.stringify({ tokens: [rec] }));
    const store = await TokenStore.open(path2);
    expect(store.listShares()[0]).toMatchObject({ uses: 0, usesRemaining: 3 });
    expect(await store.consumeUse('sh1')).toEqual({
      ok: true,
      usesRemaining: 2,
    });
  });
});
