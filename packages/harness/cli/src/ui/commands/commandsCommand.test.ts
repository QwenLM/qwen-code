/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandsCommand } from './commandsCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';

describe('commandsCommand', () => {
  let context: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createMockCommandContext({
      ui: {
        reloadCommands: vi.fn(),
        removeComponent: vi.fn(),
      },
    });
  });

  it('should call reloadCommands and return a custom_dialog', async () => {
    const result = await commandsCommand.action!(context, '');

    expect(context.ui.reloadCommands).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      type: 'custom_dialog',
    });
    expect(result).toHaveProperty('component');
  });

  it('should not have subCommands', () => {
    expect(commandsCommand.subCommands).toBeUndefined();
  });

  it('should have autoExecute enabled', () => {
    expect(commandsCommand.autoExecute).toBe(true);
  });

  it('should be safe for concurrent execution', () => {
    expect(commandsCommand.isSafeConcurrent).toBe(true);
  });
});
