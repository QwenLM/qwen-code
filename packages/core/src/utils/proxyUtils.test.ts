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
});
