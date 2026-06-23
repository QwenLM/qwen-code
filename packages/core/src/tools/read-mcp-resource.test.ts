/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { ToolNames } from './tool-names.js';
import { ReadMcpResourceTool } from './read-mcp-resource.js';

function configWith(readMcpResource: unknown): Config {
  return {
    getToolRegistry: () => ({ readMcpResource }),
  } as unknown as Config;
}

describe('ReadMcpResourceTool', () => {
  it('reads an MCP resource and returns framed content parts', async () => {
    const readMcpResource = vi.fn().mockResolvedValue({
      contents: [
        {
          uri: 'asight://skills/analyze_interconnect_desync.md',
          mimeType: 'text/markdown',
          text: 'resource body',
        },
      ],
    });
    const tool = new ReadMcpResourceTool(configWith(readMcpResource));

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

    // llmContent is structured Part[] (not a raw JSON dump): the body text is
    // present verbatim and wrapped in attribution delimiters.
    const parts = result.llmContent as Part[];
    expect(Array.isArray(parts)).toBe(true);
    const texts = parts.map((p) => (p as { text?: string }).text ?? '');
    expect(texts).toContain('resource body');
    expect(texts.join('')).toContain(
      '--- Content from MCP resource asys-mcp-http:asight://skills/analyze_interconnect_desync.md ---',
    );
    expect(result.returnDisplay).toBe(
      'Read resource asys-mcp-http:asight://skills/analyze_interconnect_desync.md',
    );
  });

  it('surfaces a base64 blob as an inlineData media part, not raw text', async () => {
    const readMcpResource = vi.fn().mockResolvedValue({
      contents: [
        {
          uri: 'asight://images/diagram.png',
          mimeType: 'image/png',
          blob: 'aGVsbG8=',
        },
      ],
    });
    const tool = new ReadMcpResourceTool(configWith(readMcpResource));

    const invocation = tool.build({
      server_name: 'asys-mcp-http',
      uri: 'asight://images/diagram.png',
    });
    const result = await invocation.execute(new AbortController().signal);

    const parts = result.llmContent as Part[];
    const inline = parts.find((p) => 'inlineData' in (p as object)) as {
      inlineData?: { mimeType: string; data: string };
    };
    expect(inline?.inlineData).toEqual({
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    });
  });

  it('reports no readable content when the resource has none', async () => {
    const readMcpResource = vi.fn().mockResolvedValue({ contents: [] });
    const tool = new ReadMcpResourceTool(configWith(readMcpResource));

    const invocation = tool.build({
      server_name: 'asys-mcp-http',
      uri: 'asight://empty',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toBe('(no readable content)');
  });

  it.each([
    ["MCP server 'asys-mcp-http' is not configured."],
    ["MCP server 'asys-mcp-http' is disabled."],
    ['MCP resources are unavailable in untrusted folders.'],
  ])('propagates the read error: %s', async (message) => {
    const readMcpResource = vi.fn().mockRejectedValue(new Error(message));
    const tool = new ReadMcpResourceTool(configWith(readMcpResource));

    const invocation = tool.build({
      server_name: 'asys-mcp-http',
      uri: 'asight://skills/x.md',
    });
    // The tool relies on the scheduler's outer try/catch to turn a thrown read
    // error into an error tool-card; assert the clear message propagates.
    await expect(
      invocation.execute(new AbortController().signal),
    ).rejects.toThrow(message);
  });
});
