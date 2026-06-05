/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { rememberCommand } from './rememberCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('rememberCommand', () => {
  it('returns error when no argument is given', () => {
    const context = createMockCommandContext();
    const result = rememberCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('/remember'),
    });
  });

  it('returns submit_prompt for managed auto-memory', () => {
    const context = createMockCommandContext({
      services: {
        config: {
          getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(true),
          getProjectRoot: vi.fn().mockReturnValue('/tmp/test-project'),
        },
      },
    });
    const result = rememberCommand.action?.(context, 'user prefers dark mode');
    expect(result).toMatchObject({
      type: 'submit_prompt',
      content: expect.stringContaining('user prefers dark mode'),
    });
  });

  it('returns submit_prompt for non-managed memory (QWEN.md fallback)', () => {
    const context = createMockCommandContext({
      services: {
        config: {
          getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(false),
          getProjectRoot: vi.fn().mockReturnValue('/tmp/test-project'),
        },
      },
    });
    const result = rememberCommand.action?.(context, 'some fact');
    expect(result).toMatchObject({
      type: 'submit_prompt',
      content: expect.stringContaining('some fact'),
    });
  });

  it('declares acp in supportedModes', () => {
    expect(rememberCommand.supportedModes).toEqual(['interactive', 'acp']);
  });
});
