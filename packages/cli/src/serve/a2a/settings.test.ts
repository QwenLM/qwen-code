/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeA2aSettings, resolveA2aTokenRef } from './settings.js';

describe('normalizeA2aSettings', () => {
  it('returns disabled settings for missing, invalid, or disabled input', () => {
    for (const value of [undefined, null, true, [], { enabled: false }]) {
      const settings = normalizeA2aSettings(value);

      expect(settings.enabled).toBe(false);
      expect(settings.explicitPeers).toEqual([]);
      expect(settings.trustedPeers.size).toBe(0);
    }
  });

  it('normalizes valid explicit and trusted peers', () => {
    const settings = normalizeA2aSettings({
      enabled: true,
      explicitPeers: [
        {
          id: 'peer-1',
          alias: 'worker',
          url: 'http://127.0.0.1:4101',
          tokenRef: 'env:A2A_TOKEN',
        },
        { id: '', url: 'http://127.0.0.1:4102' },
        { id: 'missing-url' },
      ],
      trustedPeers: {
        'peer-2': {
          alias: 'trusted',
          url: 'http://127.0.0.1:4103',
        },
        invalid: {
          url: '',
        },
      },
    });

    expect(settings.enabled).toBe(true);
    expect(settings.explicitPeers).toEqual([
      {
        id: 'peer-1',
        alias: 'worker',
        url: 'http://127.0.0.1:4101',
        tokenRef: 'env:A2A_TOKEN',
      },
    ]);
    expect([...settings.trustedPeers.entries()]).toEqual([
      [
        'peer-2',
        {
          id: 'peer-2',
          alias: 'trusted',
          url: 'http://127.0.0.1:4103',
        },
      ],
    ]);
  });
});

describe('resolveA2aTokenRef', () => {
  const envKey = 'QWEN_A2A_SETTINGS_TEST_TOKEN';
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[envKey];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalValue;
    }
  });

  it('returns undefined for missing token refs', () => {
    expect(resolveA2aTokenRef(undefined)).toBeUndefined();
  });

  it('resolves env token refs at call time', () => {
    process.env[envKey] = 'first';
    expect(resolveA2aTokenRef(`env:${envKey}`)).toBe('first');

    process.env[envKey] = 'second';
    expect(resolveA2aTokenRef(`env:${envKey}`)).toBe('second');
  });

  it('rejects non-env token refs', () => {
    expect(() => resolveA2aTokenRef('file:/tmp/token')).toThrow(
      "Unsupported A2A tokenRef 'file:/tmp/token'",
    );
  });

  it('rejects invalid env token refs', () => {
    expect(() => resolveA2aTokenRef('env:BAD-NAME')).toThrow(
      "Invalid A2A env tokenRef 'env:BAD-NAME'",
    );
  });
});
