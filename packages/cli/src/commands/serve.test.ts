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
        }, 15_000);

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
  }, 20_000);
});
