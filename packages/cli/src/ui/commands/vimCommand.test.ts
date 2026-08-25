/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { vimCommand } from './vimCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('vimCommand', () => {
  it('should have the correct metadata', () => {
    expect(vimCommand.name).toBe('vim');
    expect(vimCommand.description).toBe('toggle vim mode on/off');
    expect(vimCommand.canRunDuringStreaming).toBe(true);
  });

  it('should report entering vim mode when toggled on', async () => {
    const mockContext = createMockCommandContext({
      ui: {
        toggleVimEnabled: vi.fn().mockResolvedValue(true),
      },
    });

    const result = await vimCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Entered Vim mode. Run /vim again to exit.',
    });
  });

  it('should report exiting vim mode when toggled off', async () => {
    const mockContext = createMockCommandContext({
      ui: {
        toggleVimEnabled: vi.fn().mockResolvedValue(false),
      },
    });

    const result = await vimCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Exited Vim mode.',
    });
  });
});
