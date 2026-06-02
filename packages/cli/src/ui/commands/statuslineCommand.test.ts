/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { statuslineCommand } from './statuslineCommand.js';
import { type CommandContext, type SubmitPromptActionReturn } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { SettingScope } from '../../config/settings.js';

describe('statuslineCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        settings: {
          merged: {},
          setValue: vi.fn(),
          reloadScopeFromDisk: vi.fn(),
        },
      },
      ui: {
        notifyStatusLineReloaded: vi.fn(),
      },
    });
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
      onComplete: expect.any(Function),
    });
  });

  it('onComplete should reload settings from disk and notify statusline', async () => {
    if (!statuslineCommand.action) {
      throw new Error('statusline command must have an action');
    }

    const result = statuslineCommand.action(
      mockContext,
      'show git branch',
    ) as SubmitPromptActionReturn;

    expect(result.onComplete).toBeDefined();
    await result.onComplete!();

    const reloadMock = mockContext.services.settings
      .reloadScopeFromDisk as ReturnType<typeof vi.fn>;
    const notifyMock = mockContext.ui.notifyStatusLineReloaded as ReturnType<
      typeof vi.fn
    >;
    expect(reloadMock).toHaveBeenCalledWith(SettingScope.User);
    expect(notifyMock).toHaveBeenCalled();
    expect(reloadMock.mock.invocationCallOrder[0]).toBeLessThan(
      notifyMock.mock.invocationCallOrder[0]!,
    );
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
