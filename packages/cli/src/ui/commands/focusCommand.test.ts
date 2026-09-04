/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { focusCommand } from './focusCommand.js';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('focusCommand', () => {
  it('should have the correct metadata', () => {
    expect(focusCommand.name).toBe('focus');
    expect(focusCommand.description).toBe(
      'toggle focus mode (hide reasoning and tool call noise)',
    );
    expect(focusCommand.canRunDuringStreaming).toBe(true);
  });

  it('reports focus mode enabled when toggled on', async () => {
    const mockContext = createMockCommandContext({
      ui: {
        toggleFocusMode: vi.fn().mockResolvedValue(true),
      },
    });

    const result = await focusCommand.action!(mockContext, '');

    expect(mockContext.ui.toggleFocusMode).toHaveBeenCalledOnce();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Focus mode enabled. Reasoning and completed tool calls are hidden. Run /focus again to disable, or press Ctrl+O for the full transcript.',
    });
  });

  it('reports focus mode disabled when toggled off', async () => {
    const mockContext = createMockCommandContext({
      ui: {
        toggleFocusMode: vi.fn().mockResolvedValue(false),
      },
    });

    const result = await focusCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Focus mode disabled.',
    });
  });

  it('falls back to a settings write when the host has no toggleFocusMode', async () => {
    const mockContext = createMockCommandContext();
    delete mockContext.ui.toggleFocusMode;

    const result = await focusCommand.action!(mockContext, '');

    expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'ui.focusMode',
      true,
    );
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
  });
});
