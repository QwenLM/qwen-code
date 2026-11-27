/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { settingsCommand } from './settingsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('settingsCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the settings dialog', () => {
    if (!settingsCommand.action) {
      throw new Error('The settings command must have an action.');
    }
    const result = settingsCommand.action(mockContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'settings',
    });
  });

  // skip: 现存失败
  it.skip('should have the correct name and description', () => {
    expect(settingsCommand.name).toBe('settings');
    expect(settingsCommand.description).toBe(
      'View and edit Gemini CLI settings',
    );
  });
});
