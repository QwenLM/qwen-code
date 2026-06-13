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
