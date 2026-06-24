/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { ToolNames } from './tool-names.js';
import { ReadMcpResourceTool } from './read-mcp-resource.js';
import {
  MAX_MCP_RESOURCE_BLOB_CHARS,
  MAX_MCP_RESOURCE_TEXT_CHARS,
} from './mcp-resource-content.js';

const inlineCount = (llmContent: unknown) =>
  Array.isArray(llmContent)
    ? (llmContent as Part[]).filter((p) => 'inlineData' in (p as object)).length
    : 0; // empty read → llmContent is the diagnostic string, not parts

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
    // Deferred (discovered via tool_search) like web_fetch — infrequent.
    expect(tool.shouldDefer).toBe(true);
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
    // Nonce-attributed opening delimiter (value after the label is random).
    expect(texts.join('')).toContain(
      '--- Content from MCP resource asys-mcp-http:asight://skills/analyze_interconnect_desync.md [',
    );
    // returnDisplay mirrors the summary so a success card never hides what was
    // actually injected ('resource body' is 13 chars).
    expect(result.returnDisplay).toBe(
      'Read resource asys-mcp-http:asight://skills/analyze_interconnect_desync.md — Injected 13 chars',
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

    // Empty read still surfaces an attributed diagnostic to the model (matches
    // the `@server:uri` path), not a bare/absent string.
    expect(result.llmContent).toBe(
      '\n--- MCP resource asys-mcp-http:asight://empty: (no readable content) ---\n',
    );
  });

  it('exposes the read target to the AUTO-mode classifier', () => {
    const tool = new ReadMcpResourceTool(configWith(vi.fn()));
    expect(
      tool.toAutoClassifierInput({ server_name: 'srv', uri: 'x://a' }),
    ).toEqual({ server_name: 'srv', uri: 'x://a' });
  });

  it('overrides maxOutputChars so the scheduler does not slice the frame', () => {
    const tool = new ReadMcpResourceTool(configWith(vi.fn()));
    expect(tool.maxOutputChars).toBeGreaterThan(MAX_MCP_RESOURCE_TEXT_CHARS);
  });

  it('shares a per-turn blob budget across calls on the same signal', async () => {
    // One 8 MB blob (shared reference) fills roughly one call's worth of the
    // ~3-call turn budget. The fourth read on the same signal is starved.
    const bigBlob = 'A'.repeat(MAX_MCP_RESOURCE_BLOB_CHARS);
    const readMcpResource = vi.fn().mockResolvedValue({
      contents: [{ uri: 'x://b', blob: bigBlob, mimeType: 'image/png' }],
    });
    const tool = new ReadMcpResourceTool(configWith(readMcpResource));
    const signal = new AbortController().signal;

    const blobCounts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await tool
        .build({ server_name: 'srv', uri: `x://${i}` })
        .execute(signal);
      blobCounts.push(inlineCount(result.llmContent));
    }

    // First three calls fit (budget = 3× per-call cap); the fourth is skipped.
    expect(blobCounts).toEqual([1, 1, 1, 0]);
  });

  it('does not share the blob budget across different signals (turns)', async () => {
    const bigBlob = 'A'.repeat(MAX_MCP_RESOURCE_BLOB_CHARS);
    const readMcpResource = vi.fn().mockResolvedValue({
      contents: [{ uri: 'x://b', blob: bigBlob, mimeType: 'image/png' }],
    });
    const tool = new ReadMcpResourceTool(configWith(readMcpResource));

    // Exhaust one turn's budget...
    const signalA = new AbortController().signal;
    for (let i = 0; i < 4; i++) {
      await tool
        .build({ server_name: 'srv', uri: `x://${i}` })
        .execute(signalA);
    }
    // ...a fresh turn (new signal) starts with a full budget again.
    const signalB = new AbortController().signal;
    const result = await tool
      .build({ server_name: 'srv', uri: 'x://fresh' })
      .execute(signalB);
    expect(inlineCount(result.llmContent)).toBe(1);
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
