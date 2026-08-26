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
  let exitSpy;
  let stderrSpy;
  let killSpy;
  let onSpy;
  let removeListenerSpy;
  let fakeChild;

  const setPlatform = (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
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
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => undefined);
    onSpy = vi.spyOn(process, 'on');
    removeListenerSpy = vi.spyOn(process, 'removeListener');
  });

  afterEach(() => {
    process.argv = originalArgv;
    setPlatform(originalPlatform);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    killSpy.mockRestore();
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('runs the bundled CLI under the bundled runtime when the platform package resolves', async () => {
    await importLauncher();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [runtime, commandArgs, options] = spawnMock.mock.calls[0];
    expect(String(runtime).replaceAll('\\', '/')).toContain(
      '/platform/pkg/bun',
    );
    expect(commandArgs[0].replaceAll('\\', '/')).toBe(
      '/platform/pkg/lib/cli-entry.js',
    );
    expect(commandArgs.slice(1)).toEqual(['--version']);
    expect(options.stdio).toBe('inherit');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

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
    expect(String(stderrSpy.mock.calls[0][0])).toContain('no prebuilt runtime');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to the node entry when the platform package is damaged', async () => {
    existsSyncMock.mockReturnValue(false);

    await importLauncher();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath);
    expect(String(stderrSpy.mock.calls[0][0])).toContain('damaged');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('mirrors the child exit code', async () => {
    await importLauncher();

    fakeChild.handlers['close'](7, null);
    expect(exitSpy).toHaveBeenCalledWith(7);
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
  });

  it('forwards terminating signals to the child on unix', async () => {
    setPlatform('linux');

    await importLauncher();

    const signals = onSpy.mock.calls.map((call) => call[0]);
    expect(signals).toEqual(
      expect.arrayContaining(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']),
    );
  });

  it('does not forward SIGINT on Windows, where the console already delivers it', async () => {
    setPlatform('win32');

    await importLauncher();

    const signals = onSpy.mock.calls.map((call) => call[0]);
    expect(signals).not.toContain('SIGINT');
    expect(signals).toContain('SIGTERM');
  });
});
