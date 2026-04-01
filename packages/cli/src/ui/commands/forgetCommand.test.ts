/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { forgetManagedAutoMemoryEntries } from '@qwen-code/qwen-code-core';
import { forgetCommand } from './forgetCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
  forgetManagedAutoMemoryEntries: vi.fn(),
}));

describe('forgetCommand', () => {
  it('returns usage error when no args are provided', async () => {
    const result = await forgetCommand.action?.(createMockCommandContext(), '   ');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /forget <memory text to remove>',
    });
  });

  it('removes matching managed auto-memory entries', async () => {
    vi.mocked(forgetManagedAutoMemoryEntries).mockResolvedValue({
      query: 'terse',
      removedEntries: [{ topic: 'user', summary: 'User prefers terse responses.' }],
      touchedTopics: ['user'],
      systemMessage: 'Managed auto-memory forgot 1 entry from user.md',
    });

    const result = await forgetCommand.action?.(
      createMockCommandContext({
        services: {
          config: {
            getProjectRoot: vi.fn().mockReturnValue('/test/project'),
          },
        },
      }),
      'terse',
    );

    expect(forgetManagedAutoMemoryEntries).toHaveBeenCalledWith('/test/project', 'terse');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Managed auto-memory forgot 1 entry from user.md',
    });
  });
});
