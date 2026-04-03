/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookEventName, HookType } from './types.js';
import type { HttpHookConfig, HookInput } from './types.js';
import { HttpHookRunner } from './httpHookRunner.js';
import { UrlValidator } from './urlValidator.js';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock validateWithDnsCheck to avoid real DNS lookups in tests
UrlValidator.prototype.validateWithDnsCheck = async function (url: string) {
  // Use sync validate to skip DNS resolution
  return this.validate(url);
};

describe('HttpHookRunner', () => {
  let httpRunner: HttpHookRunner;
  const originalEnv = process.env;
  // Use escaped dots in URL patterns to satisfy CodeQL security scanning
  // The UrlValidator.compilePattern method also escapes dots, but we use
  // pre-escaped patterns here to make the security intent explicit
  const ALLOWED_URL_PATTERN = 'https://api\\.example\\.com/*';

  beforeEach(() => {
    httpRunner = new HttpHookRunner([ALLOWED_URL_PATTERN]);
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const createMockInput = (overrides: Partial<HookInput> = {}): HookInput => ({
    session_id: 'test-session',
    transcript_path: '/test/transcript',
    cwd: '/test',
    hook_event_name: 'PreToolUse',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const createMockConfig = (
    overrides: Partial<HttpHookConfig> = {},
  ): HttpHookConfig => ({
    type: HookType.Http,
    url: 'https://api.example.com/hook',
    ...overrides,
  });

  describe('execute', () => {
    it('should fail for URL not in whitelist', async () => {
      const config = createMockConfig({
        url: 'https://other.com/hook',
      });
      const input = createMockInput();

      const result = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('URL validation failed');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fail for blocked URL (SSRF - link-local metadata)', async () => {
      const runner = new HttpHookRunner([]); // Allow all patterns
      const config = createMockConfig({
        url: 'http://169.254.169.254/latest/meta-data',
      });
      const input = createMockInput();

      const result = await runner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('blocked');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should ALLOW localhost for local dev hooks', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ continue: true }),
      });

      const runner = new HttpHookRunner([]); // Allow all patterns
      const config = createMockConfig({
        url: 'http://localhost:8080/hook',
      });
      const input = createMockInput();

      const result = await runner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should interpolate environment variables in headers', async () => {
      process.env['MY_TOKEN'] = 'secret-token';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ continue: true }),
      });

      const config = createMockConfig({
        headers: { Authorization: 'Bearer $MY_TOKEN' },
        allowedEnvVars: ['MY_TOKEN'],
      });
      const input = createMockInput();

      await httpRunner.execute(config, HookEventName.PreToolUse, input);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-token',
          }),
        }),
      );
    });

    it('should handle HTTP error response as non-blocking error', async () => {
      // Per Claude Code spec: Non-2xx status is a non-blocking error
      // Execution continues with success: true
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const config = createMockConfig();
      const input = createMockInput();

      const result = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      // Non-2xx is a non-blocking error, so success should be true
      expect(result.success).toBe(true);
      expect(result.output?.continue).toBe(true);
    });

    it('should handle timeout as non-blocking error', async () => {
      // Per Claude Code spec: Timeout is a non-blocking error
      // Execution continues with success: true
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            setTimeout(() => reject(error), 10);
          }),
      );

      const config = createMockConfig({ timeout: 1 });
      const input = createMockInput();

      const result = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      // Timeout is a non-blocking error, so success should be true
      expect(result.success).toBe(true);
      expect(result.output?.continue).toBe(true);
    });

    it('should skip once hook on second execution', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ continue: true }),
      });

      const config = createMockConfig({ once: true });
      const input = createMockInput();

      // First execution
      await httpRunner.execute(config, HookEventName.PreToolUse, input);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second execution - should skip
      const result = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should parse JSON response with hook output', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          decision: 'deny',
          reason: 'Blocked by policy',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
          },
        }),
      });

      const config = createMockConfig();
      const input = createMockInput();

      const result = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('Blocked by policy');
    });

    it('should handle aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const config = createMockConfig();
      const input = createMockInput();

      const result = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
        controller.signal,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('cancelled');
    });
  });

  describe('resetOnceHooks', () => {
    it('should allow once hooks to execute again after reset', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ continue: true }),
      });

      const config = createMockConfig({ once: true });
      const input = createMockInput();

      await httpRunner.execute(config, HookEventName.PreToolUse, input);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      httpRunner.resetOnceHooks();

      await httpRunner.execute(config, HookEventName.PreToolUse, input);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
