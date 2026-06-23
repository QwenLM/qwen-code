/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolNames } from './tool-names.js';
import { ReadMcpResourceTool } from './read-mcp-resource.js';

describe('ReadMcpResourceTool', () => {
  it('reads an MCP resource through the tool registry', async () => {
    const readMcpResource = vi.fn().mockResolvedValue({
      contents: [
        {
          uri: 'asight://skills/analyze_interconnect_desync.md',
          mimeType: 'text/markdown',
          text: 'resource body',
        },
      ],
    });
    const config = {
      getToolRegistry: () => ({ readMcpResource }),
    } as unknown as Config;
    const tool = new ReadMcpResourceTool(config);

    expect(tool.name).toBe(ToolNames.READ_MCP_RESOURCE);
    expect(tool.shouldDefer).toBe(false);
    expect(tool.schema.name).toBe(ToolNames.READ_MCP_RESOURCE);
    expect(tool.schema.parametersJsonSchema).toMatchObject({
      required: ['server_name', 'uri'],
    });

    const signal = new AbortController().signal;
    const invocation = tool.build({
      server_name: 'asys-mcp-http',
      uri: 'asight://skills/analyze_interconnect_desync.md',
    });
    const result = await invocation.execute(signal);

    expect(readMcpResource).toHaveBeenCalledWith(
      'asys-mcp-http',
      'asight://skills/analyze_interconnect_desync.md',
      { signal },
    );
    expect(result.llmContent).toContain('resource body');
    expect(result.returnDisplay).toBe(
      'Read resource asys-mcp-http:asight://skills/analyze_interconnect_desync.md',
    );
  });
});
