/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { synapseRegisterMac, registerViaSharedSecret } from './synapseAdmin.js';

describe('synapseRegisterMac', () => {
  // Known-answer vectors (computed with Synapse's documented algorithm:
  // HMAC-SHA1 over nonce\0user\0password\0("admin"|"notadmin")).
  it('matches the reference HMAC for a non-admin user', () => {
    expect(
      synapseRegisterMac('itsecret', 'abc123', 'qwenbot', 'pw', false),
    ).toBe('dc6abc7e3d9a9e6292e169d4386be22ad56bc679');
  });

  it('matches the reference HMAC for an admin user', () => {
    expect(
      synapseRegisterMac('itsecret', 'abc123', 'qwenbot', 'pw', true),
    ).toBe('08f25cfc6f63e9ac74b65e0ca3bc2e00ad2d7677');
  });

  it('changes when any input changes', () => {
    const base = synapseRegisterMac('s', 'n', 'u', 'p', false);
    expect(synapseRegisterMac('s2', 'n', 'u', 'p', false)).not.toBe(base);
    expect(synapseRegisterMac('s', 'n2', 'u', 'p', false)).not.toBe(base);
    expect(synapseRegisterMac('s', 'n', 'u', 'p', true)).not.toBe(base);
  });
});

describe('registerViaSharedSecret', () => {
  it('does the nonce GET then the register POST with the computed mac', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (!init) {
        return new Response(JSON.stringify({ nonce: 'NONCE1' }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          user_id: '@qwenbot:hs',
          access_token: 'tok',
          device_id: 'DEV',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const u = await registerViaSharedSecret(
      'https://hs/',
      'itsecret',
      'qwenbot',
      'pw',
      false,
      fakeFetch,
    );
    expect(u).toEqual({
      userId: '@qwenbot:hs',
      accessToken: 'tok',
      deviceId: 'DEV',
    });
    // POST carried the nonce-bound mac.
    const post = calls[1].body as { nonce: string; mac: string };
    expect(post.nonce).toBe('NONCE1');
    expect(post.mac).toBe(
      synapseRegisterMac('itsecret', 'NONCE1', 'qwenbot', 'pw', false),
    );
  });

  it('throws on a failed registration', async () => {
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      if (!init) {
        return new Response(JSON.stringify({ nonce: 'N' }), { status: 200 });
      }
      return new Response('user exists', { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      registerViaSharedSecret('https://hs', 's', 'u', 'p', false, fakeFetch),
    ).rejects.toThrow(/register failed: 400/);
  });
});
