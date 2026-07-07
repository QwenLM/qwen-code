/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { learnCommand } from './learn-command.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { SubmitPromptActionReturn } from './types.js';
import { CommandKind } from './types.js';

describe('learnCommand', () => {
  it('has correct metadata', () => {
    expect(learnCommand.name).toBe('learn');
    expect(learnCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(learnCommand.supportedModes).toContain('interactive');
    expect(learnCommand.supportedModes).toContain('acp');
    expect(learnCommand.argumentHint).toMatch(/path|URL|text/i);
  });

  it('returns an error when no args are provided', async () => {
    const ctx = createMockCommandContext();
    const result = await learnCommand.action!(ctx, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
  });

  it('returns an error when config is not loaded', async () => {
    const ctx = createMockCommandContext({ services: { config: null } });
    const result = await learnCommand.action!(ctx, 'https://example.com/docs');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringMatching(/config/i),
    });
  });

  it('returns submit_prompt when config is available', async () => {
    const ctx = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: () => '/tmp/test-project',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    const result = await learnCommand.action!(ctx, 'https://example.com/docs');
    expect(result).toMatchObject({
      type: 'submit_prompt',
    });
    expect((result as SubmitPromptActionReturn).content).toContain(
      'https://example.com/docs',
    );
  });
});
