/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildNoProxyList, normalizeProxyUrl } from './proxyUtils.js';

describe('normalizeProxyUrl', () => {
  it('should return undefined for undefined input', () => {
    expect(normalizeProxyUrl(undefined)).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(normalizeProxyUrl('')).toBeUndefined();
  });

  it('should return undefined for whitespace-only string', () => {
    expect(normalizeProxyUrl('   ')).toBeUndefined();
  });

  it('should add http:// prefix to proxy URL without protocol', () => {
    expect(normalizeProxyUrl('127.0.0.1:7860')).toBe('http://127.0.0.1:7860');
  });

  it('should add http:// prefix to proxy URL with port only', () => {
    expect(normalizeProxyUrl('localhost:8080')).toBe('http://localhost:8080');
  });

  it('should not modify URL that already has http:// prefix', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:7860')).toBe(
      'http://127.0.0.1:7860',
    );
  });

  it('should not modify URL that already has https:// prefix', () => {
    expect(normalizeProxyUrl('https://proxy.example.com:443')).toBe(
      'https://proxy.example.com:443',
    );
  });

  it('should handle HTTP:// prefix (case insensitive)', () => {
    expect(normalizeProxyUrl('HTTP://127.0.0.1:7860')).toBe(
      'HTTP://127.0.0.1:7860',
    );
  });

  it('should handle HTTPS:// prefix (case insensitive)', () => {
    expect(normalizeProxyUrl('HTTPS://proxy.example.com:443')).toBe(
      'HTTPS://proxy.example.com:443',
    );
  });

  it('should handle proxy URL with authentication', () => {
    expect(normalizeProxyUrl('user:pass@proxy.example.com:8080')).toBe(
      'http://user:pass@proxy.example.com:8080',
    );
  });

  it('should handle proxy URL with authentication and http:// prefix', () => {
    expect(normalizeProxyUrl('http://user:pass@proxy.example.com:8080')).toBe(
      'http://user:pass@proxy.example.com:8080',
    );
  });

  it('should trim whitespace from proxy URL', () => {
    expect(normalizeProxyUrl('  127.0.0.1:7860  ')).toBe(
      'http://127.0.0.1:7860',
    );
  });

  it('should handle IPv6 addresses', () => {
    expect(normalizeProxyUrl('[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('should handle IPv6 addresses with http:// prefix', () => {
    expect(normalizeProxyUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  // SOCKS proxy tests - should throw error since undici doesn't support SOCKS
  it('should throw error for socks:// proxy URL', () => {
    expect(() => normalizeProxyUrl('socks://proxy.example.com:1080')).toThrow(
      'SOCKS proxy is not supported',
    );
  });

  it('should throw error for socks4:// proxy URL', () => {
    expect(() => normalizeProxyUrl('socks4://proxy.example.com:1080')).toThrow(
      'SOCKS proxy is not supported',
    );
  });

  it('should throw error for socks5:// proxy URL', () => {
    expect(() => normalizeProxyUrl('socks5://proxy.example.com:1080')).toThrow(
      'SOCKS proxy is not supported',
    );
  });

  it('should throw error for SOCKS5:// proxy URL (case insensitive)', () => {
    expect(() => normalizeProxyUrl('SOCKS5://proxy.example.com:1080')).toThrow(
      'SOCKS proxy is not supported',
    );
  });
});

describe('buildNoProxyList', () => {
  const savedNoProxy = process.env['NO_PROXY'];
  const savedNoProxyLower = process.env['no_proxy'];

  afterEach(() => {
    if (savedNoProxy === undefined) {
      delete process.env['NO_PROXY'];
    } else {
      process.env['NO_PROXY'] = savedNoProxy;
    }
    if (savedNoProxyLower === undefined) {
      delete process.env['no_proxy'];
    } else {
      process.env['no_proxy'] = savedNoProxyLower;
    }
  });

  it('should include localhost variants when no NO_PROXY env var is set', () => {
    delete process.env['NO_PROXY'];
    delete process.env['no_proxy'];
    const result = buildNoProxyList();
    expect(result).toBe('localhost,127.0.0.1,::1');
  });

  it('should prepend existing NO_PROXY values', () => {
    process.env['NO_PROXY'] = 'internal-llm.company.com,.corp.net';
    const result = buildNoProxyList();
    expect(result).toBe(
      'internal-llm.company.com,.corp.net,localhost,127.0.0.1,::1',
    );
  });

  it('should respect lowercase no_proxy', () => {
    delete process.env['NO_PROXY'];
    process.env['no_proxy'] = 'local-server';
    const result = buildNoProxyList();
    expect(result).toBe('local-server,localhost,127.0.0.1,::1');
  });

  it('should prefer uppercase NO_PROXY over lowercase no_proxy', () => {
    process.env['NO_PROXY'] = 'upper-case-host';
    process.env['no_proxy'] = 'lower-case-host';
    const result = buildNoProxyList();
    expect(result).toBe('upper-case-host,localhost,127.0.0.1,::1');
  });
});
