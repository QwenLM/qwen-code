/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, platformMock, existsSyncMock, writeFileSyncMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(() => ({ on: vi.fn() })),
    platformMock: vi.fn(() => 'darwin'),
    existsSyncMock: vi.fn(() => false),
    writeFileSyncMock: vi.fn(),
  }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    platform: platformMock,
    tmpdir: vi.fn(() => '/tmp'),
  };
});

vi.mock('node:fs', () => ({
  writeFileSync: writeFileSyncMock,
  mkdtempSync: vi.fn(() => '/tmp/qwen-dev-test'),
  rmSync: vi.fn(),
  existsSync: existsSyncMock,
  symlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => JSON.stringify({ version: '0.0.0-test' })),
}));

const normalizePath = (path) => String(path).replaceAll('\\', '/');

describe('scripts/dev.js launcher', () => {
  const originalArgv = process.argv;
  const execPathDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'execPath',
  );

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ['node', 'scripts/dev.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (execPathDescriptor) {
      Object.defineProperty(process, 'execPath', execPathDescriptor);
    }
  });

  it('spawns Node without a shell on Windows when local tsx cli.mjs exists', async () => {
    platformMock.mockReturnValue('win32');
    existsSyncMock.mockImplementation((filePath) =>
      normalizePath(filePath).endsWith('node_modules/tsx/dist/cli.mjs'),
    );
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: 'C:\\Program Files\\nodejs\\node.exe',
    });
    process.argv = ['node', 'scripts/dev.js', '--help'];

    await import('../dev.js?direct-node');

    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(args.map(normalizePath)).toEqual([
      expect.stringContaining('node_modules/tsx/dist/cli.mjs'),
      expect.stringContaining('packages/cli/index.ts'),
      '--help',
    ]);
    expect(options).toEqual(expect.objectContaining({ shell: false }));
  });

  it('keeps shell fallback for Windows tsx.cmd resolution', async () => {
    platformMock.mockReturnValue('win32');
    existsSyncMock.mockImplementation((filePath) =>
      normalizePath(filePath).endsWith('node_modules/.bin/tsx.cmd'),
    );

    await import('../dev.js?cmd-fallback');

    const [command, args, options] = spawnMock.mock.calls[0];
    expect(normalizePath(command)).toContain('tsx.cmd');
    expect(args.map(normalizePath)).toEqual([
      expect.stringContaining('packages/cli/index.ts'),
    ]);
    expect(options).toEqual(expect.objectContaining({ shell: true }));
  });

  it('re-raises a child signal instead of exiting 0 — close(null, SIGKILL) is not success', async () => {
    // `code ?? 0` read a signal-killed child as green. This launcher is a
    // QWEN_CODE_CLI entry now: an OOM-killed review gate command must not come
    // back as a passing exit.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await import('../dev.js?signal-close');
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
    // A dev CLI started from inside another qwen session's shell inherits that
    // session's QWEN_CODE_CLI. Honouring it points every `qwen …` subprocess of
    // THIS session at the OUTER session's build — the exact version skew the
    // variable exists to prevent, one level up and silent. Each entry stamps
    // itself; nested sessions each call their own build.
    const inherited = process.env.QWEN_CODE_CLI;
    process.env.QWEN_CODE_CLI = '/somewhere/else/entirely/qwen';
    try {
      await import('../dev.js?stamps-own-cli');

      const [, , options] = spawnMock.mock.calls[0];
      expect(normalizePath(options.env.QWEN_CODE_CLI)).toMatch(
        /scripts\/dev\.js$/,
      );
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inherited;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the dev entry executable for QWEN_CODE_CLI subprocesses',
    async () => {
      const fs = await vi.importActual('node:fs');
      expect(() =>
        fs.accessSync(new URL('../dev.js', import.meta.url), fs.constants.X_OK),
      ).not.toThrow();
    },
  );

  it('redirects file-backed core subpaths to source and named subpaths through exports', async () => {
    await import('../dev.js?loader-subpaths');
    const loaderSource = writeFileSyncMock.mock.calls.find(([filePath]) =>
      normalizePath(filePath).endsWith('/loader.mjs'),
    )[1];
    const loader = await import(
      `data:text/javascript,${encodeURIComponent(loaderSource)}`
    );
    const nextResolve = vi.fn(() => ({ url: 'fallback' }));

    expect(
      loader.resolve(
        '@qwen-code/qwen-code-core/utils/debugLogger.js',
        {},
        nextResolve,
      ),
    ).toEqual(
      expect.objectContaining({
        shortCircuit: true,
        url: expect.stringMatching(
          /packages\/core\/src\/utils\/debugLogger\.ts$/,
        ),
      }),
    );
    expect(
      loader.resolve('@qwen-code/qwen-code-core/goalWire', {}, nextResolve),
    ).toEqual({ url: 'fallback' });
  });
});
