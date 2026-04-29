/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { manageModelsCommand } from './manageModelsCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('manageModelsCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the manage-models dialog', () => {
    if (!manageModelsCommand.action) {
      throw new Error('The manage-models command must have an action.');
    }

    const result = manageModelsCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'manage-models',
    });
  });

  it('should have the correct name and description', () => {
    expect(manageModelsCommand.name).toBe('manage-models');
    expect(manageModelsCommand.description).toBe(
      'Browse dynamic model catalogs and choose which models stay enabled locally',
    );
  });
});
