/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { splitPemChain, loadAcmeLib } from './acmeClient.js';

const CERT = (tag: string) =>
  `-----BEGIN CERTIFICATE-----\n${tag}\n-----END CERTIFICATE-----`;

describe('splitPemChain', () => {
  it('treats a lone certificate as the leaf with an empty chain', () => {
    const { leaf, chain } = splitPemChain(`${CERT('leaf')}\n`);
    expect(leaf.trim()).toBe(CERT('leaf'));
    expect(chain).toBe('');
  });

  it('splits a fullchain into leaf + issuer chain', () => {
    const full = `${CERT('leaf')}\n${CERT('issuer')}\n`;
    const { leaf, chain } = splitPemChain(full);
    expect(leaf.trim()).toBe(CERT('leaf'));
    expect(chain.trim()).toBe(CERT('issuer'));
  });

  it('keeps every intermediate in the chain', () => {
    const full = `${CERT('leaf')}\n${CERT('int1')}\n${CERT('root')}\n`;
    const { chain } = splitPemChain(full);
    expect(chain).toContain('int1');
    expect(chain).toContain('root');
    expect(chain).not.toContain('leaf');
  });
});

describe('loadAcmeLib', () => {
  it('fails with an actionable message when acme-client is not installed', async () => {
    // acme-client is an OPTIONAL dep, not in the base install — so this exercises
    // the missing-dependency path and its install hint.
    await expect(loadAcmeLib()).rejects.toThrow(/acme-client/);
  });
});
