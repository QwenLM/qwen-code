/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import yargs, { type Argv } from 'yargs';
import { maybeOpenWebShellBrowser, serveCommand } from './serve.js';

const mockOpenBrowserSecurely = vi.hoisted(() => vi.fn());
const mockShouldLaunchBrowser = vi.hoisted(() => vi.fn(() => true));
const mockRunQwenServe = vi.hoisted(() => vi.fn());
const mockQr = vi.hoisted(() => ({
  generate: vi.fn(
    (
      _input: string,
      _opts?: { small: boolean },
      callback?: (qrcode: string) => void,
    ) => callback?.('QR'),
  ),
  setErrorLevel: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    openBrowserSecurely: mockOpenBrowserSecurely,
    shouldLaunchBrowser: mockShouldLaunchBrowser,
  };
});
vi.mock('qrcode-terminal', () => ({ default: mockQr }));
vi.mock('../serve/run-qwen-serve.js', () => ({
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

  it('defaults max sessions to 32', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['max-sessions']).toBe(32);
  });

  it('accepts --experimental-lsp in strict parser mode', () => {
    const parsed = buildParser().strict().parseSync('--experimental-lsp');
    expect(parsed['experimentalLsp']).toBe(true);
  });

  it('parses --permission-response-timeout-ms as a number', () => {
    const parsed = buildParser().parseSync(
      '--permission-response-timeout-ms 60000',
    );
    expect(parsed['permission-response-timeout-ms']).toBe(60000);
  });

  it('parses --compacted-replay-max-bytes as a number', () => {
    const parsed = buildParser().parseSync(
      '--compacted-replay-max-bytes 4194304',
    );
    expect(parsed['compacted-replay-max-bytes']).toBe(4 * 1024 * 1024);
  });

  it('parses --max-total-sessions as a number', () => {
    const parsed = buildParser().parseSync('--max-total-sessions 42');
    expect(parsed['max-total-sessions']).toBe(42);
  });

  it('parses --initialize-timeout-ms as a number', () => {
    const parsed = buildParser().parseSync('--initialize-timeout-ms 30000');
    expect(parsed['initialize-timeout-ms']).toBe(30000);
  });

  it('parses --session-restore-timeout-ms as a number', () => {
    const parsed = buildParser().parseSync(
      '--session-restore-timeout-ms 60000',
    );
    expect(parsed['session-restore-timeout-ms']).toBe(60000);
  });

  it('leaves --permission-response-timeout-ms unset by default', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['permission-response-timeout-ms']).toBeUndefined();
  });

  it('leaves --initialize-timeout-ms unset by default', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['initialize-timeout-ms']).toBeUndefined();
  });

  it('leaves --session-restore-timeout-ms unset by default', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['session-restore-timeout-ms']).toBeUndefined();
  });

  it('defaults external tool guarding to off', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['external-tool-guard-mode']).toBe('off');
  });

  it('parses required external tool guard options', () => {
    const parsed = buildParser().parseSync(
      '--external-tool-guard-mode required ' +
        '--external-tool-guard-endpoint http://127.0.0.1:8787 ' +
        '--external-tool-guard-timeout-ms 2500',
    );
    expect(parsed['external-tool-guard-mode']).toBe('required');
    expect(parsed['external-tool-guard-endpoint']).toBe(
      'http://127.0.0.1:8787',
    );
    expect(parsed['external-tool-guard-timeout-ms']).toBe(2500);
  });

  it('parses --experimental-lsp for daemon child opt-in', () => {
    const parsed = buildParser().parseSync('--experimental-lsp');
    expect(parsed['experimentalLsp']).toBe(true);
  });

  it('registers --experimental-lsp as an explicit serve option', () => {
    const options = (
      buildParser() as Argv & {
        getOptions(): { key: Record<string, boolean> };
      }
    ).getOptions();
    expect(options.key['experimental-lsp']).toBe(true);
  });

  it('parses --web (default true) and --no-web', () => {
    expect(buildParser().parseSync('')['web']).toBe(true);
    expect(buildParser().parseSync('--no-web')['web']).toBe(false);
  });

  it('parses --open (default false)', () => {
    expect(buildParser().parseSync('')['open']).toBe(false);
    expect(buildParser().parseSync('--open')['open']).toBe(true);
  });

  it('leaves the journal caps undefined unless the operator pins them', () => {
    // Adaptive growth is disabled only for PINNED caps: yargs defaults here
    // would make every unpinned boot look pinned and silently disable it.
    const parsed = buildParser().parseSync('');
    expect(parsed['max-journal-events']).toBeUndefined();
    expect(parsed['max-journal-bytes']).toBeUndefined();
    expect(
      buildParser().parseSync('--max-journal-events 5000')[
        'max-journal-events'
      ],
    ).toBe(5000);
    expect(
      buildParser().parseSync('--max-journal-bytes 1048576')[
        'max-journal-bytes'
      ],
    ).toBe(1048576);
  });

  it('rejects valueless journal cap flags instead of silently unpinning', () => {
    // Presence pins the caps and disables adaptive growth; without nargs a
    // bare flag parses as undefined and the pin never reaches runQwenServe.
    for (const input of [
      '--max-journal-events',
      '--max-journal-bytes',
      '--no-web --max-journal-events',
      '--max-journal-events --max-journal-bytes',
    ]) {
      expect(() => buildParser().parseSync(input)).toThrow(
        /Not enough arguments following: max-journal-(events|bytes)/,
      );
    }
    expect(
      buildParser().parseSync('--max-journal-events=5000')[
        'max-journal-events'
      ],
    ).toBe(5000);
    expect(
      buildParser().parseSync('--max-journal-bytes=1048576')[
        'max-journal-bytes'
      ],
    ).toBe(1048576);
  });

  it('parses --local-control without taking over daemon credentials', () => {
    expect(buildParser().parseSync('')['local-control']).toBe(false);
    expect(buildParser().parseSync('--token fixed')['token']).toBe('fixed');
    expect(
      buildParser().parseSync('--allow-origin http://localhost:3000')[
        'allow-origin'
      ],
    ).toEqual(['http://localhost:3000']);
    expect(buildParser().parseSync('--local-control')['local-control']).toBe(
      true,
    );
    const composed = buildParser().parseSync(
      '--local-control --token fixed --allow-origin http://localhost:3000 --port 0',
    );
    expect(composed['token']).toBe('fixed');
    expect(composed['allow-origin']).toEqual(['http://localhost:3000']);
    expect(composed['port']).toBe(0);
    expect(() => buildParser().parseSync('--local-control --no-web')).toThrow(
      /Local Control requires the Web Shell/,
    );
    expect(() =>
      buildParser().parseSync('--local-control --hostname 192.168.1.2'),
    ).toThrow(/Local Control requires --hostname 127\.0\.0\.1/);
    expect(() =>
      buildParser().parseSync('--local-control-address 192.168.1.2'),
    ).toThrow(/requires --local-control/);
    expect(
      buildParser().parseSync(
        '--local-control --local-control-address 192.168.1.2',
      )['local-control-address'],
    ).toBe('192.168.1.2');
  });

  it('parses repeatable --channel values', () => {
    const parsed = buildParser().parseSync(
      '--channel telegram --channel feishu',
    );

    expect(parsed['channel']).toEqual(['telegram', 'feishu']);
  });

  it('parses a single --workspace value as a single-element array', () => {
    const parsed = buildParser().parseSync('--workspace /tmp/primary');

    expect(parsed['workspace']).toEqual(['/tmp/primary']);
  });

  it('parses repeatable --workspace values as an array', () => {
    const parsed = buildParser().parseSync(
      '--workspace /tmp/primary --workspace /tmp/secondary',
    );

    expect(parsed['workspace']).toEqual(['/tmp/primary', '/tmp/secondary']);
  });

  it('parses --memory-project-scope and rejects unsupported values', () => {
    expect(
      buildParser().parseSync('--memory-project-scope workspace')[
        'memory-project-scope'
      ],
    ).toBe('workspace');
    expect(
      buildParser().parseSync('--memory-project-scope git-root')[
        'memory-project-scope'
      ],
    ).toBe('git-root');
    expect(() =>
      buildParser().parseSync('--memory-project-scope unsupported'),
    ).toThrow(/Invalid values/);
  });

  it('rejects valueless --workspace forms', () => {
    for (const input of [
      '--workspace',
      '--workspace=',
      '--workspace /tmp/primary --workspace',
    ]) {
      expect(() => buildParser().parseSync(input)).toThrow(
        /Not enough arguments following: workspace/,
      );
    }
  });

  it('preserves repeatable --workspace values in command mode', () => {
    let captured: unknown;
    yargs([])
      .exitProcess(false)
      .fail(false)
      .locale('en')
      .command({
        ...serveCommand,
        handler: (argv) => {
          captured = argv.workspace;
        },
      })
      .parseSync('serve --workspace /tmp/primary --workspace /tmp/secondary');

    expect(captured).toEqual(['/tmp/primary', '/tmp/secondary']);
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

  // Call this at most once per test: it waits on `toHaveBeenCalled()`, which a
  // previous call in the same test already satisfies, so a second invocation
  // returns before its own args land and assertions read the first call's.
  async function startServeHandlerWithArgs(args: string) {
    const handler = serveCommand.handler;
    if (!handler) throw new Error('serve handler missing');
    const argv = buildParser().parseSync(args);
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

  it('omits the journal caps for an unpinned boot so adaptive growth stays enabled', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web');

    const options = mockRunQwenServe.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('maxJournalEvents');
    expect(options).not.toHaveProperty('maxJournalBytes');
  });

  it('forwards pinned journal caps to runQwenServe', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs(
      '--no-web --max-journal-events 5000 --max-journal-bytes 1048576',
    );

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJournalEvents: 5000,
        maxJournalBytes: 1048576,
      }),
    );
  });

  it('forwards a single pinned entry cap without the byte cap', async () => {
    // The two conditional spreads are independent; pinning ONE flag must
    // forward it alone. Coupling them would silently drop the pinned cap.
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web --max-journal-events 5000');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ maxJournalEvents: 5000 }),
    );
    expect(mockRunQwenServe.mock.calls[0]?.[0]).not.toHaveProperty(
      'maxJournalBytes',
    );
  });

  it('forwards a single pinned byte cap without the entry cap', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web --max-journal-bytes 1048576');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ maxJournalBytes: 1048576 }),
    );
    expect(mockRunQwenServe.mock.calls[0]?.[0]).not.toHaveProperty(
      'maxJournalEvents',
    );
  });

  it('delegates Local Control to the daemon service and prints its pairing URL', async () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const enable = vi.fn().mockResolvedValue({
      active: true,
      url: 'https://192.168.1.20/#token=pairing',
      interfaceName: 'en0',
      sleepInhibited: true,
      encrypted: true,
    });
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'https://127.0.0.1/',
      webShellMounted: true,
      runtimeReady: Promise.resolve(),
      getLocalControl: () => ({ enable }),
    });

    await startServeHandlerWithArgs(
      '--local-control --open --port 443 --tls-cert cert.pem --tls-key key.pem',
    );
    await vi.waitFor(() => expect(mockQr.generate).toHaveBeenCalled());

    const options = mockRunQwenServe.mock.calls[0]?.[0];
    expect(options).toEqual(
      expect.objectContaining({
        hostname: '127.0.0.1',
        token: undefined,
      }),
    );
    expect(options).not.toHaveProperty('strictPort');
    expect(enable).toHaveBeenCalledWith({});
    expect(mockQr.setErrorLevel).toHaveBeenCalledWith('Q');
    expect(mockQr.generate).toHaveBeenCalledWith(
      'https://192.168.1.20/#token=pairing',
      { small: true },
      expect.any(Function),
    );
    expect(stdoutWrites.join('')).toContain('Local Control is on');
    expect(stdoutWrites.join('')).toContain('Sleep is inhibited');
    expect(stdoutWrites.join('')).toContain('Traffic is encrypted');
    await vi.waitFor(() =>
      expect(mockOpenBrowserSecurely).toHaveBeenCalledWith(
        'https://127.0.0.1/',
      ),
    );
  });

  it('forwards --token and --allow-origin through to runQwenServe with --local-control', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'https://127.0.0.1/',
      webShellMounted: true,
      runtimeReady: Promise.resolve(),
      close: vi.fn().mockResolvedValue(undefined),
      getLocalControl: () => ({
        enable: vi.fn().mockResolvedValue({
          active: true,
          url: 'http://192.168.1.20:4170/#token=pairing',
          interfaceName: 'en0',
          sleepInhibited: false,
          encrypted: false,
        }),
      }),
    });

    await startServeHandlerWithArgs(
      '--local-control --token fixed --allow-origin http://localhost:3000 --port 0',
    );

    const options = mockRunQwenServe.mock.calls[0]?.[0];
    expect(options).toEqual(
      expect.objectContaining({
        token: 'fixed',
        allowOrigins: ['http://localhost:3000'],
      }),
    );
  });

  it('closes the daemon when pairing output fails', async () => {
    const close = vi.fn().mockRejectedValue(new Error('close failed'));
    const stderrWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    mockQr.generate.mockImplementationOnce(() => {
      throw new Error('QR failed');
    });
    const enable = vi.fn().mockResolvedValue({
      active: true,
      url: 'http://192.168.1.20:4170/#token=pairing',
      interfaceName: 'en0',
      sleepInhibited: false,
      encrypted: false,
    });
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: true,
      runtimeReady: Promise.resolve(),
      close,
      getLocalControl: () => ({ enable }),
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });

    const handler = serveCommand.handler;
    if (!handler) throw new Error('serve handler missing');
    const argv = buildParser().parseSync('--local-control');
    await expect(
      handler(argv as Parameters<typeof handler>[0]),
    ).rejects.toThrow('process.exit(1) called');
    expect(close).toHaveBeenCalledOnce();
    expect(stderrWrites.join('')).toContain('QR failed');
    expect(stderrWrites.join('')).not.toContain('close failed');
  });

  it('closes Local Control when the authenticated Web Shell is unavailable', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://0.0.0.0:4170/',
      webShellMounted: false,
      runtimeReady: Promise.resolve(),
      close,
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });

    const handler = serveCommand.handler;
    if (!handler) throw new Error('serve handler missing');
    const argv = buildParser().parseSync('--local-control');
    await expect(
      handler(argv as Parameters<typeof handler>[0]),
    ).rejects.toThrow('process.exit(1) called');
    expect(close).toHaveBeenCalledOnce();
    expect(mockQr.generate).not.toHaveBeenCalled();
  });

  it('passes normalized named channels to runQwenServe', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs(
      '--no-web --channel telegram --channel telegram --channel feishu',
    );

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({
        channelSelection: { mode: 'names', names: ['telegram', 'feishu'] },
      }),
    );
  });

  it('passes compacted replay byte cap to runQwenServe', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs(
      '--no-web --compacted-replay-max-bytes 1048576',
    );

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({
        compactedReplayMaxBytes: 1024 * 1024,
      }),
    );
  });

  it('passes --max-total-sessions to runQwenServe', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web --max-total-sessions 42');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ maxTotalSessions: 42 }),
    );
  });

  it('passes --memory-project-scope to runQwenServe', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web --memory-project-scope git-root');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ memoryProjectScope: 'git-root' }),
    );
  });

  it('passes required guard config and keeps its token daemon-local', async () => {
    process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'] = 'guard-secret';
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs(
      '--no-web --external-tool-guard-mode required ' +
        '--external-tool-guard-endpoint http://127.0.0.1:8787 ' +
        '--external-tool-guard-timeout-ms 2500',
    );

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({
        externalToolGuard: {
          mode: 'required',
          endpoint: 'http://127.0.0.1:8787',
          token: 'guard-secret',
          timeoutMs: 2500,
        },
      }),
    );
    expect(process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN']).toBeUndefined();
  });

  it('does not pass a provider when mode is off even if config exists', async () => {
    process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN'] = 'guard-secret';
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs(
      '--no-web --external-tool-guard-endpoint http://127.0.0.1:8787',
    );

    expect(mockRunQwenServe.mock.calls[0]?.[0]).not.toHaveProperty(
      'externalToolGuard',
    );
    expect(process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN']).toBeUndefined();
  });

  it('passes --memory-pressure-mode to runQwenServe', async () => {
    // Without this, deleting the `memoryPressureMode` line in the handler
    // leaves every other suite green: the fast path parses the flag in its
    // own module, and the status builder supplies the same default itself.
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web --memory-pressure-mode off');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ memoryPressureMode: 'off' }),
    );
  });

  it('passes --child-heap-mode to runQwenServe', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web --child-heap-mode off');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ childHeapMode: 'off' }),
    );
  });

  it('defaults the child heap mode to observe, and rejects enforce outright', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ childHeapMode: 'observe' }),
    );
    // `enforce` is not a value yet, and boot must say so rather than accept
    // it: applying the partition needs an observation this daemon cannot make.
    expect(() => buildParser().parseSync('--child-heap-mode enforce')).toThrow(
      /Invalid values/,
    );
  });

  it('defaults the memory pressure mode to observe', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({ memoryPressureMode: 'observe' }),
    );
  });

  it('rejects a memory pressure mode outside the choices', () => {
    expect(() =>
      buildParser().parseSync('--memory-pressure-mode enforce'),
    ).toThrow(/Invalid values/);
  });

  it('passes --channel all as an all-channel selection', async () => {
    mockRunQwenServe.mockResolvedValueOnce({
      url: 'http://127.0.0.1:4170/',
      webShellMounted: false,
    });

    await startServeHandlerWithArgs('--no-web --channel all');

    expect(mockRunQwenServe).toHaveBeenCalledWith(
      expect.objectContaining({
        channelSelection: { mode: 'all' },
      }),
    );
  });

  it('rejects --channel all mixed with concrete channels', async () => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });

    const handler = serveCommand.handler;
    if (!handler) throw new Error('serve handler missing');
    const argv = buildParser().parseSync(
      '--no-web --channel all --channel telegram',
    );

    await expect(
      handler(argv as Parameters<typeof handler>[0]),
    ).rejects.toThrow('process.exit(1) called');
    expect(mockRunQwenServe).not.toHaveBeenCalled();
  });
});

describe('maybeOpenWebShellBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldLaunchBrowser.mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
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

  it('skips --open when the runtime failed to mount', async () => {
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await maybeOpenWebShellBrowser(
      {
        url: 'http://127.0.0.1:4170/',
        webShellMounted: true,
        runtimeReady: Promise.reject(new Error('runtime boom')),
      },
      true,
    );

    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
    expect(stderrWrites.join('')).toContain(
      'qwen serve: Web Shell runtime not ready; skipping --open: runtime boom',
    );
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

describe('serve startup import boundary', () => {
  it('reaches listening through the dev entrypoint without loading interactive Ink internals first', async () => {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-import-boundary-')),
    );
    const qwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-import-boundary-home-')),
    );
    const root = path.resolve(process.cwd(), '../..');
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      QWEN_CODE_NO_RELAUNCH: '1',
      QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: workspace,
      QWEN_SERVE_RATE_LIMIT: '0',
    };
    delete childEnv['VITEST_WORKER_ID'];
    const child = spawn(
      process.execPath,
      [
        path.join(root, 'scripts/dev.js'),
        'serve',
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
        '--workspace',
        workspace,
        '--no-web',
        '--no-open',
        '--rate-limit-prompt',
        '0',
        '--rate-limit-window-ms',
        '1',
      ],
      {
        cwd: root,
        detached: process.platform !== 'win32',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let childExited = false;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        childExited = true;
        resolve();
      });
    });
    const waitForExit = (ms: number) =>
      Promise.race([
        exited,
        new Promise<'timeout'>((resolve) => setTimeout(resolve, ms, 'timeout')),
      ]);
    const cleanup = async () => {
      if (child.pid === undefined) return;
      const childPid = child.pid;
      const signalProcessTree = (signal: NodeJS.Signals) => {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(childPid), '/T', '/F']);
          return;
        }
        process.kill(-childPid, signal);
      };
      try {
        signalProcessTree('SIGTERM');
      } catch {
        // Process may have already exited.
      }
      if (!childExited) {
        await waitForExit(2_000);
      }
      if (process.platform !== 'win32') {
        try {
          signalProcessTree('SIGKILL');
        } catch {
          // Process may have already exited.
        }
        if (!childExited) {
          await waitForExit(2_000);
        }
      }
    };
    const removeTempDir = async (dir: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        } catch (err) {
          if (attempt === 4) throw err;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    const processGroupHasMembers = (pgid: number): boolean => {
      if (process.platform === 'win32') return false;
      const result = spawnSync('ps', ['-o', 'pid=', '-g', String(pgid)], {
        encoding: 'utf8',
      });
      if (result.status !== 0) return false;
      return result.stdout
        .split(/\s+/)
        .some((pid) => pid.length > 0 && Number(pid) > 0);
    };
    const waitForProcessGroupExit = async (pgid: number) => {
      if (process.platform === 'win32') return;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!processGroupHasMembers(pgid)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`serve process group ${pgid} did not exit`);
    };

    try {
      const reachedListening = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          void cleanup();
          reject(
            new Error(
              `serve did not reach listening\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        }, 30_000);

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.includes('qwen serve listening on')) {
            clearTimeout(timeout);
            void cleanup();
            resolve(true);
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (
            stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED') ||
            stderr.includes('ink/dom') ||
            stderr.includes('ink/components/CursorContext')
          ) {
            clearTimeout(timeout);
            void cleanup();
            reject(new Error(stderr));
          }
        });
        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        child.on('exit', (code, signal) => {
          if (stdout.includes('qwen serve listening on')) return;
          clearTimeout(timeout);
          reject(
            new Error(
              `serve exited before listening: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        });
      });

      expect(reachedListening).toBe(true);
    } finally {
      await cleanup();
      if (child.pid !== undefined) {
        await waitForProcessGroupExit(child.pid);
      }
      await removeTempDir(workspace);
      await removeTempDir(qwenHome);
    }
  }, 40_000);
});
