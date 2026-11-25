/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { pluginsCommand } from './pluginsCommand.js';
import type { CommandContext } from './types.js';

describe('plugins validate slash command', () => {
  it('reports an empty plugin directory as a validation error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qwen-empty-plugin-'));
    try {
      const validate = pluginsCommand.subCommands?.find(
        (cmd) => cmd.name === 'validate',
      );

      const result = await validate?.action?.({} as CommandContext, dir);

      expect(result).toEqual(
        expect.objectContaining({
          type: 'local_command_result',
          severity: 'error',
          text: expect.stringContaining('No plugin content found'),
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
