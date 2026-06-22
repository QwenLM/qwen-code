/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { statuslineCommand } from './statuslineCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('statuslineCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should have the correct name and description', () => {
    expect(statuslineCommand.name).toBe('statusline');
    expect(statuslineCommand.description).toBeDefined();
  });

  it('should open the preset dialog when no args are provided', () => {
    if (!statuslineCommand.action) {
      throw new Error('statusline command must have an action');
    }

    const result = statuslineCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'statusline',
    });
  });

  it('should use user-provided args as the prompt', () => {
    if (!statuslineCommand.action) {
      throw new Error('statusline command must have an action');
    }

    const result = statuslineCommand.action(
      mockContext,
      'show model name and git branch',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [
        {
          text: expect.stringContaining('show model name and git branch'),
        },
      ],
    });
  });

  it('should open the preset dialog when args are whitespace only', () => {
    if (!statuslineCommand.action) {
      throw new Error('statusline command must have an action');
    }

    const result = statuslineCommand.action(mockContext, '   ');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'statusline',
    });
  });
});
