/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookEventName, HookType } from './types.js';
import type { HttpHookConfig, HookInput } from './types.js';
import { HttpHookRunner } from './httpHookRunner.js';
import {
  DEFAULT_HTTP_HOOK_TIMEOUT_SECONDS,
  describeHookTimeout,
} from './hook-timeout.js';

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

/** A 2xx JSON fetch response whose body is `body`. */
const okJson = (body: unknown = { continue: true }) => ({
  ok: true,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
});

const resolveTo = (address: string) => {
  mockDns.addresses = [{ address, family: 4 }];
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

  /**
   * Executes a PreToolUse hook built from `overrides` with the default input.
   * Not async on purpose: it returns execute()'s own promise.
   */
  const run = (
    overrides: Partial<HttpHookConfig> = {},
    {
      runner = httpRunner,
      signal,
    }: { runner?: HttpHookRunner; signal?: AbortSignal } = {},
  ) =>
    runner.execute(
      createMockConfig(overrides),
      HookEventName.PreToolUse,
      createMockInput(),
      signal,
    );

  /** `url` must fail validation with `message` before any request is sent. */
  async function expectBlocked(
    runner: HttpHookRunner,
    url: string,
    message: string,
  ) {
    const result = await run({ url }, { runner });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(message);
    expect(mockFetch).not.toHaveBeenCalled();
  }

  /** `url` must pass validation and reach fetch. */
  async function expectAllowed(runner: HttpHookRunner, url: string) {
    mockFetch.mockResolvedValueOnce(okJson());

    const result = await run({ url }, { runner });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  }

  /** The result a non-blocking failure yields: success with continue. */
  const expectContinued = (result: Awaited<ReturnType<typeof run>>) => {
    expect(result.success).toBe(true);
    expect(result.output?.continue).toBe(true);
  };

  describe('managed request evidence', () => {
    it('proves cancellation during DNS validation did not send a request', async () => {
      const abort = new AbortController();
      const pending = httpRunner.execute(
        createMockConfig(),
        HookEventName.PreToolUse,
        createMockInput(),
        abort.signal,
        true,
        new AbortController().signal,
      );
      abort.abort();
      expect(await pending).toMatchObject({
        outcome: 'cancelled',
        httpRequestState: 'not_started',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each(['response', 'body-loss', 'timeout', 'shutdown'])(
      'preserves an in-flight managed response after user cancellation (%s)',
      async (completion) => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const shutdown = new AbortController();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let transport!: AbortSignal;
        let started!: () => void;
        const dispatched = new Promise<void>((resolve) => (started = resolve));
        mockFetch.mockImplementationOnce(async (_url, options) => {
          transport = options.signal;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              transport.addEventListener('abort', () =>
                controller.error(transport.reason),
              );
            },
          });
          started();
          return new Response(body, {
            headers: { 'content-type': 'application/json' },
          });
        });
        try {
          const pending = httpRunner.execute(
            createMockConfig({ timeout: 1 }),
            HookEventName.PreToolUse,
            createMockInput(),
            caller.signal,
            true,
            shutdown.signal,
          );
          await dispatched;
          caller.abort();
          expect(transport.aborted).toBe(false);
          if (completion === 'response') {
            stream.enqueue(new TextEncoder().encode('{"continue":false}'));
            stream.close();
          } else if (completion === 'body-loss') {
            stream.error(new TypeError('response disconnected'));
          } else if (completion === 'timeout') {
            await vi.advanceTimersByTimeAsync(1000);
          } else shutdown.abort();
          const result = await pending;
          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(result.httpRequestState).toBe(
            completion === 'response' ? 'response_received' : 'outcome_unknown',
          );
          if (completion === 'response')
            expect(result.output).toMatchObject({ continue: false });
          if (completion === 'timeout') expect(result.outcome).toBe('timeout');
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('keeps a partially received JSON response unknown', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"continue":false'));
        },
        pull(controller) {
          controller.error(new TypeError('response body disconnected'));
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const result = await httpRunner.execute(
        createMockConfig(),
        HookEventName.PreToolUse,
        createMockInput(),
        undefined,
        true,
      );
      expect(result).toMatchObject({
        outcome: 'non_blocking_error',
        httpRequestState: 'outcome_unknown',
      });
    });

    it('keeps timeout active while waiting for the response body', async () => {
      mockFetch.mockImplementationOnce(async (_url, options) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            options.signal.addEventListener('abort', () =>
              controller.error(options.signal.reason),
            );
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'application/json' },
        });
      });
      const result = await httpRunner.execute(
        createMockConfig({ timeout: 0.01 }),
        HookEventName.PreToolUse,
        createMockInput(),
        undefined,
        true,
      );
      expect(result).toMatchObject({
        outcome: 'timeout',
        httpRequestState: 'outcome_unknown',
      });
    });

    it('proves a blocked destination was not sent', async () => {
      const result = await httpRunner.execute(
        createMockConfig({ url: 'https://other.example/hook' }),
        HookEventName.PreToolUse,
        createMockInput(),
        undefined,
        true,
      );
      expect(result.httpRequestState).toBe('not_started');
      expect(mockFetch).not.toHaveBeenCalled();
    });
    it('distinguishes a received failure response from a lost reply', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      const received = await httpRunner.execute(
        createMockConfig(),
        HookEventName.PreToolUse,
        createMockInput(),
        undefined,
        true,
      );
      expect(received).toMatchObject({
        outcome: 'non_blocking_error',
        httpRequestState: 'response_received',
      });
      mockFetch.mockRejectedValueOnce(new Error('reply lost'));
      const lost = await httpRunner.execute(
        createMockConfig(),
        HookEventName.PreToolUse,
        createMockInput(),
        undefined,
        true,
      );
      expect(lost).toMatchObject({
        outcome: 'non_blocking_error',
        httpRequestState: 'outcome_unknown',
      });
    });
  });

  describe('execute', () => {
    it('should fail for URL not in whitelist', () =>
      expectBlocked(
        httpRunner,
        'https://other.com/hook',
        'URL validation failed',
      ));

    // `new HttpHookRunner([])` allows all URL patterns (here and below).
    it('should fail for blocked URL (SSRF - link-local metadata)', () =>
      expectBlocked(
        new HttpHookRunner([]),
        'http://169.254.169.254/latest/meta-data',
        'blocked',
      ));

    it('should ALLOW localhost for local dev hooks', () =>
      expectAllowed(new HttpHookRunner([]), 'http://localhost:8080/hook'));

    it('should interpolate environment variables in headers', async () => {
      process.env['MY_TOKEN'] = 'secret-token';
      mockFetch.mockResolvedValueOnce(okJson());

      await run({
        headers: { Authorization: 'Bearer $MY_TOKEN' },
        allowedEnvVars: ['MY_TOKEN'],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-token',
          }),
        }),
      );
    });

    // Per Claude Code spec, a non-2xx status is a non-blocking error:
    // execution continues with success: true.
    it('should handle HTTP error response as non-blocking error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      expectContinued(await run());
    });

    it('should not follow redirects: a 3xx is a non-blocking error and the target is never contacted', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: new Headers({
          location: 'http://169.254.169.254/latest/meta-data',
        }),
      });

      expectContinued(await run());
      // Exactly one request, to the validated URL, with redirects disabled
      // so the whitelist and SSRF checks cannot be bypassed by a 30x.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/hook',
        expect.objectContaining({ redirect: 'manual' }),
      );
    });

    // Per Claude Code spec, a timeout is a non-blocking error: execution
    // continues with success: true.
    it('should handle timeout as non-blocking error', async () => {
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            setTimeout(() => reject(error), 10);
          }),
      );

      expectContinued(await run({ timeout: 1 }));
    });

    it('should skip once hook on second execution', async () => {
      mockFetch.mockResolvedValue(okJson());
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
      mockFetch.mockResolvedValueOnce(
        okJson({
          decision: 'deny',
          reason: 'Blocked by policy',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
          },
        }),
      );

      const result = await run();

      expect(result.success).toBe(true);
      expect(result.output?.decision).toBe('deny');
      expect(result.output?.reason).toBe('Blocked by policy');
    });

    it('should handle aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await run({}, { signal: controller.signal });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('cancelled');
    });
  });

  describe('allowPrivateNetworkHooks', () => {
    const flagOff = () => new HttpHookRunner([], false);
    const flagOn = () => new HttpHookRunner([], true);
    const privateIp = 'http://172.16.254.215/hook';
    const internalHost = 'http://hooks.internal.example.com/hook';

    it('should block a literal private IP when the flag is off', () =>
      expectBlocked(flagOff(), privateIp, 'blocked'));

    it('should block a hostname resolving to a private IP when the flag is off', async () => {
      resolveTo('172.16.254.215');
      await expectBlocked(flagOff(), internalHost, 'private/link-local');
    });

    it('should allow a literal private IP when the flag is on', () =>
      expectAllowed(flagOn(), privateIp));

    it('should allow a hostname resolving to a private IP when the flag is on', async () => {
      resolveTo('172.16.254.215');
      await expectAllowed(flagOn(), internalHost);
    });

    it('should still block cloud metadata endpoints when the flag is on', () =>
      expectBlocked(
        flagOn(),
        'http://169.254.169.254/latest/meta-data',
        'blocked',
      ));

    it('should still block metadata hostnames when the flag is on', () =>
      expectBlocked(
        flagOn(),
        'http://metadata.google.internal/hook',
        'blocked',
      ));

    it('should still block the Alibaba metadata IP when the flag is on', () =>
      expectBlocked(
        flagOn(),
        'http://100.100.100.200/latest/meta-data',
        'blocked',
      ));

    it('should still block IPv6-mapped metadata IPs when the flag is on', () =>
      expectBlocked(
        flagOn(),
        'http://[::ffff:a9fe:a9fe]/latest/meta-data',
        'blocked',
      ));

    it('should block a hostname resolving to a metadata IP when the flag is on', async () => {
      resolveTo('169.254.169.254');
      await expectBlocked(flagOn(), internalHost, 'metadata');
    });

    it('should block a hostname resolving to the Alibaba metadata IP when the flag is on', async () => {
      resolveTo('100.100.100.200');
      await expectBlocked(flagOn(), internalHost, 'metadata');
    });
  });

  describe('outcome', () => {
    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    /** A fetch that only settles when its request signal aborts. */
    const hangUntilAborted = () =>
      mockFetch.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason),
            );
          }),
      );

    it('reports a non-2xx response as a non-blocking error without failing the hook', async () => {
      mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));

      const result = await run();

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error?.message).toContain('500');
    });

    it('keeps a non-2xx response non-blocking', async () => {
      mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));

      expectContinued(await run());
    });

    it('reports its own timeout as timeout when the caller did not abort', async () => {
      hangUntilAborted();
      const controller = new AbortController();

      const result = await run(
        { timeout: 0.02 },
        { signal: controller.signal },
      );

      expect(result.outcome).toBe('timeout');
      expect(result.success).toBe(true);
      expect(result.error?.message).toContain('20ms');
    });

    it('reports a caller abort during the request as cancelled', async () => {
      hangUntilAborted();
      const controller = new AbortController();

      const execution = run({ timeout: 60 }, { signal: controller.signal });
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      controller.abort();
      const result = await execution;

      expect(result.outcome).toBe('cancelled');
      expect(result.success).toBe(true);
    });

    it('reports a connection failure as a non-blocking error carrying the fetch error', async () => {
      const connectionError = new TypeError('fetch failed');
      mockFetch.mockRejectedValueOnce(connectionError);

      const result = await run();

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.error).toBe(connectionError);
    });

    it('reports a 2xx deny as blocking while the hook still succeeds', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ decision: 'deny', reason: 'Blocked by policy' }),
      );

      const result = await run();

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('blocking');
    });

    it('reports a plain 2xx response as success', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ continue: true }));

      const result = await run();

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('success');
    });

    it('lets a PreToolUse permission decision override the generic decision, as progress reporting does', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          decision: 'deny',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        }),
      );

      expect((await run()).outcome).toBe('success');
    });

    it('reports a caller abort before the request as cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await run({}, { signal: controller.signal });

      expect(result.outcome).toBe('cancelled');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reports a URL outside the allowlist as a failed non-blocking error', async () => {
      const result = await run({ url: 'https://other.com/hook' });

      expect(result.outcome).toBe('non_blocking_error');
      expect(result.success).toBe(false);
    });
  });

  describe('timeout matches describeHookTimeout', () => {
    const hangAndCaptureSignal = () => {
      const seen: { signal?: AbortSignal } = {};
      mockFetch.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            seen.signal = init.signal ?? undefined;
            init.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason),
            );
          }),
      );
      return seen;
    };

    /**
     * Under fake timers, runs `config` against a hanging fetch and checks the
     * request signal is still live after `pendingMs` and aborted (or not, per
     * `abortedAfter`) one millisecond later.
     */
    const expectAbortTiming = async (
      config: HttpHookConfig,
      pendingMs: number,
      abortedAfter: boolean,
    ) => {
      vi.useFakeTimers();
      try {
        const seen = hangAndCaptureSignal();
        const caller = new AbortController();
        const execution = httpRunner.execute(
          config,
          HookEventName.PreToolUse,
          createMockInput(),
          caller.signal,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.signal).toBeDefined();
        await vi.advanceTimersByTimeAsync(pendingMs);
        const abortedBefore = seen.signal?.aborted === true;
        await vi.advanceTimersByTimeAsync(1);
        const after = seen.signal?.aborted === true;
        caller.abort();
        await execution;
        expect({ abortedBefore, abortedAfter: after }).toEqual({
          abortedBefore: false,
          abortedAfter,
        });
      } finally {
        vi.useRealTimers();
      }
    };

    it('aborts a configured value in seconds at the described delay', async () => {
      expect(describeHookTimeout(HookType.Http, 60).timeoutMs).toBe(60_000);
      await expectAbortTiming(createMockConfig({ timeout: 60 }), 59_999, true);
    });

    it('aborts an unconfigured hook at the described default', async () => {
      expect(describeHookTimeout(HookType.Http, undefined).timeoutMs).toBe(
        DEFAULT_HTTP_HOOK_TIMEOUT_SECONDS * 1000,
      );
      await expectAbortTiming(
        createMockConfig(),
        DEFAULT_HTTP_HOOK_TIMEOUT_SECONDS * 1000 - 1,
        true,
      );
    });

    it('never aborts a negative timeout, as described', async () => {
      expect(describeHookTimeout(HookType.Http, -1).timeoutMs).toBeNull();
      await expectAbortTiming(
        createMockConfig({ timeout: -1 }),
        10 * 60_000,
        false,
      );
    });
  });

  describe('resetOnceHooks', () => {
    it('should allow once hooks to execute again after reset', async () => {
      mockFetch.mockResolvedValue(okJson());
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
