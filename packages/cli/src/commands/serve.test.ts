/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import yargs, { type Argv } from 'yargs';
import { serveCommand, maybeOpenWebShellBrowser } from './serve.js';

const mockOpenBrowserSecurely = vi.hoisted(() => vi.fn());
const mockShouldLaunchBrowser = vi.hoisted(() => vi.fn(() => true));
const mockRunQwenServe = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    openBrowserSecurely: mockOpenBrowserSecurely,
    shouldLaunchBrowser: mockShouldLaunchBrowser,
  };
});
vi.mock('../serve/index.js', () => ({
  runQwenServe: mockRunQwenServe,
}));

function buildParser(): Argv {
  return (serveCommand.builder as (argv: Argv) => Argv)(
    yargs([]).exitProcess(false).fail(false).locale('en'),
  );
}

describe('serve command args', () => {
  it('parses --enable-session-shell', () => {
    const parsed = buildParser().parseSync('--enable-session-shell');
    expect(parsed['enable-session-shell']).toBe(true);
  });

  it('defaults direct session shell to disabled', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['enable-session-shell']).toBe(false);
  });

  it('parses --permission-response-timeout-ms as a number', () => {
    const parsed = buildParser().parseSync(
      '--permission-response-timeout-ms 60000',
    );
    expect(parsed['permission-response-timeout-ms']).toBe(60000);
  });

  it('leaves --permission-response-timeout-ms unset by default', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['permission-response-timeout-ms']).toBeUndefined();
  });

  it('parses --web (default true) and --no-web', () => {
    expect(buildParser().parseSync('')['web']).toBe(true);
    expect(buildParser().parseSync('--no-web')['web']).toBe(false);
  });

  it('parses --open (default false)', () => {
    expect(buildParser().parseSync('')['open']).toBe(false);
    expect(buildParser().parseSync('--open')['open']).toBe(true);
  });
});

describe('serve rate limit env parsing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  async function invokeServeHandler() {
    const handler = serveCommand.handler;
    if (!handler) throw new Error('serve handler missing');
    const argv = buildParser().parseSync('--rate-limit --no-web');
    await handler(argv as Parameters<typeof handler>[0]);
  }

  async function startServeHandler() {
    const handler = serveCommand.handler;
    if (!handler) throw new Error('serve handler missing');
    const argv = buildParser().parseSync('--rate-limit --no-web');
    void handler(argv as Parameters<typeof handler>[0]);
    await vi.waitFor(() => {
      expect(mockRunQwenServe).toHaveBeenCalled();
    });
  }

  it.each([
    ['QWEN_SERVE_RATE_LIMIT_PROMPT', '0x10'],
    ['QWEN_SERVE_RATE_LIMIT_MUTATION', '1e3'],
    ['QWEN_SERVE_RATE_LIMIT_READ', '2.5'],
    ['QWEN_SERVE_RATE_LIMIT_WINDOW_MS', '0x3e8'],
  ])('rejects non-decimal %s=%s', async (key, value) => {
    process.env[key] = value;
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });

    await expect(invokeServeHandler()).rejects.toThrow(
      'process.exit(1) called',
    );
    expect(mockRunQwenServe).not.toHaveBeenCalled();
  });

  it('passes decimal env values to runQwenServe', async () => {
    process.env['QWEN_SERVE_RATE_LIMIT_PROMPT'] = '11';
    process.env['QWEN_SERVE_RATE_LIMIT_MUTATION'] = ' 31 ';
    process.env['QWEN_SERVE_RATE_LIMIT_READ'] = '121';
    process.env['QWEN_SERVE_RATE_LIMIT_WINDOW_MS'] = '60000';
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandler();

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimit: true,
        rateLimitPrompt: 11,
        rateLimitMutation: 31,
        rateLimitRead: 121,
        rateLimitWindowMs: 60000,
      }),
    );
  });
});

describe('maybeOpenWebShellBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldLaunchBrowser.mockReturnValue(true);
  });

  const firstOpenedUrl = () =>
    String(mockOpenBrowserSecurely.mock.calls[0]?.[0]);

  it('does nothing when --open is false', async () => {
    await maybeOpenWebShellBrowser(
      { url: 'http://127.0.0.1:4170/', webShellMounted: true },
      false,
    );
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });

  it('does nothing when the Web Shell is not mounted', async () => {
    await maybeOpenWebShellBrowser(
      { url: 'http://127.0.0.1:4170/', webShellMounted: false },
      true,
    );
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });

  it('does nothing when shouldLaunchBrowser() is false', async () => {
    mockShouldLaunchBrowser.mockReturnValue(false);
    await maybeOpenWebShellBrowser(
      { url: 'http://127.0.0.1:4170/', webShellMounted: true },
      true,
    );
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });

  it('rewrites a wildcard bind host to loopback', async () => {
    await maybeOpenWebShellBrowser(
      { url: 'http://0.0.0.0:4170/', webShellMounted: true },
      true,
    );
    expect(firstOpenedUrl()).toContain('127.0.0.1');
    expect(firstOpenedUrl()).not.toContain('0.0.0.0');
  });

  it('puts the token in the URL fragment, not the query', async () => {
    await maybeOpenWebShellBrowser(
      {
        url: 'http://127.0.0.1:4170/',
        webShellMounted: true,
        resolvedToken: 'secret',
      },
      true,
    );
    expect(firstOpenedUrl()).toContain('#token=secret');
    expect(firstOpenedUrl()).not.toContain('?token=');
  });

  it('swallows openBrowserSecurely failures (never throws)', async () => {
    mockOpenBrowserSecurely.mockRejectedValueOnce(new Error('boom'));
    await expect(
      maybeOpenWebShellBrowser(
        { url: 'http://127.0.0.1:4170/', webShellMounted: true },
        true,
      ),
    ).resolves.toBeUndefined();
  });
});
