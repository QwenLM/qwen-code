/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { TokenStore } from './tokenStore.js';
import { bearerResolve, requireScope } from './auth.js';
import { SESSION_READ } from './scopes.js';

function fakeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe('auth middleware', () => {
  let store: TokenStore;
  beforeEach(async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rc-auth-')), 'tokens.json');
    store = await TokenStore.open(path);
  });

  it('bearerResolve attaches rcClient for a valid token', async () => {
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = fakeRes();
    let called = false;
    bearerResolve(store)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.rcClient).toEqual({ id, scopes: [SESSION_READ] });
  });

  it('bearerResolve 401s a missing/invalid token', () => {
    const req = { headers: {} } as Request;
    const res = fakeRes();
    let called = false;
    bearerResolve(store)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ code: 'unauthorized' });
  });

  it('requireScope passes when the scope is present', () => {
    const req = { rcClient: { id: 'x', scopes: [SESSION_READ] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('requireScope 403s when the scope is absent', () => {
    const req = { rcClient: { id: 'x', scopes: [] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ code: 'insufficient_scope' });
  });
});
