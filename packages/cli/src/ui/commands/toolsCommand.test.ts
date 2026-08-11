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
          getToolRegistry: () => ({ getAllTools: () => [] as Tool[] }),
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
      },
      expect.any(Number),
    );
  });

  it('should list tools without descriptions by default', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({ getAllTools: () => mockTools }),
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

  it('should list tools with descriptions when "desc" arg is passed', async () => {
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({ getAllTools: () => mockTools }),
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

  it('flags hidden media-policy tools as fixedOnly, but not model-enabled ones', async () => {
    const mediaTools = [
      {
        name: 'omni_downsample_image',
        displayName: 'DownsampleImage',
        description: 'Downsamples an image.',
        schema: {},
        // Media-policy tool with no modelAccess entry → hidden from the
        // model's declarations → must surface as fixed-only in /tools.
        mediaPolicyDescriptor: {
          kind: 'media_policy',
          inputMediaTypes: ['image'],
          outputs: [],
        },
      },
      {
        name: 'omni_probe_media',
        displayName: 'ProbeMedia',
        description: 'Probes media metadata.',
        schema: {},
        // Same descriptor, but modelAccess.enabled below re-exposes it to
        // the model, so it must NOT carry the fixed-only marker.
        mediaPolicyDescriptor: {
          kind: 'media_policy',
          inputMediaTypes: ['image'],
          outputs: [],
        },
      },
      ...mockTools,
    ] as Tool[];
    const mockContext = createMockCommandContext({
      services: {
        config: {
          getToolRegistry: () => ({ getAllTools: () => mediaTools }),
          getOmniPolicyToolsSettings: () => ({
            omni_probe_media: { modelAccess: { enabled: true } },
          }),
        },
      },
    });

    if (!toolsCommand.action) throw new Error('Action not defined');
    await toolsCommand.action(mockContext, '');

    const [message] = (mockContext.ui.addItem as vi.Mock).mock.calls[0];
    expect(message.tools).toHaveLength(4);
    expect(message.tools[0]).toMatchObject({
      name: 'omni_downsample_image',
      fixedOnly: true,
    });
    expect(message.tools[1].fixedOnly).toBeUndefined();
    expect(message.tools[2].fixedOnly).toBeUndefined();
    expect(message.tools[3].fixedOnly).toBeUndefined();
  });
});
