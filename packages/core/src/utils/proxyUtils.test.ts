/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { normalizeProxyUrl } from './proxyUtils.js';

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

  // socks5h and socks4a ask the proxy to resolve hostnames and are the forms
  // curl, proxychains and most tunnels emit. They used to fall through to the
  // http:// prefix and yield `http://socks5h://...`, which parses as the host
  // `socks5h` on port 80.
  it('should throw error for socks5h:// proxy URL', () => {
    expect(() => normalizeProxyUrl('socks5h://127.0.0.1:1080')).toThrow(
      'SOCKS proxy is not supported',
    );
  });

  it('should throw error for socks4a:// proxy URL', () => {
    expect(() => normalizeProxyUrl('socks4a://127.0.0.1:1080')).toThrow(
      'SOCKS proxy is not supported',
    );
  });

  it('should throw error for SOCKS5H:// proxy URL (case insensitive)', () => {
    expect(() => normalizeProxyUrl('SOCKS5H://proxy.example.com:1080')).toThrow(
      'SOCKS proxy is not supported',
    );
  });

  it('should never prefix http:// onto a socks scheme', () => {
    for (const url of [
      'socks://h:1080',
      'socks4://h:1080',
      'socks4a://h:1080',
      'socks5://h:1080',
      'socks5h://h:1080',
    ]) {
      expect(() => normalizeProxyUrl(url)).toThrow('SOCKS proxy');
    }
  });

  // Guards against over-correcting: a host that merely starts with "socks" is
  // not a socks scheme, since there is no `://` after it. Passes before and
  // after the fix.
  it('should still accept a hostname that begins with socks', () => {
    expect(normalizeProxyUrl('socks.example.com:1080')).toBe(
      'http://socks.example.com:1080',
    );
    expect(normalizeProxyUrl('http://socks5h.example.com:1080')).toBe(
      'http://socks5h.example.com:1080',
    );
  });
});
