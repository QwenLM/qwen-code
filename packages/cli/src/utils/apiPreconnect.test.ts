/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preconnectApi, resetPreconnectState } from './apiPreconnect.js';

// Mock fetch
const mockFetch = vi.fn().mockResolvedValue(undefined);
global.fetch = mockFetch;

describe('apiPreconnect', () => {
  beforeEach(() => {
    resetPreconnectState();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(undefined);
    delete process.env['HTTPS_PROXY'];
    delete process.env['https_proxy'];
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
    delete process.env['OPENAI_BASE_URL'];
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['GEMINI_BASE_URL'];
    delete process.env['QWEN_CODE_DISABLE_PRECONNECT'];
    delete process.env['NODE_EXTRA_CA_CERTS'];
    delete process.env['SANDBOX'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('shouldSkipPreconnect', () => {
    it('should skip when HTTPS_PROXY is set', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example.com:8080';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when https_proxy is set', () => {
      process.env['https_proxy'] = 'http://proxy.example.com:8080';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when HTTP_PROXY is set', () => {
      process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when http_proxy is set', () => {
      process.env['http_proxy'] = 'http://proxy.example.com:8080';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when NODE_EXTRA_CA_CERTS is set', () => {
      process.env['NODE_EXTRA_CA_CERTS'] = '/path/to/ca.pem';
      preconnectApi('qwen-oauth');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip when custom baseUrl is set', () => {
      preconnectApi('openai', { settingsBaseUrl: 'https://custom.api.com/v1' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not skip when baseUrl is a default URL', () => {
      preconnectApi('openai', { settingsBaseUrl: 'https://api.openai.com/v1' });
      expect(mockFetch).toHaveBeenCalled();
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

    it('should use settings baseUrl when available', () => {
      preconnectApi('openai', {
        settingsBaseUrl: 'https://custom.openai.com/v1',
      });
      // Should skip because it's a custom URL
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should use environment variable baseUrl when available', () => {
      process.env['OPENAI_BASE_URL'] = 'https://custom.env.com/v1';
      preconnectApi('openai');
      // Should skip because it's a custom URL
      expect(mockFetch).not.toHaveBeenCalled();
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
