/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cliEntryPattern = /packages[\\/]cli[\\/]index\.ts$/;
const localTsxCliPattern = /node_modules[\\/]tsx[\\/]dist[\\/]cli\.mjs$/;
const localTsxCmdPattern = /node_modules[\\/]\.bin[\\/]tsx\.cmd$/;

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
      localTsxCliPattern.test(String(filePath)),
    );
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: 'C:\\Program Files\\nodejs\\node.exe',
    });
    process.argv = ['node', 'scripts/dev.js', '--help'];

    await import('../dev.js?direct-node');

    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      [
        expect.stringMatching(localTsxCliPattern),
        expect.stringMatching(cliEntryPattern),
        '--help',
      ],
      expect.objectContaining({ shell: false }),
    );
  });

  it('keeps shell fallback for Windows tsx.cmd resolution', async () => {
    platformMock.mockReturnValue('win32');
    existsSyncMock.mockImplementation((filePath) =>
      localTsxCmdPattern.test(String(filePath)),
    );

    await import('../dev.js?cmd-fallback');

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(/tsx\.cmd$/),
      [expect.stringMatching(cliEntryPattern)],
      expect.objectContaining({ shell: true }),
    );
  });
});
