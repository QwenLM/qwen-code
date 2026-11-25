/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { toolsCommand } from './toolsCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { ToolBuilder, ToolResult } from '@qwen-code/core';

// Mock tools for testing
const mockTools = [
  {
    name: 'file-reader',
    displayName: 'File Reader',
    description: 'Reads files from the local system.',
    schema: {},
  },
  {
    name: 'code-editor',
    displayName: 'Code Editor',
    description: 'Edits code files.',
    schema: {},
  },
] as unknown as Array<ToolBuilder<object, ToolResult>>;

describe('toolsCommand', () => {
  it('should display an error if the tool registry is unavailable', async () => {
    const mockContext = createMockCommandContext({
      services: {
        agentContext: {
          toolRegistry: undefined,
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith({
      type: MessageType.ERROR,
      text: 'Could not retrieve tool registry.',
    });
  });

  it('should return a fullscreen_dialog when tools are available', async () => {
    const mockContext = createMockCommandContext({
      services: {
        agentContext: {
          toolRegistry: { getAllTools: () => mockTools },
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    const result = await toolsCommand.action(mockContext, '');

    expect(result).toBeDefined();
    expect(result).toHaveProperty('type', 'custom_dialog');
    expect(result).toHaveProperty('component');
  });

  it('should return a fullscreen_dialog with empty tools list', async () => {
    const mockContext = createMockCommandContext({
      services: {
        agentContext: {
          toolRegistry: {
            getAllTools: () => [] as Array<ToolBuilder<object, ToolResult>>,
          },
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    const result = await toolsCommand.action(mockContext, '');

    expect(result).toBeDefined();
    expect(result).toHaveProperty('type', 'custom_dialog');
    expect(result).toHaveProperty('component');
  });

  it('should not have subcommands', () => {
    expect(toolsCommand.subCommands).toBeUndefined();
  });
});
