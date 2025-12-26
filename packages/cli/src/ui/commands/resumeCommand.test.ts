/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resumeCommand } from './resumeCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('resumeCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the resume dialog', async () => {
    // Ensure the command has an action to test.
    if (!resumeCommand.action) {
      throw new Error('The resume command must have an action.');
    }

    const result = await resumeCommand.action(mockContext, '');

    // Assert that the action returns the correct object to trigger the resume dialog.
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'resume',
    });
  });

  it('should have the correct name and description', () => {
    expect(resumeCommand.name).toBe('resume');
    expect(resumeCommand.description).toBe('Resume a previous session');
  });
});
