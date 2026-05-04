/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FetchError,
  formatFetchErrorForUser,
  isPrivateIp,
  fetchWithTimeout,
} from './fetch.js';

describe('isPrivateIp', () => {
  it('identifies private IPv4 addresses', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
  });

  it('identifies private IPv6 addresses', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('[::1]')).toBe(true);
    expect(isPrivateIp('fc00::')).toBe(true);
    expect(isPrivateIp('[fc00::]')).toBe(true);
    expect(isPrivateIp('fe80::')).toBe(true);
    expect(isPrivateIp('[fe80::]')).toBe(true);
  });

  it('identifies AWS IMDS and other link-local addresses', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('identifies CGNAT addresses', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
  });

  it('identifies 0.0.0.0 addresses', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isPrivateIp('api.openai.com')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIp('[2001:4860:4860::8888]')).toBe(false);
  });
});

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('preserves error codes from network errors', async () => {
    const networkError = new Error('Connection refused');
    Object.assign(networkError, { code: 'ECONNREFUSED' });
    vi.mocked(fetch).mockRejectedValue(networkError);

    await expect(
      fetchWithTimeout('https://api.example.com', 1000),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'ECONNREFUSED',
        message: 'Connection refused',
      }),
    );
  });

  it('throws ETIMEDOUT on timeout', async () => {
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const error = new Error('The operation was aborted');
          Object.assign(error, { code: 'ABORT_ERR', name: 'AbortError' });
          setTimeout(() => reject(error), 10);
        }),
    );

    await expect(
      fetchWithTimeout('https://api.example.com', 1),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'ETIMEDOUT',
        message: expect.stringContaining('timed out'),
      }),
    );
  });

  it('passes through user cancellation errors', async () => {
    const userController = new AbortController();
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const error = new Error('The operation was aborted');
          Object.assign(error, { name: 'AbortError' });
          setTimeout(() => reject(error), 50);
        }),
    );

    const promise = fetchWithTimeout(
      'https://api.example.com',
      1000,
      {},
      userController.signal,
    );

    // Abort immediately
    userController.abort();

    await expect(promise).rejects.toThrow(
      expect.objectContaining({
        name: 'AbortError',
      }),
    );

    // Should NOT be ETIMEDOUT
    try {
      await promise;
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e) {
        expect((e as { code: string }).code).not.toBe('ETIMEDOUT');
      }
    }
  });
});

describe('formatFetchErrorForUser', () => {
  it('includes troubleshooting hints for TLS errors', () => {
    const tlsCause = new Error('unable to verify the first certificate');
    (tlsCause as Error & { code?: string }).code =
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE';

    const fetchError = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    fetchError.cause = tlsCause;

    const message = formatFetchErrorForUser(fetchError, {
      url: 'https://chat.qwen.ai',
    });

    expect(message).toContain('fetch failed');
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(message).toContain('Troubleshooting:');
    expect(message).toContain('Confirm you can reach https://chat.qwen.ai');
    expect(message).toContain('--proxy');
    expect(message).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('includes troubleshooting hints for network codes', () => {
    const fetchError = new FetchError(
      'Request timed out after 100ms',
      'ETIMEDOUT',
    );
    const message = formatFetchErrorForUser(fetchError, {
      url: 'https://example.com',
    });

    expect(message).toContain('Request timed out after 100ms');
    expect(message).toContain('Troubleshooting:');
    expect(message).toContain('Confirm you can reach https://example.com');
    expect(message).toContain('--proxy');
    expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('does not include troubleshooting for non-fetch errors', () => {
    expect(formatFetchErrorForUser(new Error('boom'))).toBe('boom');
  });
});
