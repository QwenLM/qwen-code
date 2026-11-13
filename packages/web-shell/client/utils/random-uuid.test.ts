/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from './random-uuid.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUUID', () => {
  const realCrypto = globalThis.crypto;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delegates to crypto.randomUUID when the context exposes it', () => {
    const minted = vi.fn(() => '0b9c6f4e-1d2a-4f3b-9c8d-7e6f5a4b3c2d');
    vi.stubGlobal('crypto', {
      randomUUID: minted,
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });
    expect(randomUUID()).toBe('0b9c6f4e-1d2a-4f3b-9c8d-7e6f5a4b3c2d');
    expect(minted).toHaveBeenCalledTimes(1);
  });

  it('mints unique v4 ids without crypto.randomUUID (non-secure context)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      expect(id).toMatch(UUID_V4);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });

  it('sets the version and variant bits on all-zero entropy', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0x00);
        return bytes;
      },
    });
    expect(randomUUID()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('clears the version and variant bits on all-one entropy', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xff);
        return bytes;
      },
    });
    expect(randomUUID()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
