/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const { spawnMock, execSyncMock, rmSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn() })),
  execSyncMock: vi.fn(() => ''),
  rmSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({ version: '0.0.0-test' })),
  rmSync: rmSyncMock,
}));

const normalizePath = (path) => String(path).replaceAll('\\', '/');

describe('scripts/start.js launcher', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ['node', 'scripts/start.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('re-raises a child signal instead of exiting 0 — close(null, SIGKILL) is not success', async () => {
    // The old handler was `process.exit(code)`; a signal-killed child passes
    // `code === null` and `process.exit(null)` coerces to a green exit — a
    // killed review gate command mistaken for success.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await import('../start.js?signal-close');
      const child = spawnMock.mock.results[0].value;
      const close = child.on.mock.calls.find(([ev]) => ev === 'close')[1];
      close(null, 'SIGKILL');
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL');
      expect(exitSpy).not.toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      killSpy.mockRestore();
    }
  });

  it('stamps QWEN_CODE_CLI with its own path, overriding an inherited one', async () => {
    // Same property dev.test.js pins for scripts/dev.js, on the entry with no
    // other coverage of its env block: `npm start` runs `node packages/cli`
    // directly — no bin wrapper anywhere in that chain — so this launcher is the
    // only thing that can publish the entry, and an inherited value is another
    // session's CLI, which every subprocess would then call instead of this one.
    const inherited = process.env.QWEN_CODE_CLI;
    process.env.QWEN_CODE_CLI = '/somewhere/else/entirely/qwen';
    try {
      await import('../start.js?stamps-own-cli');

      const [, , options] = spawnMock.mock.calls[0];
      expect(normalizePath(options.env.QWEN_CODE_CLI)).toMatch(
        /scripts\/start\.js$/,
      );
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inherited;
    }
  });

  it('passes one scoped warnings file to the checker and child process', async () => {
    await import('../start.js?scopes-startup-warnings');

    const [, checkerOptions] = execSyncMock.mock.calls[0];
    const [, , childOptions] = spawnMock.mock.calls[0];
    const checkerPath = checkerOptions.env.QWEN_CODE_WARNINGS_FILE;

    expect(checkerPath).toBe(childOptions.env.QWEN_CODE_WARNINGS_FILE);
    expect(isAbsolute(checkerPath)).toBe(true);
    expect(dirname(checkerPath)).toBe(tmpdir());
    expect(normalizePath(checkerPath)).toMatch(
      /qwen-code-warnings-\d+-[0-9a-f-]+\.txt$/,
    );

    await import('../start.js?scopes-startup-warnings-second');
    const checkerCalls = execSyncMock.mock.calls.filter(
      ([command]) => command === 'node ./scripts/check-build-status.js',
    );
    expect(checkerCalls).toHaveLength(2);
    expect(checkerCalls[1][1].env.QWEN_CODE_WARNINGS_FILE).not.toBe(
      checkerPath,
    );
  });

  it('cleans up the scoped warnings file when the child closes', async () => {
    await import('../start.js?cleans-startup-warnings');

    const child = spawnMock.mock.results[0].value;
    const close = child.on.mock.calls.find(([ev]) => ev === 'close')[1];
    const [, checkerOptions] = execSyncMock.mock.calls[0];
    const warningsPath = checkerOptions.env.QWEN_CODE_WARNINGS_FILE;

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    try {
      rmSyncMock.mockImplementationOnce(() => {
        throw new Error('EBUSY');
      });
      expect(rmSyncMock).not.toHaveBeenCalled();
      close(0, null);
      expect(rmSyncMock).toHaveBeenCalledWith(warningsPath, { force: true });
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
