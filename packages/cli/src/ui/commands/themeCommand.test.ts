/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import process from 'node:process';
import { themeCommand } from './themeCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('themeCommand', () => {
  let mockContext: CommandContext;
  const previousNoColor = process.env['NO_COLOR'];

  beforeEach(() => {
    mockContext = createMockCommandContext();
    delete process.env['NO_COLOR'];
  });

  afterEach(() => {
    if (previousNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = previousNoColor;
  });

  it('should return a dialog action to open the theme dialog', () => {
    // Ensure the command has an action to test.
    if (!themeCommand.action) {
      throw new Error('The theme command must have an action.');
    }

    const result = themeCommand.action(mockContext, '');

    // Assert that the action returns the correct object to trigger the theme dialog.
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'theme',
    });
  });

  it('returns a message instead of opening the dialog when NO_COLOR is set', () => {
    if (!themeCommand.action) {
      throw new Error('The theme command must have an action.');
    }
    process.env['NO_COLOR'] = '1';

    const result = themeCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Theme configuration unavailable due to NO_COLOR env variable.',
    });
  });

  it('should have the correct name and description', () => {
    expect(themeCommand.name).toBe('theme');
    expect(themeCommand.description).toBe('change the theme');
    expect(themeCommand.canRunDuringStreaming).toBe(true);
  });
});
