/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import {
  SESSION_READ,
  APPROVE,
  WRITE,
  OWNER,
  BRIDGE,
  expandScopes,
  SCOPE_IMPLIES,
  hasScope,
} from './scopes.js';

describe('toolchain smoke', () => {
  it('defines the session:read scope', () => {
    expect(SESSION_READ).toBe('session:read');
  });

  // Proves vitest can resolve the dual CJS/ESM @qwen-code/sdk workspace dep
  // NOW, rather than discovering an interop break four tasks later.
  it('can import DaemonClient from @qwen-code/sdk', () => {
    expect(DaemonClient).toBeTypeOf('function');
  });
});

describe('expandScopes (bridge → concrete bundle)', () => {
  it('expands `bridge` to {bridge, session:read, approve, write}', () => {
    expect(expandScopes([BRIDGE]).sort()).toEqual(
      [BRIDGE, SESSION_READ, APPROVE, WRITE].sort(),
    );
  });

  it('retains the bridge marker (so the subActor gate can test for it)', () => {
    expect(expandScopes([BRIDGE])).toContain(BRIDGE);
  });

  it('leaves a non-bridge request unchanged (deduped)', () => {
    expect(expandScopes([SESSION_READ])).toEqual([SESSION_READ]);
    expect(expandScopes([OWNER, SESSION_READ, OWNER]).sort()).toEqual(
      [OWNER, SESSION_READ].sort(),
    );
  });

  it('is idempotent and does not add bridge to a plain owner grant', () => {
    const owner = [OWNER, SESSION_READ, APPROVE, WRITE];
    expect(expandScopes(owner).sort()).toEqual([...owner].sort());
    expect(expandScopes(owner)).not.toContain(BRIDGE);
  });

  it('dedupes when bridge is requested alongside its implied scopes', () => {
    const out = expandScopes([BRIDGE, APPROVE]);
    expect(out.filter((s) => s === APPROVE)).toHaveLength(1);
    expect(out.sort()).toEqual([BRIDGE, SESSION_READ, APPROVE, WRITE].sort());
  });
});

describe('SCOPE_IMPLIES map', () => {
  it('owner directly implies write, approve, and session:read', () => {
    expect(SCOPE_IMPLIES[OWNER]).toContain(WRITE);
    expect(SCOPE_IMPLIES[OWNER]).toContain(APPROVE);
    expect(SCOPE_IMPLIES[OWNER]).toContain(SESSION_READ);
  });

  it('write directly implies session:read', () => {
    expect(SCOPE_IMPLIES[WRITE]).toContain(SESSION_READ);
  });

  it('approve directly implies session:read', () => {
    expect(SCOPE_IMPLIES[APPROVE]).toContain(SESSION_READ);
  });

  it('session:read implies nothing further', () => {
    expect(SCOPE_IMPLIES[SESSION_READ]).toEqual([]);
  });

  it('write does NOT imply approve (send-prompt ≠ vote)', () => {
    expect(SCOPE_IMPLIES[WRITE]).not.toContain(APPROVE);
  });

  it('approve does NOT imply write', () => {
    expect(SCOPE_IMPLIES[APPROVE]).not.toContain(WRITE);
  });
});

describe('hasScope (transitive implication)', () => {
  it('owner confers write transitively', () => {
    expect(hasScope([OWNER], WRITE)).toBe(true);
  });

  it('owner confers approve transitively', () => {
    expect(hasScope([OWNER], APPROVE)).toBe(true);
  });

  it('owner confers session:read transitively (via write→read chain)', () => {
    expect(hasScope([OWNER], SESSION_READ)).toBe(true);
  });

  it('write confers session:read transitively', () => {
    expect(hasScope([WRITE], SESSION_READ)).toBe(true);
  });

  it('approve confers session:read transitively', () => {
    expect(hasScope([APPROVE], SESSION_READ)).toBe(true);
  });

  it('session:read only confers session:read', () => {
    expect(hasScope([SESSION_READ], SESSION_READ)).toBe(true);
    expect(hasScope([SESSION_READ], WRITE)).toBe(false);
    expect(hasScope([SESSION_READ], APPROVE)).toBe(false);
    expect(hasScope([SESSION_READ], OWNER)).toBe(false);
  });

  it('write does NOT confer approve', () => {
    expect(hasScope([WRITE], APPROVE)).toBe(false);
  });

  it('approve does NOT confer write', () => {
    expect(hasScope([APPROVE], WRITE)).toBe(false);
  });

  it('empty grant confers nothing', () => {
    expect(hasScope([], SESSION_READ)).toBe(false);
    expect(hasScope([], OWNER)).toBe(false);
  });

  it('multiple grants are unioned before expansion', () => {
    expect(hasScope([WRITE, APPROVE], APPROVE)).toBe(true);
    expect(hasScope([WRITE, APPROVE], SESSION_READ)).toBe(true);
  });
});
