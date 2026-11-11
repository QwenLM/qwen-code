/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { hooksCommand } from './hooksCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import { CommandKind } from './types.js';

describe('hooksCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getHookSystem: () => null,
          },
        },
      },
    });
  });

  it('should have the correct name and description', () => {
    expect(hooksCommand.name).toBe('hooks');
    expect(hooksCommand.description).toBe('Open hooks management panel');
  });

  it('should be a built-in command', () => {
    expect(hooksCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should have autoExecute enabled', () => {
    expect(hooksCommand.autoExecute).toBe(true);
  });

  it('should have no subcommands', () => {
    expect(hooksCommand.subCommands).toBeUndefined();
  });

  it('should return hookBrowser dialog when config is available', async () => {
    const result = await hooksCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'hookBrowser',
    });
  });

  it('should return error when agentContext is null', async () => {
    const contextWithoutConfig = createMockCommandContext({
      services: {
        agentContext: null,
      },
    });

    const result = await hooksCommand.action!(contextWithoutConfig, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  it('should return error when config is not available', async () => {
    const contextWithoutConfig = createMockCommandContext({
      services: {
        agentContext: { config: undefined },
      },
    });

    const result = await hooksCommand.action!(contextWithoutConfig, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  it('should return hookBrowser dialog regardless of arguments', async () => {
    const result = await hooksCommand.action!(mockContext, 'some-arg');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'hookBrowser',
    });
  });
});
