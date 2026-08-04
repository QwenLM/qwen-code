/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookEventName, HookType } from './types.js';
import type { HttpHookConfig, HookInput } from './types.js';
import { HttpHookRunner } from './httpHookRunner.js';

const mockDebugLogger = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mutable DNS resolution result so individual tests can control what
// hostnames resolve to.
const mockDns = vi.hoisted(() => ({
  addresses: [{ address: '8.8.8.8', family: 4 }] as Array<{
    address: string;
    family: number;
  }>,
}));

// Mock dns.lookup to avoid real DNS lookups in tests
vi.mock('dns', () => ({
  lookup: (
    _hostname: string,
    _options: object,
    callback: (
      err: null,
      addresses: Array<{ address: string; family: number }>,
    ) => void,
  ) => {
    callback(null, mockDns.addresses);
  },
}));

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
    mockDns.addresses = [{ address: '8.8.8.8', family: 4 }];
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
        headers: new Headers(),
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
      // Pins the branch condition: a plain server error must get the
      // generic non-2xx message, never the redirect diagnostics.
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('returned non-2xx status 500'),
      );
      expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('returned a redirect'),
      );
      // Only 3xx responses surface a user-visible warning.
      expect(result.output?.systemMessage).toBeUndefined();
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

    it('should not consume a once hook slot on an undelivered 3xx redirect', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://api.example.com/moved' }),
      });

      const config = createMockConfig({ once: true });
      const input = createMockInput();

      const first = await httpRunner.execute(
        config,
        HookEventName.SessionStart,
        input,
      );
      const second = await httpRunner.execute(
        config,
        HookEventName.SessionStart,
        input,
      );

      // A redirect delivers no payload, so it cannot consume the one
      // execution: both firings must fetch instead of skipping.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(first.output?.continue).toBe(true);
      expect(first.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );
      // The redirect-warning slot is independent of the once slot: the
      // remedy is still emitted only once.
      expect(second.output?.systemMessage).toBeUndefined();
      expect(second.output?.continue).toBe(true);
    });

    it('should not follow redirects — 3xx is a non-blocking error and the target is never contacted', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({
          location: 'http://169.254.169.254/latest/meta-data',
        }),
        json: async () => ({}),
      });

      const config = createMockConfig();
      const input = createMockInput();

      const result = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      // Non-2xx (incl. 3xx) is a non-blocking error per spec
      expect(result.success).toBe(true);
      expect(result.output?.continue).toBe(true);
      // Exactly one request: the redirect target is never fetched
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // The remedy rides a systemMessage. How it surfaces is
      // event-dependent: Stop/SubagentStop show it to the user; other
      // events only write it to the debug-file channel — either way it
      // is carried in the hook output.
      expect(result.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );
      // The 3xx gets a dedicated, self-service warning naming the target
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('returned a redirect (302)'),
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('http://169.254.169.254/latest/meta-data'),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/hook',
        expect.objectContaining({ redirect: 'manual' }),
      );
    });

    it.each([301, 307, 308])(
      'should treat %i redirects the same way (never follow)',
      async (status) => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status,
          headers: new Headers({ location: 'https://api.example.com/moved' }),
        });

        const result = await httpRunner.execute(
          createMockConfig(),
          HookEventName.PreToolUse,
          createMockInput(),
        );

        expect(result.success).toBe(true);
        expect(result.output?.continue).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.output?.systemMessage).toContain(
          `returned a redirect (${status})`,
        );
      },
    );

    it('should report "unknown" when a 3xx response has no Location header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers(),
      });

      const result = await httpRunner.execute(
        createMockConfig(),
        HookEventName.PreToolUse,
        createMockInput(),
      );

      expect(result.success).toBe(true);
      expect(result.output?.systemMessage).toContain('"unknown"');
    });

    it('should sanitize the attacker-controlled Location header before it reaches the systemMessage', async () => {
      // A real Headers object rejects CRLF values outright, but a raw
      // socket response can carry them; stub the getter to simulate one.
      const evilLocation =
        'http://evil.example/\r\nFakeBoundary: 1' + 'A'.repeat(20000);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: { get: () => evilLocation },
      });

      const result = await httpRunner.execute(
        createMockConfig(),
        HookEventName.PreToolUse,
        createMockInput(),
      );

      const message = result.output?.systemMessage ?? '';
      // CR/LF stripped (the remainder concatenates), size capped like the
      // other systemMessage producers.
      expect(message).not.toContain('\r');
      expect(message).toContain('http://evil.example/FakeBoundary: 1');
      expect(message).toContain('[truncated');
      expect(message.length).toBeLessThan(11000);
    });

    it('should emit the redirect warning once per hook URL and event, then stay debug-only', async () => {
      const redirectResponse = {
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://api.example.com/moved' }),
      };
      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(redirectResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const first = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );
      const second = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(first.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );
      // A PreToolUse hook behind a redirecting LB fires on every tool
      // call; the remedy is emitted once, later runs stay debug-only.
      expect(second.output?.systemMessage).toBeUndefined();
      expect(second.output?.continue).toBe(true);
      expect(
        mockDebugLogger.warn.mock.calls.filter(([msg]) =>
          String(msg).includes('returned a redirect (302)'),
        ),
      ).toHaveLength(2);
    });

    it('should keep a warn slot per event so a PreToolUse 3xx does not burn the Stop warning', async () => {
      const redirectResponse = {
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://api.example.com/moved' }),
      };
      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(redirectResponse);

      const config = createMockConfig();
      const input = createMockInput();

      const preToolUse = await httpRunner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );
      const stop = await httpRunner.execute(config, HookEventName.Stop, input);

      expect(preToolUse.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );
      // Stop/SubagentStop is where the systemMessage actually reaches
      // the user; it keeps its own slot instead of inheriting the spent
      // PreToolUse one.
      expect(stop.output?.systemMessage).toContain('returned a redirect (302)');
    });

    it('should warn again when the hook URL changes, even for a shared name', async () => {
      const redirectResponse = {
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://api.example.com/moved' }),
      };
      mockFetch
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(redirectResponse);

      const input = createMockInput();

      const before = await httpRunner.execute(
        createMockConfig({ name: 'api-hook' }),
        HookEventName.PreToolUse,
        input,
      );
      const after = await httpRunner.execute(
        createMockConfig({
          name: 'api-hook',
          url: 'https://api.example.com/hook-v2',
        }),
        HookEventName.PreToolUse,
        input,
      );

      expect(before.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );
      expect(after.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );
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

  describe('allowPrivateNetworkHooks', () => {
    const mockSuccessResponse = () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ continue: true }),
      });
    };

    it('should block a literal private IP when the flag is off', async () => {
      const runner = new HttpHookRunner([], false);
      const config = createMockConfig({ url: 'http://172.16.254.215/hook' });
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

    it('should block a hostname resolving to a private IP when the flag is off', async () => {
      mockDns.addresses = [{ address: '172.16.254.215', family: 4 }];
      const runner = new HttpHookRunner([], false);
      const config = createMockConfig({
        url: 'http://hooks.internal.example.com/hook',
      });
      const input = createMockInput();

      const result = await runner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('private/link-local');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should allow a literal private IP when the flag is on', async () => {
      mockSuccessResponse();
      const runner = new HttpHookRunner([], true);
      const config = createMockConfig({ url: 'http://172.16.254.215/hook' });
      const input = createMockInput();

      const result = await runner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should allow a hostname resolving to a private IP when the flag is on', async () => {
      mockDns.addresses = [{ address: '172.16.254.215', family: 4 }];
      mockSuccessResponse();
      const runner = new HttpHookRunner([], true);
      const config = createMockConfig({
        url: 'http://hooks.internal.example.com/hook',
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

    it('should still block cloud metadata endpoints when the flag is on', async () => {
      const runner = new HttpHookRunner([], true);
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

    it('should still block metadata hostnames when the flag is on', async () => {
      const runner = new HttpHookRunner([], true);
      const config = createMockConfig({
        url: 'http://metadata.google.internal/hook',
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

    it('should still block the Alibaba metadata IP when the flag is on', async () => {
      const runner = new HttpHookRunner([], true);
      const config = createMockConfig({
        url: 'http://100.100.100.200/latest/meta-data',
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

    it('should still block IPv6-mapped metadata IPs when the flag is on', async () => {
      const runner = new HttpHookRunner([], true);
      const config = createMockConfig({
        url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data',
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

    it('should block a hostname resolving to a metadata IP when the flag is on', async () => {
      mockDns.addresses = [{ address: '169.254.169.254', family: 4 }];
      const runner = new HttpHookRunner([], true);
      const config = createMockConfig({
        url: 'http://hooks.internal.example.com/hook',
      });
      const input = createMockInput();

      const result = await runner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('metadata');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should block a hostname resolving to the Alibaba metadata IP when the flag is on', async () => {
      mockDns.addresses = [{ address: '100.100.100.200', family: 4 }];
      const runner = new HttpHookRunner([], true);
      const config = createMockConfig({
        url: 'http://hooks.internal.example.com/hook',
      });
      const input = createMockInput();

      const result = await runner.execute(
        config,
        HookEventName.PreToolUse,
        input,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('metadata');
      expect(mockFetch).not.toHaveBeenCalled();
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

    it('should re-arm the redirect warning together with the once slot', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://api.example.com/moved' }),
      });

      const config = createMockConfig({ once: true });
      const input = createMockInput();

      const first = await httpRunner.execute(
        config,
        HookEventName.SessionStart,
        input,
      );
      expect(first.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );

      httpRunner.resetOnceHooks();

      // The re-armed hook fetches again and the user-visible remedy is
      // shown again — the warning slot must not survive the reset.
      const afterReset = await httpRunner.execute(
        config,
        HookEventName.SessionStart,
        input,
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(afterReset.output?.systemMessage).toContain(
        'returned a redirect (302)',
      );
    });
  });
});
