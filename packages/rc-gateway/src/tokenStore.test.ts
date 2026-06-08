/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from './tokenStore.js';
import { SESSION_READ } from './scopes.js';

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
});
