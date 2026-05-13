/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preconnectApi, resetPreconnectState } from './apiPreconnect.js';

// Mock the shared dispatcher functions from core
const { mockGetOrCreateSharedDispatcher, mockDebugLogger } = vi.hoisted(() => {
  const dispatcher = { fake: 'dispatcher' };
  const mockDebugLogger = { debug: vi.fn() };
  return {
    mockGetOrCreateSharedDispatcher: vi.fn(() => dispatcher),
    mockDebugLogger,
  };
});

// Mock fetch
const mockFetch = vi.fn().mockResolvedValue(undefined);
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    AuthType: {
      USE_OPENAI: 'openai',
      USE_ANTHROPIC: 'anthropic',
      USE_GEMINI: 'gemini',
    },
    createDebugLogger: () => mockDebugLogger,
    detectRuntime: () => 'node',
    getOrCreateSharedDispatcher: mockGetOrCreateSharedDispatcher,
    redactProxyCredentials: actual.redactProxyCredentials,
  };
});

describe('apiPreconnect', () => {
  beforeEach(() => {
    resetPreconnectState();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(undefined);
    mockGetOrCreateSharedDispatcher.mockClear();
    mockDebugLogger.debug.mockClear();
    delete process.env['HTTPS_PROXY'];
    delete process.env['https_proxy'];
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
    delete process.env['QWEN_CODE_DISABLE_PRECONNECT'];
    delete process.env['NODE_EXTRA_CA_CERTS'];
    delete process.env['SANDBOX'];
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('shouldSkipPreconnect', () => {
    it('should skip when NODE_EXTRA_CA_CERTS is set', () => {
      process.env['NODE_EXTRA_CA_CERTS'] = '/path/to/ca.pem';
      preconnectApi('qwen-oauth', { proxy: 'http://proxy.example.com:8080' });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('resolvedBaseUrl handling', () => {
    it('should use resolvedBaseUrl when it is a default URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://api.openai.com/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should skip when resolvedBaseUrl is a custom (non-default) URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://custom.api.com/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when resolvedBaseUrl is a subdomain-spoofed URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://api.openai.com.malicious.com/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should use resolvedBaseUrl when it is a dashscope compatible-mode URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should skip when resolvedBaseUrl is a dashscope subdomain-spoofed URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://dashscope.aliyuncs.com.malicious.com/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should accept DashScope regional endpoint (sg-singapore)', () => {
      preconnectApi('openai', {
        resolvedBaseUrl:
          'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should accept DashScope regional endpoint (us-virginia)', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should accept DashScope regional endpoint (cn-hongkong)', () => {
      preconnectApi('openai', {
        resolvedBaseUrl:
          'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should fall back to authType default when resolvedBaseUrl is a non-URL sentinel', () => {
      preconnectApi('qwen-oauth', {
        resolvedBaseUrl: 'DYNAMIC_QWEN_OAUTH_BASE_URL',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://coding.dashscope.aliyuncs.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should fall back to default URL when resolvedBaseUrl is undefined', () => {
      preconnectApi('qwen-oauth', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://coding.dashscope.aliyuncs.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });
  });

  describe('preconnect behavior', () => {
    it('should use default baseUrl for qwen-oauth', () => {
      preconnectApi('qwen-oauth', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://coding.dashscope.aliyuncs.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should use default baseUrl for openai', () => {
      preconnectApi('openai', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should use default baseUrl for anthropic', () => {
      preconnectApi('anthropic', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should pass shared dispatcher on Node.js runtime', () => {
      preconnectApi('qwen-oauth', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dispatcher: { fake: 'dispatcher' },
        }),
      );
    });

    it('should pass configured proxy to shared dispatcher', () => {
      preconnectApi('qwen-oauth', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockGetOrCreateSharedDispatcher).toHaveBeenCalledWith(
        'http://proxy.example.com:8080',
      );
    });

    it('should not fire twice', () => {
      preconnectApi('qwen-oauth', {
        proxy: 'http://proxy.example.com:8080',
      });
      preconnectApi('openai', { proxy: 'http://proxy.example.com:8080' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry when targetUrl was unavailable on first call', () => {
      // First call: unknown authType, no resolvedBaseUrl → no targetUrl
      preconnectApi('unknown-auth', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).not.toHaveBeenCalled();

      // Second call: valid authType → should fire
      preconnectApi('qwen-oauth', {
        proxy: 'http://proxy.example.com:8080',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://coding.dashscope.aliyuncs.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should skip dispatcher creation when no proxy configured', () => {
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockGetOrCreateSharedDispatcher).not.toHaveBeenCalled();
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Skipping preconnect dispatcher: no proxy configured',
      );
    });

    it('should allow a later proxy preconnect after a no-proxy skip', () => {
      // First call: no proxy, no useful undici pool to warm.
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();

      // Second call: proxy is now available, so preconnect should still fire.
      preconnectApi('qwen-oauth', { proxy: 'http://proxy.example.com:8080' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockGetOrCreateSharedDispatcher).toHaveBeenCalledWith(
        'http://proxy.example.com:8080',
      );
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      // Should not throw
      expect(() =>
        preconnectApi('qwen-oauth', { proxy: 'http://proxy.example.com:8080' }),
      ).not.toThrow();
    });

    it('should redact proxy credentials from async fetch errors', async () => {
      mockFetch.mockRejectedValue(
        new Error('connect ECONNREFUSED token@proxy.local:8080'),
      );
      preconnectApi('qwen-oauth', {
        proxy: 'http://token@proxy.local:8080',
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Preconnect failed (ignored): Error: connect ECONNREFUSED <redacted>@proxy.local:8080',
      );
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('token@'),
      );
    });

    it('should handle synchronous dispatcher errors gracefully', () => {
      mockGetOrCreateSharedDispatcher.mockImplementation(() => {
        throw new Error('Failed to create dispatcher');
      });
      expect(() =>
        preconnectApi('qwen-oauth', { proxy: 'http://proxy.example.com:8080' }),
      ).not.toThrow();
    });

    it('should redact proxy credentials from synchronous dispatcher errors', () => {
      mockGetOrCreateSharedDispatcher.mockImplementation(() => {
        throw new Error('connect ECONNREFUSED user:pass@proxy.local:8080');
      });

      preconnectApi('qwen-oauth', {
        proxy: 'http://user:pass@proxy.local:8080',
      });

      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'Preconnect failed (ignored): Error: connect ECONNREFUSED <redacted>@proxy.local:8080',
      );
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('user:pass@'),
      );
    });

    it('should skip when QWEN_CODE_DISABLE_PRECONNECT is set', () => {
      process.env['QWEN_CODE_DISABLE_PRECONNECT'] = '1';
      preconnectApi('qwen-oauth', { proxy: 'http://proxy.example.com:8080' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip in sandbox mode', () => {
      process.env['SANDBOX'] = '1';
      preconnectApi('qwen-oauth', { proxy: 'http://proxy.example.com:8080' });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
