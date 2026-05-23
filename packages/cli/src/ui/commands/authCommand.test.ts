/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { authCommand } from './authCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('authCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the auth dialog', () => {
    if (!authCommand.action) {
      throw new Error('The auth command must have an action.');
    }

    const result = authCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'auth',
    });
  });

  it('should return a dialog action when execution mode is undefined', () => {
    if (!authCommand.action) {
      throw new Error('The auth command must have an action.');
    }

    mockContext.executionMode = undefined;
    const result = authCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'auth',
    });
  });

  it.each(['non_interactive', 'acp'] as const)(
    'should return an info message in %s mode',
    (executionMode) => {
      if (!authCommand.action) {
        throw new Error('The auth command must have an action.');
      }

      mockContext.executionMode = executionMode;
      const result = authCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'Authentication configuration is only available in interactive mode. To configure authentication, run Qwen Code interactively and use /auth, or set environment variables: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL.',
      });
    },
  );

  it('should support interactive, non-interactive, and ACP modes', () => {
    expect(authCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('should have the correct name and description', () => {
    expect(authCommand.name).toBe('auth');
    expect(authCommand.description).toBe(
      'Configure authentication information for login',
    );
  });
});
