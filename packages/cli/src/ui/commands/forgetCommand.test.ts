/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { forgetCommand } from './forgetCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('forgetCommand', () => {
  it('returns error when no argument is given', async () => {
    const context = createMockCommandContext();
    const result = await forgetCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('/forget'),
    });
  });

  it('returns error when config is not loaded', async () => {
    const context = createMockCommandContext({ services: { config: null } });
    const result = await forgetCommand.action?.(context, 'something');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Config'),
    });
  });

  it('returns info message on successful forget', async () => {
    const context = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue('/tmp/test-project'),
          getMemoryManager: vi.fn().mockReturnValue({
            selectForgetCandidates: vi
              .fn()
              .mockResolvedValue({ matches: [{ id: '1' }] }),
            forgetMatches: vi
              .fn()
              .mockResolvedValue({ systemMessage: 'Forgot 1 entry.' }),
          }),
        },
      },
    });
    const result = await forgetCommand.action?.(context, 'old preference');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Forgot 1 entry.',
    });
  });

  it('returns fallback message when no entries match', async () => {
    const context = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue('/tmp/test-project'),
          getMemoryManager: vi.fn().mockReturnValue({
            selectForgetCandidates: vi.fn().mockResolvedValue({ matches: [] }),
            forgetMatches: vi.fn().mockResolvedValue({ systemMessage: null }),
          }),
        },
      },
    });
    const result = await forgetCommand.action?.(context, 'nonexistent');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('nonexistent'),
    });
  });

  it('returns error message when memory manager throws', async () => {
    const context = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue('/tmp/test-project'),
          getMemoryManager: vi.fn().mockReturnValue({
            selectForgetCandidates: vi
              .fn()
              .mockRejectedValue(new Error('EACCES: permission denied')),
          }),
        },
      },
    });
    const result = await forgetCommand.action?.(context, 'something');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('EACCES: permission denied'),
    });
  });

  it('declares acp in supportedModes', () => {
    expect(forgetCommand.supportedModes).toEqual(['interactive', 'acp']);
  });
});
