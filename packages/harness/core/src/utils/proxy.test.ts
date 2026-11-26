/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeProxyUrl,
  normalizeProxyUrlIfSupported,
  redactProxyUrl,
} from './proxy.js';

describe('normalizeProxyUrl', () => {
  it('preserves supported proxy URLs', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:7890')).toBe(
      'http://127.0.0.1:7890',
    );
    expect(normalizeProxyUrl('https://proxy.example.com')).toBe(
      'https://proxy.example.com',
    );
    expect(normalizeProxyUrl('socks://127.0.0.1:1080')).toBe(
      'socks://127.0.0.1:1080',
    );
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBe(
      'socks5://127.0.0.1:1080',
    );
  });

  it('normalizes socks5h to socks5 for undici ProxyAgent compatibility', () => {
    expect(normalizeProxyUrl('socks5h://127.0.0.1:1080')).toBe(
      'socks5://127.0.0.1:1080',
    );
    expect(normalizeProxyUrl('SOCKS5H://user:pass@proxy.example.com:1080')).toBe(
      'socks5://user:pass@proxy.example.com:1080',
    );
  });

  it('trims whitespace before validation', () => {
    expect(normalizeProxyUrl('  socks5h://127.0.0.1:1080  ')).toBe(
      'socks5://127.0.0.1:1080',
    );
  });

  it('rejects unsupported proxy protocols', () => {
    expect(() => normalizeProxyUrl('socks4://127.0.0.1:1080')).toThrow(
      'proxy must use',
    );
  });

  it('returns undefined when soft-normalizing unsupported proxy URLs', () => {
    expect(normalizeProxyUrlIfSupported('socks4://127.0.0.1:1080')).toBeUndefined();
    expect(normalizeProxyUrlIfSupported('not a url')).toBeUndefined();
    expect(normalizeProxyUrlIfSupported(undefined)).toBeUndefined();
  });

  it('normalizes socks5h when soft-normalizing supported proxy URLs', () => {
    expect(normalizeProxyUrlIfSupported('socks5h://127.0.0.1:1080')).toBe(
      'socks5://127.0.0.1:1080',
    );
  });

  it('redacts proxy credentials for logs', () => {
    const redacted = redactProxyUrl(
      'http://sensitive-user:sensitive-password@proxy.example.com:8080',
    );
    expect(redacted).toContain('proxy.example.com:8080');
    expect(redacted).not.toContain('sensitive-user');
    expect(redacted).not.toContain('sensitive-password');
  });
});
