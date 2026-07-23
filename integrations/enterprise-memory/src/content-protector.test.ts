/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  HttpContentProtector,
  InMemoryContentProtector,
} from './content-protector.js';

const request = {
  tenantId: 'tenant-a',
  principalId: 'principal-a',
  sourceOperationId: 'operation-a',
  plaintext: 'private memory',
  expiresAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('InMemoryContentProtector', () => {
  it('round trips content only for the owning tenant', async () => {
    const protector = new InMemoryContentProtector();
    const content = await protector.protect(request);

    await expect(protector.reveal('tenant-a', content)).resolves.toBe(
      'private memory',
    );
    await expect(protector.reveal('tenant-b', content)).rejects.toThrow(
      'unavailable',
    );
  });

  it('makes destroyed content unavailable', async () => {
    const protector = new InMemoryContentProtector();
    const content = await protector.protect(request);

    await protector.destroy('tenant-a', content.keyHandle);

    await expect(protector.reveal('tenant-a', content)).rejects.toThrow(
      'unavailable',
    );
  });
});

describe('HttpContentProtector', () => {
  it('preserves a service base path prefix', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ keyHandle: 'key-a', ciphertext: 'ciphertext-a' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const protector = new HttpContentProtector({
      baseUrl: 'https://keys.example.test/security',
      bearerToken: 'token-a',
      fetchImplementation,
    });

    await protector.protect(request);

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL('https://keys.example.test/security/v1/content:protect'),
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });

  it('rejects malformed service content', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ keyHandle: '', ciphertext: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const protector = new HttpContentProtector({
      baseUrl: 'https://keys.example.test',
      bearerToken: 'token-a',
      fetchImplementation,
    });

    await expect(protector.protect(request)).rejects.toThrow('invalid content');
  });
});
