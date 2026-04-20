/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preconnectApi, resetPreconnectState } from './apiPreconnect.js';

// Mock fetch
const mockFetch = vi.fn().mockResolvedValue(undefined);
global.fetch = mockFetch;

// Mock the shared dispatcher functions from core
const { mockGetOrCreateSharedDispatcher, mockDebugLogger } = vi.hoisted(() => {
  const dispatcher = { fake: 'dispatcher' };
  const mockDebugLogger = { debug: vi.fn() };
  return {
    mockGetOrCreateSharedDispatcher: vi.fn(() => dispatcher),
    mockDebugLogger,
  };
});
vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => mockDebugLogger,
  detectRuntime: () => 'node',
  getOrCreateSharedDispatcher: mockGetOrCreateSharedDispatcher,
}));

describe('apiPreconnect', () => {
  beforeEach(() => {
    resetPreconnectState();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(undefined);
    mockGetOrCreateSharedDispatcher.mockClear();
    delete process.env['HTTPS_PROXY'];
    delete process.env['https_proxy'];
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
    delete process.env['QWEN_CODE_DISABLE_PRECONNECT'];
    delete process.env['NODE_EXTRA_CA_CERTS'];
    delete process.env['SANDBOX'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('shouldSkipPreconnect', () => {
    it('should skip when NODE_EXTRA_CA_CERTS is set', () => {
      process.env['NODE_EXTRA_CA_CERTS'] = '/path/to/ca.pem';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('resolvedBaseUrl handling', () => {
    it('should use resolvedBaseUrl when it is a default URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://api.openai.com/v1',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should skip when resolvedBaseUrl is a custom (non-default) URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://custom.api.com/v1',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when resolvedBaseUrl is a subdomain-spoofed URL', () => {
      preconnectApi('openai', {
        resolvedBaseUrl: 'https://api.openai.com.malicious.com/v1',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fall back to default URL when resolvedBaseUrl is undefined', () => {
      preconnectApi('qwen-oauth');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://coding.dashscope.aliyuncs.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });
  });

  describe('preconnect behavior', () => {
    it('should use default baseUrl for qwen-oauth', () => {
      preconnectApi('qwen-oauth');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://coding.dashscope.aliyuncs.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should use default baseUrl for openai', () => {
      preconnectApi('openai');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should use default baseUrl for anthropic', () => {
      preconnectApi('anthropic');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com',
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('should pass shared dispatcher on Node.js runtime', () => {
      preconnectApi('qwen-oauth');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dispatcher: { fake: 'dispatcher' },
        }),
      );
    });

    it('should pass undefined proxy to shared dispatcher by default', () => {
      preconnectApi('qwen-oauth');
      expect(mockGetOrCreateSharedDispatcher).toHaveBeenCalledWith(undefined);
    });

    it('should pass configured proxy to shared dispatcher', () => {
      preconnectApi('qwen-oauth', { proxy: 'http://proxy.example.com:8080' });
      expect(mockGetOrCreateSharedDispatcher).toHaveBeenCalledWith(
        'http://proxy.example.com:8080',
      );
    });

    it('should not fire twice', () => {
      preconnectApi('qwen-oauth');
      preconnectApi('openai');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      // Should not throw
      expect(() => preconnectApi('qwen-oauth')).not.toThrow();
    });

    it('should skip when QWEN_CODE_DISABLE_PRECONNECT is set', () => {
      process.env['QWEN_CODE_DISABLE_PRECONNECT'] = '1';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip in sandbox mode', () => {
      process.env['SANDBOX'] = '1';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
