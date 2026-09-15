/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mocked = {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
    exec: execMock,
    execSync: vi.fn(() => ''),
  };
  return { ...mocked, default: mocked };
});

vi.mock('../config/settings.js', () => ({
  loadSettings: vi.fn(() => ({ merged: {} })),
  getUserSettingsDir: vi.fn(() => '.qwen'),
  SETTINGS_DIRECTORY_NAME: '.qwen',
}));

vi.mock('../serve/sandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../serve/sandbox.js')>()),
}));

vi.mock('../config/sandboxConfig.js', () => ({
  loadSandboxConfig: vi.fn(async () => ({ command: 'bwrap' })),
}));

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

import { sandboxCommand } from './sandbox.js';

async function run(args: Record<string, unknown> = {}): Promise<void> {
  await (sandboxCommand.handler as (argv: unknown) => Promise<void>)({
    _: ['sandbox'],
    $0: 'qwen',
    ...args,
  });
}

function backendCalls() {
  return [...spawnMock.mock.calls, ...spawnSyncMock.mock.calls].filter(
    (call) => call[0] === 'bwrap',
  );
}

function backendEnv(): NodeJS.ProcessEnv {
  return backendCalls()[0]?.[2]?.env ?? process.env;
}

function mockChild(pid = 54321) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

describe('qwen sandbox command runtime contract', () => {
  let work: string;
  let exitListeners: Set<NodeJS.ExitListener>;
  let signalListeners: Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>;

  beforeEach(() => {
    exitListeners = new Set(process.listeners('exit'));
    signalListeners = new Map(
      (['SIGINT', 'SIGTERM', 'SIGWINCH'] as const).map((event) => [
        event,
        new Set(process.listeners(event)),
      ]),
    );
    work = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-command-runtime-')),
    );
    for (const name of ['home', 'tmp', 'workspace']) {
      fs.mkdirSync(path.join(work, name));
    }
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(work, 'home'));
    vi.spyOn(os, 'tmpdir').mockReturnValue(path.join(work, 'tmp'));
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(work, 'workspace'));
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    for (const key of [
      'SANDBOX',
      'SANDBOX_ENFORCEMENT',
      'QWEN_CODE_SIMPLE',
      'QWEN_CODE_SAFE_MODE',
      'QWEN_SANDBOX_PROXY_COMMAND',
      'BUILD_SANDBOX',
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'NO_PROXY',
      'no_proxy',
      'DEBUG',
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('HOME', path.join(work, 'home'));
    vi.stubEnv('QWEN_HOME', path.join(work, 'home', '.qwen'));
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(work, 'runtime'));
    vi.stubEnv('XDG_CACHE_HOME', path.join(work, 'cache'));
    vi.stubEnv('QWEN_SANDBOX_NET', 'open');
    vi.stubEnv('DISPLAY', 'fixture-display');
    vi.stubEnv('WAYLAND_DISPLAY', 'fixture-wayland');
    vi.stubEnv('MIR_SOCKET', 'fixture-mir');
    vi.stubEnv('LC_ALL', 'fixture-locale');
    spawnSyncMock.mockReturnValue({ status: 42, stdout: '', stderr: '' });
    spawnMock.mockImplementation((command: string) => {
      const child = mockChild(command === 'bwrap' ? 54322 : 54321);
      if (command === 'bwrap') {
        queueMicrotask(() => child.emit('close', 42));
      }
      return child;
    });
    execMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, '', '');
      return new EventEmitter();
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const listener of process.listeners('exit')) {
      if (!exitListeners.has(listener)) {
        process.removeListener('exit', listener);
      }
    }
    for (const [event, previous] of signalListeners) {
      for (const listener of process.listeners(event)) {
        if (!previous.has(listener)) {
          process.removeListener(event, listener);
        }
      }
    }
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    fs.rmSync(work, { recursive: true, force: true });
  });

  function expectProcessListenersRestored(): void {
    expect(new Set(process.listeners('exit'))).toEqual(exitListeners);
    for (const [event, previous] of signalListeners) {
      expect(new Set(process.listeners(event))).toEqual(previous);
    }
  }

  it('supplies the same runtime markers as a regular bwrap hop', async () => {
    await run({ '--': ['echo', 'fixture'] });
    expect(backendEnv()['SANDBOX']).toBe('bwrap');
    expect(backendEnv()['SANDBOX_ENFORCEMENT']).toBe('full');
  });

  it('drops display variables while preserving the requested command locale', async () => {
    await run({ '--': ['echo', 'fixture'] });
    expect(backendEnv()['DISPLAY']).toBeUndefined();
    expect(backendEnv()['WAYLAND_DISPLAY']).toBeUndefined();
    expect(backendEnv()['MIR_SOCKET']).toBeUndefined();
    expect(backendEnv()['LC_ALL']).toBe('fixture-locale');
  });

  it('preserves argv, inherited stdio, and the requested command exit code', async () => {
    const cmd = ['echo', '1e5', '0x10', 'space separated'];
    await run({ '--': cmd });
    const call = backendCalls()[0];
    const argv = call?.[1] as string[];
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(cmd);
    expect(call?.[2]?.stdio).toBe('inherit');
    expect(call?.[2]?.detached).toBe(true);
    expect(process.exitCode).toBe(42);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s to the dedicated sandbox group and removes its listeners',
    async (signal) => {
      const payload = mockChild(54322);
      spawnMock.mockReturnValueOnce(payload);
      const completion = run({ '--': ['echo', 'fixture'] });
      await vi.waitFor(() => expect(backendCalls()).toHaveLength(1));
      process.emit(signal);
      expect(process.kill).toHaveBeenCalledWith(-54322, signal);
      payload.emit('close', null, signal);
      await completion;
      expect(process.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
      expectProcessListenersRestored();
    },
  );

  it('cancels proxy readiness on SIGTERM without launching a late payload', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    const proxy = mockChild();
    spawnMock.mockReturnValueOnce(proxy);
    let ready:
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    execMock.mockImplementationOnce((...args: unknown[]) => {
      ready = args.at(-1) as NonNullable<typeof ready>;
      return new EventEmitter();
    });
    const completion = run({ '--': ['echo', 'fixture'] });
    await vi.waitFor(() => expect(execMock).toHaveBeenCalledOnce());
    process.emit('SIGTERM');
    await completion;
    expect(process.exitCode).toBe(143);
    expect(process.kill).toHaveBeenCalledWith(-54321, 'SIGTERM');
    ready?.(null, '', '');
    await Promise.resolve();
    expect(backendCalls()).toHaveLength(0);
    expectProcessListenersRestored();
  });

  it('forwards terminal resize without ending the sandbox run', async () => {
    const payload = mockChild(54322);
    spawnMock.mockReturnValueOnce(payload);
    const completion = run({ '--': ['echo', 'fixture'] });
    await vi.waitFor(() => expect(backendCalls()).toHaveLength(1));
    process.emit('SIGWINCH');
    expect(process.kill).toHaveBeenCalledWith(-54322, 'SIGWINCH');
    expect(process.exitCode).toBeUndefined();
    payload.emit('close', 0, null);
    await completion;
    expectProcessListenersRestored();
  });

  it('supplies proxy environment when executing in proxied mode', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    vi.stubEnv('HTTPS_PROXY', 'http://fixture.invalid:8877');
    vi.stubEnv('NO_PROXY', 'fixture.internal');
    await run({ '--': ['echo', 'fixture'] });
    expect(backendEnv()['https_proxy']).toBe('http://fixture.invalid:8877');
    expect(backendEnv()['HTTP_PROXY']).toBe('http://fixture.invalid:8877');
    expect(backendEnv()['http_proxy']).toBe('http://fixture.invalid:8877');
    expect(backendEnv()['no_proxy']).toBe('fixture.internal');
  });

  it('starts and stops the proxy for an executed command', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    await run({ '--': ['echo', 'fixture'] });
    const proxyCall = spawnMock.mock.calls.find((call) => call[0] === 'bash');
    expect(proxyCall?.[1]).toEqual(['-c', 'fixture-proxy-command']);
    expect(proxyCall?.[2]?.detached).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(-54321, 'SIGTERM');
    const proxy = spawnMock.mock.results[0]?.value as EventEmitter;
    expect(proxy.listenerCount('error')).toBe(0);
    expect(proxy.listenerCount('close')).toBe(0);
    expect(process.stdin.resume).toHaveBeenCalled();
    expect(execMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expectProcessListenersRestored();
  });

  it('does not launch the payload after proxy spawn throws', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    spawnMock.mockImplementationOnce(() => {
      throw new Error('fixture proxy spawn failure');
    });

    await run({ '--': ['echo', 'fixture'] });

    expect(process.exitCode).toBe(1);
    expect(backendCalls().length).toBe(0);
    expect(spawnMock.mock.calls.length).toBe(1);
    expect(execMock).not.toHaveBeenCalled();
    expectProcessListenersRestored();
  });

  it('does not launch the payload after an asynchronous proxy spawn error', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    const proxy = mockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        proxy.emit('error', new Error('fixture proxy error event'));
      });
      return proxy;
    });

    await run({ '--': ['echo', 'fixture'] });

    expect(process.exitCode).toBe(1);
    expect(backendCalls().length).toBe(0);
    expect(spawnMock.mock.calls.length).toBe(1);
    expect(proxy.listenerCount('error')).toBe(0);
    expect(proxy.listenerCount('close')).toBe(0);
    expectProcessListenersRestored();
  });

  it('stops the proxy without launching the payload when readiness fails', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    execMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(new Error('fixture readiness failure'));
      return new EventEmitter();
    });

    await run({ '--': ['echo', 'fixture'] });

    expect(process.exitCode).toBe(1);
    expect(backendCalls().length).toBe(0);
    expect(spawnMock.mock.calls.length).toBe(1);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith(-54321, 'SIGTERM');
    expectProcessListenersRestored();
  });

  it('ignores late readiness after the proxy has already exited', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    const proxy = mockChild();
    spawnMock.mockReturnValueOnce(proxy);
    let ready:
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    execMock.mockImplementationOnce((...args: unknown[]) => {
      ready = args.at(-1) as NonNullable<typeof ready>;
      queueMicrotask(() => proxy.emit('close', 7, null));
      return new EventEmitter();
    });

    await run({ '--': ['echo', 'fixture'] });

    expect(process.exitCode).toBe(1);
    expect(backendCalls().length).toBe(0);
    expect(ready).toBeDefined();
    ready?.(null, '', '');
    await Promise.resolve();
    expect(backendCalls().length).toBe(0);
    expect(proxy.listenerCount('error')).toBe(0);
    expect(proxy.listenerCount('close')).toBe(0);
    expectProcessListenersRestored();
  });

  it('stops the proxy and restores stdin when the payload cannot spawn', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    const proxy = mockChild();
    spawnMock.mockReturnValueOnce(proxy).mockImplementationOnce(() => {
      throw new Error('fixture payload spawn failure');
    });

    await run({ '--': ['echo', 'fixture'] });

    expect(process.exitCode).toBe(1);
    expect(spawnMock.mock.calls.length).toBe(2);
    expect(process.kill).toHaveBeenCalledWith(-54321, 'SIGTERM');
    expect(process.stdin.resume).toHaveBeenCalled();
    expectProcessListenersRestored();
  });

  it('stops an active payload when its proxy exits', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    const proxy = mockChild();
    const payload = mockChild(54322);
    spawnMock.mockReturnValueOnce(proxy).mockImplementationOnce(() => {
      queueMicrotask(() => proxy.emit('close', 7, null));
      return payload;
    });

    await run({ '--': ['echo', 'fixture'] });

    expect(spawnMock.mock.calls.length).toBe(2);
    expect(backendCalls().length).toBe(1);
    expect(process.kill).toHaveBeenCalledWith(-54322, 'SIGTERM');
    expect(process.exitCode).toBe(1);
    expect(process.stdin.resume).toHaveBeenCalled();
    expect(proxy.listenerCount('error')).toBe(0);
    expect(proxy.listenerCount('close')).toBe(0);
    expectProcessListenersRestored();
  });

  it('keeps inspection diagnostic without launching a proxy or a command', async () => {
    vi.stubEnv('QWEN_SANDBOX_NET', 'proxied');
    vi.stubEnv('QWEN_SANDBOX_PROXY_COMMAND', 'fixture-proxy-command');
    await run();
    expect(spawnMock.mock.calls.length).toBe(0);
    expect(backendCalls().length).toBe(0);
  });

  it('supplies runtime markers and C locale to mocked verification commands', async () => {
    vi.spyOn(fs, 'readlinkSync').mockReturnValue('pid:[4026531836]');
    await run({ verify: true });
    expect(backendCalls().length).toBeGreaterThan(0);
    for (const call of backendCalls()) {
      expect(call[1]).toContain('--new-session');
      expect(call[2]?.env?.SANDBOX).toBe('bwrap');
      expect(call[2]?.env?.SANDBOX_ENFORCEMENT).toBe('full');
      expect(call[2]?.env?.LC_ALL).toBe('C');
    }
  });
});
