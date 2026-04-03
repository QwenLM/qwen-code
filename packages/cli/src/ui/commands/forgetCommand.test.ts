/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  forgetManagedAutoMemoryMatches,
  selectManagedAutoMemoryForgetCandidates,
} from '@qwen-code/qwen-code-core';
import { forgetCommand } from './forgetCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
  forgetManagedAutoMemoryMatches: vi.fn(),
  selectManagedAutoMemoryForgetCandidates: vi.fn(),
}));

describe('forgetCommand', () => {
  it('returns usage error when no args are provided', async () => {
    const result = await forgetCommand.action?.(createMockCommandContext(), '   ');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /forget [--apply] <memory text to remove>',
    });
  });

  it('previews matching managed auto-memory entries by default', async () => {
    vi.mocked(selectManagedAutoMemoryForgetCandidates).mockResolvedValue({
      strategy: 'model',
      reasoning: 'Best semantic match.',
      matches: [{ topic: 'user', summary: 'User prefers terse responses.' }],
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

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: ['Forget preview (strategy=model):', 'Best semantic match.', '1. user: User prefers terse responses.', '', 'Run /forget --apply terse to apply these removals.'].join('\n'),
    });
  });

  it('removes matching managed auto-memory entries after --apply confirmation', async () => {
    vi.mocked(selectManagedAutoMemoryForgetCandidates).mockResolvedValue({
      strategy: 'heuristic',
      matches: [{ topic: 'user', summary: 'User prefers terse responses.' }],
    });
    vi.mocked(forgetManagedAutoMemoryMatches).mockResolvedValue({
      query: '',
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
      '--apply terse',
    );

    expect(selectManagedAutoMemoryForgetCandidates).toHaveBeenCalledWith(
      '/test/project',
      'terse',
      {
        config: expect.objectContaining({
          getProjectRoot: expect.any(Function),
        }),
      },
    );
    expect(forgetManagedAutoMemoryMatches).toHaveBeenCalledWith('/test/project', [
      { topic: 'user', summary: 'User prefers terse responses.' },
    ]);
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Managed auto-memory forgot 1 entry from user.md',
    });
  });
});
