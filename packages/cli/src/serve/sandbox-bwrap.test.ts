/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { start_sandbox } from './sandbox.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('retired whole-CLI bwrap launcher', () => {
  it.each([undefined, 'bwrap', 'docker'])(
    'rejects before spawn with inherited SANDBOX=%s',
    async (inherited) => {
      vi.stubEnv('SANDBOX', inherited);
      await expect(
        start_sandbox({ command: 'bwrap' }, [], undefined, [
          process.execPath,
          '/installed/cli.js',
          '--prompt',
          'write a file',
        ]),
      ).rejects.toThrow(
        /Whole-CLI bwrap has been removed.*tools.executionSandbox/,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );
});
