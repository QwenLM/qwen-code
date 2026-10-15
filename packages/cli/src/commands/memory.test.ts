/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it } from 'vitest';
import yargs from 'yargs';
import { memoryCommand } from './memory.js';

it.each(['bare', 'safe-mode'])(
  'rejects confirmed import in %s before reading sources or authenticating',
  async (flag) => {
    await expect(
      yargs([`--${flag}`, 'memory', 'import', 'codex', '--apply'])
        .option(flag, { type: 'boolean' })
        .command(memoryCommand)
        .exitProcess(false)
        .fail((message, error) => {
          throw error ?? new Error(message);
        })
        .parseAsync(),
    ).rejects.toThrow('unavailable in bare or safe mode');
  },
);
