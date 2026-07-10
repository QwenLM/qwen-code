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

  // -----------------------------------------------------------------------
  // Task 1.2: Argon2id hashing, qwk_ prefix, issuedAt, max-age, revokeAll
  // -----------------------------------------------------------------------

  it('issued token has qwk_ prefix', async () => {
    const store = await TokenStore.open(path);
    const { token } = await store.issue([SESSION_READ], 'phone');
    expect(token).toMatch(/^qwk_/);
  });

  it('token with qwk_ prefix still resolves correctly', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    expect(token.startsWith('qwk_')).toBe(true);
    expect(store.resolve(`Bearer ${token}`)).toMatchObject({ id });
  });

  it('on-disk file stores argon2id hash, not sha256 hex, not raw token', async () => {
    const store = await TokenStore.open(path);
    const { token } = await store.issue([SESSION_READ], 'phone');
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain(token);
    // argon2id self-describing format: starts with "argon2id$"
    expect(onDisk).toContain('argon2id$');
    // must NOT be a 64-char sha256 hex
    expect(onDisk).not.toMatch(/"tokenHash"\s*:\s*"[0-9a-f]{64}"/);
  });

  it('issue sets issuedAt on the TokenRecord and list() surfaces it', async () => {
    const now = 1_700_000_000_000;
    const store = await TokenStore.open(path, () => now);
    const { id } = await store.issue([SESSION_READ], 'phone');
    const info = store.list().find((t) => t.id === id);
    expect(info).toBeDefined();
    expect(info!.issuedAt).toBe(now);
    expect(info!.createdAt).toBe(now);
  });

  it('issuedAt is never slid by resolve (verify does not mutate issuedAt)', async () => {
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    now = 2_000_000;
    // resolve/verify is read-only; issuedAt stays at mint time
    store.resolve(`Bearer ${token}`);
    const info = store.list().find((t) => t.id === id)!;
    expect(info.issuedAt).toBe(1_000_000);
  });

  it('verifyTokenDetailed returns { ok: true } for a valid token', async () => {
    const store = await TokenStore.open(path);
    const { token } = await store.issue([SESSION_READ], 'phone');
    const result = store.verifyTokenDetailed(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBeDefined();
  });

  it('verifyTokenDetailed returns { ok: false, reason: "not_found" } for unknown token', async () => {
    const store = await TokenStore.open(path);
    const result = store.verifyTokenDetailed('qwk_notarealtoken');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('verifyTokenDetailed returns { ok: false, reason: "revoked" } for revoked token', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    await store.revoke(id);
    const result = store.verifyTokenDetailed(token);
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('verifyTokenDetailed returns token_expired_max_age when past issuedAt + maxTokenAgeDays', async () => {
    const DAY_MS = 86_400_000;
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const { token } = await store.issue([SESSION_READ], 'phone');
    // Advance past the 180-day default ceiling
    now = 1_000_000 + 181 * DAY_MS;
    const result = store.verifyTokenDetailed(token, { nowMs: now });
    expect(result).toEqual({ ok: false, reason: 'token_expired_max_age' });
  });

  it('verifyTokenDetailed respects a custom maxTokenAgeDays', async () => {
    const DAY_MS = 86_400_000;
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const { token } = await store.issue([SESSION_READ], 'phone');
    // 10 days later, within 30-day default but past custom 7-day ceiling
    now = 1_000_000 + 8 * DAY_MS;
    const result = store.verifyTokenDetailed(token, {
      nowMs: now,
      maxTokenAgeDays: 7,
    });
    expect(result).toEqual({ ok: false, reason: 'token_expired_max_age' });
  });

  it('verifyTokenDetailed: not yet at max-age ceiling → ok: true', async () => {
    const DAY_MS = 86_400_000;
    let now = 1_000_000;
    const store = await TokenStore.open(path, () => now);
    const { token } = await store.issue([SESSION_READ], 'phone');
    now = 1_000_000 + 179 * DAY_MS;
    const result = store.verifyTokenDetailed(token, { nowMs: now });
    expect(result.ok).toBe(true);
  });

  it('revokeAll removes all tokens', async () => {
    const store = await TokenStore.open(path);
    const a = await store.issue([SESSION_READ], 'a');
    const b = await store.issue([SESSION_READ], 'b');
    const { revokedIds } = await store.revokeAll();
    expect(revokedIds.sort()).toEqual([a.id, b.id].sort());
    expect(store.list()).toHaveLength(0);
    expect(store.resolve(`Bearer ${a.token}`)).toBeNull();
    expect(store.resolve(`Bearer ${b.token}`)).toBeNull();
  });

  it('revokeAll with exceptTokenId spares that token', async () => {
    const store = await TokenStore.open(path);
    const a = await store.issue([SESSION_READ], 'a');
    const b = await store.issue([SESSION_READ], 'b');
    const c = await store.issue([SESSION_READ], 'c');
    const { revokedIds } = await store.revokeAll({ exceptTokenId: b.id });
    expect(revokedIds).not.toContain(b.id);
    expect(revokedIds.sort()).toEqual([a.id, c.id].sort());
    // b still resolves; a and c do not
    expect(store.resolve(`Bearer ${b.token}`)).not.toBeNull();
    expect(store.resolve(`Bearer ${a.token}`)).toBeNull();
    expect(store.resolve(`Bearer ${c.token}`)).toBeNull();
  });

  it('revokeAll persists: revoked tokens gone after reopen', async () => {
    const store = await TokenStore.open(path);
    const a = await store.issue([SESSION_READ], 'a');
    await store.revokeAll();
    const reopened = await TokenStore.open(path);
    expect(reopened.list()).toHaveLength(0);
    expect(reopened.resolve(`Bearer ${a.token}`)).toBeNull();
  });

  it('revokeAll returns empty array when no tokens exist', async () => {
    const store = await TokenStore.open(path);
    const { revokedIds } = await store.revokeAll();
    expect(revokedIds).toEqual([]);
  });

  it('revokeAll with exceptTokenId returns empty when only the excepted token exists', async () => {
    const store = await TokenStore.open(path);
    const a = await store.issue([SESSION_READ], 'a');
    const { revokedIds } = await store.revokeAll({ exceptTokenId: a.id });
    expect(revokedIds).toEqual([]);
    expect(store.resolve(`Bearer ${a.token}`)).not.toBeNull();
  });

  it('argon2id tokens persist across reopen and still resolve', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    const reopened = await TokenStore.open(path);
    const result = reopened.resolve(`Bearer ${token}`);
    expect(result).toMatchObject({ id, scopes: [SESSION_READ] });
  });
});

// ---------------------------------------------------------------------------
// TokenStore cors_origins operations
// ---------------------------------------------------------------------------

describe('TokenStore cors_origins operations', () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'rc-cors-store-')), 'tokens.json');
  });

  it('fresh store has empty listOrigins', async () => {
    const store = await TokenStore.open(path);
    expect(store.listOrigins()).toEqual([]);
  });

  it('admitOrigin persists and listOrigins returns it with source db', async () => {
    const store = await TokenStore.open(path);
    const rec = await store.admitOrigin('https://app.example.com', 'tok_1');
    expect(rec.origin).toBe('https://app.example.com');
    expect(rec.source).toBe('db');
    expect(rec.admittedByTokenId).toBe('tok_1');
    const listed = store.listOrigins();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.origin).toBe('https://app.example.com');
    expect(listed[0]?.source).toBe('db');
  });

  it('admitOrigin upserts (re-admitting same origin refreshes token id)', async () => {
    const store = await TokenStore.open(path);
    await store.admitOrigin('https://app.example.com', 'tok_1');
    await store.admitOrigin('https://app.example.com', 'tok_2');
    const listed = store.listOrigins();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.admittedByTokenId).toBe('tok_2');
  });

  it('listOrigins merges config entries with source config and null token/timestamp', async () => {
    const store = await TokenStore.open(path);
    await store.admitOrigin('https://db.example.com', 'tok_1');
    const listed = store.listOrigins(['https://config.example.com']);
    expect(listed).toHaveLength(2);
    const cfg = listed.find((r) => r.origin === 'https://config.example.com');
    expect(cfg?.source).toBe('config');
    expect(cfg?.admittedByTokenId).toBeNull();
    expect(cfg?.admittedAt).toBeNull();
  });

  it('when an origin is in both db and config, it appears once as config', async () => {
    const store = await TokenStore.open(path);
    await store.admitOrigin('https://both.example.com', 'tok_1');
    const listed = store.listOrigins(['https://both.example.com']);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.source).toBe('config');
  });

  it('removeOrigin on a db-admitted origin removes it', async () => {
    const store = await TokenStore.open(path);
    await store.admitOrigin('https://app.example.com', 'tok_1');
    const result = await store.removeOrigin('https://app.example.com');
    expect(result).toEqual({ removed: true });
    expect(store.listOrigins()).toHaveLength(0);
    // idempotent: second remove returns notFound
    const result2 = await store.removeOrigin('https://app.example.com');
    expect(result2).toEqual({ notFound: true });
  });

  it('removeOrigin on a config-sourced origin returns conflict:config', async () => {
    const store = await TokenStore.open(path);
    const cfg = ['https://config.example.com'];
    const result = await store.removeOrigin('https://config.example.com', cfg);
    expect(result).toEqual({ conflict: 'config' });
    // still listed
    expect(store.listOrigins(cfg)).toHaveLength(1);
  });

  it('removeOrigin on an unknown origin returns notFound', async () => {
    const store = await TokenStore.open(path);
    const result = await store.removeOrigin('https://never.example.com');
    expect(result).toEqual({ notFound: true });
  });

  it('cors_origins persist across reopen', async () => {
    const store = await TokenStore.open(path);
    await store.admitOrigin('https://app.example.com', 'tok_1');
    const reopened = await TokenStore.open(path);
    const listed = reopened.listOrigins();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.origin).toBe('https://app.example.com');
    expect(listed[0]?.source).toBe('db');
  });

  it('removing an origin persists across reopen', async () => {
    const store = await TokenStore.open(path);
    await store.admitOrigin('https://app.example.com', 'tok_1');
    await store.removeOrigin('https://app.example.com');
    const reopened = await TokenStore.open(path);
    expect(reopened.listOrigins()).toHaveLength(0);
  });
});
