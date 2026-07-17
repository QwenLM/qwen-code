/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, execSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn() })),
  execSyncMock: vi.fn(() => ''),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({ version: '0.0.0-test' })),
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
});
