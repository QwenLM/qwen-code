/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { rewindCommand } from './rewindCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('rewindCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the rewind dialog', async () => {
    if (!rewindCommand.action) {
      throw new Error('The rewind command must have an action.');
    }

    const result = await rewindCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'rewind',
    });
  });

  it('should have the correct name and description', () => {
    expect(rewindCommand.name).toBe('rewind');
    expect(rewindCommand.description).toBe(
      'Browse prompts in the current conversation and fork from one',
    );
  });
});
