/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { deleteCommand } from './deleteCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('deleteCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should have the correct name and description', () => {
    expect(deleteCommand.name).toBe('delete');
    expect(deleteCommand.description).toBe('Delete a previous session');
  });

  it('should return a dialog action to open the delete dialog', async () => {
    const result = await deleteCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'delete',
    });
  });
});
