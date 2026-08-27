/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { toolsCommand } from './toolsCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { Tool } from '@qwen-code/qwen-code-core';

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
] as Tool[];

describe('toolsCommand', () => {
  it('opts in to running during streaming', () => {
    expect(toolsCommand.canRunDuringStreaming).toBe(true);
  });

  it('should display an error if the tool registry is unavailable', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => undefined,
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: 'Could not retrieve tool registry.',
      },
      expect.any(Number),
    );
  });

  it('should display "No tools available" when none are found', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({
            getAllTools: () => [] as Tool[],
            isDeferredAndHidden: () => false,
            getTool: (name: string) =>
              name === 'tool_search' ? ({} as Tool) : undefined,
          }),
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.TOOLS_LIST,
        tools: [],
        showDescriptions: false,
        toolSearchAvailable: true,
      },
      expect.any(Number),
    );
  });

  it('should list tools without descriptions by default', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({
            getAllTools: () => mockTools,
            isDeferredAndHidden: () => false,
            getTool: (name: string) =>
              name === 'tool_search' ? ({} as Tool) : undefined,
          }),
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, '');

    const [message] = (mockContext.ui.addItem as vi.Mock).mock.calls[0];
    expect(message.type).toBe(MessageType.TOOLS_LIST);
    expect(message.showDescriptions).toBe(false);
    expect(message.tools).toHaveLength(2);
    expect(message.tools[0].displayName).toBe('File Reader');
    expect(message.tools[1].displayName).toBe('Code Editor');
  });

  it('marks deferred tools so a tools.eager allowlist is visible (#10075)', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({
            getAllTools: () => mockTools,
            isDeferredAndHidden: (name: string) => name === 'code-editor',
            getTool: (name: string) =>
              name === 'tool_search' ? ({} as Tool) : undefined,
          }),
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, '');

    const [message] = (mockContext.ui.addItem as vi.Mock).mock.calls[0];
    expect(message.tools[0].deferred).toBe(false);
    expect(message.tools[1].deferred).toBe(true);
  });

  it('reports tool_search as unavailable so the footnote drops its promise', async () => {
    // With tool_search denied, an on-demand tool has no loading path left.
    // The view must say that instead of promising a load that cannot happen.
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({
            getAllTools: () => mockTools,
            isDeferredAndHidden: (name: string) => name === 'code-editor',
            getTool: () => undefined,
          }),
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, '');

    const [message] = (mockContext.ui.addItem as vi.Mock).mock.calls[0];
    expect(message.toolSearchAvailable).toBe(false);
    expect(message.tools[1].deferred).toBe(true);
  });

  it('should list tools with descriptions when "desc" arg is passed', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({
            getAllTools: () => mockTools,
            isDeferredAndHidden: () => false,
            getTool: (name: string) =>
              name === 'tool_search' ? ({} as Tool) : undefined,
          }),
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, 'desc');

    const [message] = (mockContext.ui.addItem as vi.Mock).mock.calls[0];
    expect(message.type).toBe(MessageType.TOOLS_LIST);
    expect(message.showDescriptions).toBe(true);
    expect(message.tools).toHaveLength(2);
    expect(message.tools[0].description).toBe(
      'Reads files from the local system.',
    );
    expect(message.tools[1].description).toBe('Edits code files.');
  });
});
