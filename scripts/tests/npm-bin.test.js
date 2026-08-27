/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, existsSyncMock, resolveMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
  resolveMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: existsSyncMock,
}));
vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: resolveMock }),
}));

function createFakeChild() {
  const handlers = {};
  return {
    handlers,
    kill: vi.fn(),
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
  };
}

describe('scripts/npm-bin.js platform launcher', () => {
  const originalArgv = process.argv;
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  let exitSpy;
  let stderrSpy;
  let killSpy;
  let onSpy;
  let removeListenerSpy;
  let fakeChild;

  const setPlatform = (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
  };
  const setArch = (arch) => {
    Object.defineProperty(process, 'arch', { value: arch });
  };

  const importLauncher = async () => {
    await import('../npm-bin.js');
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);
    resolveMock.mockReturnValue('/platform/pkg/package.json');
    existsSyncMock.mockReturnValue(true);
    process.argv = ['node', 'npm-bin.js', '--version'];
    setPlatform(originalPlatform);
    setArch(originalArch);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => undefined);
    onSpy = vi.spyOn(process, 'on');
    removeListenerSpy = vi.spyOn(process, 'removeListener');
  });

  afterEach(() => {
    process.argv = originalArgv;
    setPlatform(originalPlatform);
    setArch(originalArch);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    killSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('runs the bundled CLI under the bundled runtime when the platform package resolves', async () => {
    // Pin the platform: beforeEach restores the runner's real one, and on a
    // Windows runner the launcher correctly takes the win32 branch, which
    // would fail the POSIX-layout assertions below.
    setPlatform('linux');
    setArch('x64');

    await importLauncher();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [runtime, commandArgs, options] = spawnMock.mock.calls[0];
    // Exact layout, not a substring: swapping the isWindows branches must
    // fail here instead of degrading every install of the other OS to node.
    expect(String(runtime).replaceAll('\\', '/')).toBe(
      '/platform/pkg/bun/bin/bun',
    );
    expect(commandArgs[0].replaceAll('\\', '/')).toBe(
      '/platform/pkg/lib/cli-entry.js',
    );
    expect(commandArgs.slice(1)).toEqual(['--version']);
    expect(options.stdio).toBe('inherit');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['darwin', 'arm64', '@qwen-code/qwen-code-darwin-arm64'],
    ['darwin', 'x64', '@qwen-code/qwen-code-darwin-x64'],
    ['linux', 'arm64', '@qwen-code/qwen-code-linux-arm64'],
    ['linux', 'x64', '@qwen-code/qwen-code-linux-x64'],
    ['win32', 'x64', '@qwen-code/qwen-code-win-x64'],
  ])(
    'resolves %s-%s through %s to the matching Bun layout',
    async (platform, arch, packageName) => {
      setPlatform(platform);
      setArch(arch);

      await importLauncher();

      expect(resolveMock).toHaveBeenCalledWith(`${packageName}/package.json`);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [runtime, commandArgs] = spawnMock.mock.calls[0];
      const expectedRuntime =
        platform === 'win32'
          ? '/platform/pkg/bun/bun.exe'
          : '/platform/pkg/bun/bin/bun';
      expect(String(runtime).replaceAll('\\', '/')).toBe(expectedRuntime);
      expect(commandArgs[0].replaceAll('\\', '/')).toBe(
        '/platform/pkg/lib/cli-entry.js',
      );
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it('falls back to the node entry when the platform package is not installed', async () => {
    resolveMock.mockImplementation(() => {
      throw new Error('Cannot find module');
    });

    await importLauncher();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [runtime, commandArgs] = spawnMock.mock.calls[0];
    expect(runtime).toBe(process.execPath);
    expect(commandArgs[0].replaceAll('\\', '/')).toMatch(/cli-entry\.js$/);
    expect(commandArgs[0].replaceAll('\\', '/')).not.toContain('/platform/');
    expect(commandArgs.slice(1)).toEqual(['--version']);
    const notice = String(stderrSpy.mock.calls[0][0]);
    expect(notice).toContain('was not installed');
    expect(notice).toContain('Falling back to node');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to the node entry on an unmapped platform', async () => {
    setPlatform('freebsd');

    await importLauncher();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnMock.mock.calls[0][1].slice(1)).toEqual(['--version']);
    expect(String(stderrSpy.mock.calls[0][0])).toContain('no prebuilt runtime');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to the node entry when the platform package lacks the CLI entry', async () => {
    existsSyncMock.mockImplementation((p) => !String(p).includes('cli-entry'));

    await importLauncher();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnMock.mock.calls[0][1].slice(1)).toEqual(['--version']);
    expect(String(stderrSpy.mock.calls[0][0])).toContain('damaged');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to the node entry when the platform package lacks the runtime', async () => {
    // Separator-agnostic: on Windows the launcher probes backslash paths
    // (\platform\pkg\bun\bun.exe), which a plain '/bun/' match never sees.
    existsSyncMock.mockImplementation(
      (p) => !String(p).replaceAll('\\', '/').includes('/bun/'),
    );

    await importLauncher();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath);
    expect(String(stderrSpy.mock.calls[0][0])).toContain('damaged');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to the node entry when the platform runtime fails to spawn', async () => {
    setPlatform('linux');
    const children = [];
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });

    await importLauncher();

    // musl/Alpine shape: the runtime file exists but cannot execve. Node also
    // emits 'close' (with a negative code) after a spawn error, so the
    // fallback must suppress the close-mirror path.
    children[0].handlers['error'](new Error('spawn ENOENT'));
    children[0].handlers['close'](-2, null);

    // The failed child's forwarders must be dropped before the fallback
    // spawns: a stale handler would intercept the fallback child's re-raised
    // death signal and swallow it, so the launcher exits 0 for a
    // signal-killed run.
    const firstChildPairs = onSpy.mock.calls
      .filter(([signal]) =>
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'].includes(signal),
      )
      .slice(0, 4);
    expect(firstChildPairs.length).toBe(4);
    for (const [signal, handler] of firstChildPairs) {
      expect(removeListenerSpy).toHaveBeenCalledWith(signal, handler);
    }

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [runtime, commandArgs] = spawnMock.mock.calls[1];
    expect(runtime).toBe(process.execPath);
    expect(commandArgs[0].replaceAll('\\', '/')).toMatch(/cli-entry\.js$/);
    expect(commandArgs.slice(1)).toEqual(['--version']);
    const notice = String(stderrSpy.mock.calls[0][0]);
    expect(notice).toContain('failed to start');
    expect(notice).toContain('Falling back to node');
    expect(exitSpy).not.toHaveBeenCalled();

    // The fallback child owns the exit decision like the first child; drive
    // it to its own close. A module-scoped spawnFailed would hit the
    // suppression guard here and leave the launcher hanging.
    children[1].handlers['close'](null, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    children[1].handlers['close'](0, null);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when the node fallback itself fails to spawn', async () => {
    resolveMock.mockImplementation(() => {
      throw new Error('Cannot find module');
    });

    await importLauncher();

    fakeChild.handlers['error'](new Error('spawn node ENOENT'));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(stderrSpy.mock.calls.at(-1)[0])).toContain(
      'failed to launch',
    );
  });

  it('mirrors the child exit code', async () => {
    await importLauncher();

    fakeChild.handlers['close'](7, null);
    expect(exitSpy).toHaveBeenCalledWith(7);

    // code 0 is where `?? 1` and `|| 1` differ: a successful CLI run must
    // not surface as launcher failure to wrappers reading $?.
    fakeChild.handlers['close'](0, null);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('re-raises the child death signal after dropping its own forwarders', async () => {
    await importLauncher();

    fakeChild.handlers['close'](null, 'SIGTERM');
    // The forwarders registered at launch must be removed first, otherwise
    // the re-raise re-enters them and the launcher hangs on a dead child.
    const removedSignals = removeListenerSpy.mock.calls.map((call) => call[0]);
    expect(removedSignals).toContain('SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(exitSpy).not.toHaveBeenCalled();

    // Removal must precede the re-raise (load-bearing: a queued re-raise is
    // dropped when the watcher stops before the signal pipe drains), and it
    // must use the exact handler references registered at launch — a
    // wrong-reference removeListener is a silent no-op on real Node.
    expect(
      Math.max(...removeListenerSpy.mock.invocationCallOrder),
    ).toBeLessThan(Math.min(...killSpy.mock.invocationCallOrder));
    const forwarders = onSpy.mock.calls.filter(([signal]) =>
      String(signal).startsWith('SIG'),
    );
    expect(forwarders.length).toBeGreaterThan(0);
    for (const [signal, handler] of forwarders) {
      expect(removeListenerSpy).toHaveBeenCalledWith(signal, handler);
    }
  });

  it('forwards terminating signals to the child on unix', async () => {
    setPlatform('linux');

    await importLauncher();

    const signals = onSpy.mock.calls.map((call) => call[0]);
    expect(signals).toEqual(
      expect.arrayContaining(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']),
    );
    // Registration alone is not forwarding: invoke each captured handler and
    // check the kill actually reaches the child.
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
      const handler = onSpy.mock.calls.find((call) => call[0] === signal)?.[1];
      handler();
      expect(fakeChild.kill).toHaveBeenCalledWith(signal);
    }
  });

  it('watches SIGINT on Windows without forwarding it', async () => {
    setPlatform('win32');

    await importLauncher();

    const signals = onSpy.mock.calls.map((call) => call[0]);
    expect(signals).toContain('SIGTERM');
    // Presence-only: without a SIGINT watcher, libuv's console control
    // handler lets Windows terminate the launcher instantly on CTRL_C while
    // the CLI child keeps running. Invoking the watcher must not kill the
    // child — child.kill('SIGINT') maps to TerminateProcess on Windows.
    expect(signals).toContain('SIGINT');
    const sigintHandler = onSpy.mock.calls.find(
      (call) => call[0] === 'SIGINT',
    )?.[1];
    sigintHandler();
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });
});
