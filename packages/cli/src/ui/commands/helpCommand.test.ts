/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { helpCommand } from './helpCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind } from './types.js';

describe('helpCommand', () => {
  let mockContext: CommandContext;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockContext = createMockCommandContext({
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('should open the help dialog', async () => {
    if (!helpCommand.action) {
      throw new Error('Help command has no action');
    }

    await expect(helpCommand.action(mockContext, '')).resolves.toEqual({
      type: 'dialog',
      dialog: 'help',
    });
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });

  it('should ignore arguments because help has no subcommands', async () => {
    if (!helpCommand.action) {
      throw new Error('Help command has no action');
    }

    await expect(helpCommand.action(mockContext, 'commands')).resolves.toEqual({
      type: 'dialog',
      dialog: 'help',
    });
  });

  it('should have the correct command properties', () => {
    expect(helpCommand.name).toBe('help');
    expect(helpCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(helpCommand.argumentHint).toBeUndefined();
    expect(helpCommand.description).toBe('for help on Qwen Code');
  });
});
