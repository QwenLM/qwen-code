/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { focusCommand } from './focus-command.js';
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
        'Focus mode enabled. Ctrl+O shows full details; close that view to apply focus. Run /focus again to disable.',
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

  it('does not claim support or change settings when the host has no toggle', async () => {
    const mockContext = createMockCommandContext();
    delete mockContext.ui.toggleFocusMode;

    const result = await focusCommand.action!(mockContext, '');

    expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Focus mode is not supported by this renderer.',
    });
  });

  it('explains an overriding setting without claiming focus was toggled', async () => {
    const context = createMockCommandContext({
      ui: { toggleFocusMode: vi.fn().mockResolvedValue(null) },
    });
    expect(await focusCommand.action!(context, '')).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Focus mode is controlled by workspace or system settings. Change the overriding setting to toggle focus.',
    });
  });
});
