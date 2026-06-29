/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, platformMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn() })),
  platformMock: vi.fn(() => 'darwin'),
  existsSyncMock: vi.fn(() => false),
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
  writeFileSync: vi.fn(),
  mkdtempSync: vi.fn(() => '/tmp/qwen-dev-test'),
  rmSync: vi.fn(),
  existsSync: existsSyncMock,
  symlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
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
});
