/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { dreamCommand } from './dreamCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('dreamCommand', () => {
  it('declares acp in supportedModes', () => {
    expect(dreamCommand.supportedModes).toEqual(['interactive', 'acp']);
  });

  it('returns error when config is not loaded', async () => {
    const context = createMockCommandContext({ services: { config: null } });
    const result = await dreamCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Config'),
    });
  });

  it.each([
    ['interactive', 'legacy'],
    ['acp', 'legacy'],
    ['interactive', 'structured'],
  ] as const)(
    'uses the runtime-managed dream in %s with %s recall',
    async (executionMode, recallMode) => {
      const projectRoot = '/dream-project';
      const runManualDream = vi.fn().mockResolvedValue({
        systemMessage: 'Managed auto-memory dream (agent): consolidated',
      });
      const abortSignal = new AbortController().signal;
      const context = createMockCommandContext({
        executionMode,
        abortSignal,
        services: {
          config: {
            getProjectRoot: () => projectRoot,
            getMemoryRecallMode: () => recallMode,
            getMemoryManager: () => ({ runManualDream }),
            getSessionId: () => 'session-1',
          },
        },
      });

      const result = await dreamCommand.action?.(context, '');

      expect(runManualDream).toHaveBeenCalledWith(
        projectRoot,
        context.services.config,
        'session-1',
        undefined,
        abortSignal,
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Managed auto-memory dream (agent): consolidated',
      });
    },
  );
});
