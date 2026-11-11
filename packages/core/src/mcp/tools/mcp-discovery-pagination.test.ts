/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { McpClientContext } from '../mcpClientContext.js';
import { discoverTools } from './mcp-tool.js';
import { discoverPrompts } from './mcp-prompt.js';

const config = { type: 'http', url: 'http://example.test/mcp' } as MCPServerConfig;
const context = {
  sanitizationConfig: {
    enableEnvironmentVariableRedaction: true,
    allowedEnvironmentVariables: [],
    blockedEnvironmentVariables: [],
  },
  emitMcpDiagnostic: vi.fn(),
} as unknown as McpClientContext;

describe('MCP catalog pagination', () => {
  it('follows tools/list nextCursor and discovers every page', async () => {
    const listTools = vi.fn(async (params?: { cursor?: string }) => ({
      tools: [
        {
          name: params?.cursor === 'page-2' ? 'second' : 'first',
          description: params?.cursor === 'page-2' ? 'second' : 'first',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      ...(params?.cursor === 'page-2' ? {} : { nextCursor: 'page-2' }),
    }));
    const client = {
      getServerCapabilities: () => ({ tools: {}, prompts: {} }),
      listTools,
    } as unknown as Client;

    const tools = await discoverTools(
      'paged',
      config,
      client,
      { callMcpTool: vi.fn() },
      context,
    );

    expect(tools.map((tool) => tool.serverToolName)).toEqual(['first', 'second']);
    expect(listTools).toHaveBeenNthCalledWith(1, {}, expect.objectContaining({ timeout: expect.any(Number) }));
    expect(listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: 'page-2' },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('follows prompts/list nextCursor and discovers every page', async () => {
    const listPrompts = vi.fn(async (params?: { cursor?: string }) => ({
      prompts: [
        {
          name: params?.cursor === 'page-2' ? 'second-prompt' : 'first-prompt',
          description: 'demo',
        },
      ],
      ...(params?.cursor === 'page-2' ? {} : { nextCursor: 'page-2' }),
    }));
    const client = {
      getServerCapabilities: () => ({ tools: {}, prompts: {} }),
      listPrompts,
    } as unknown as Client;

    const prompts = await discoverPrompts('paged', client, context);

    expect(prompts.map((prompt) => prompt.originalName)).toEqual([
      'first-prompt',
      'second-prompt',
    ]);
    expect(listPrompts).toHaveBeenNthCalledWith(1, {}, expect.objectContaining({ timeout: expect.any(Number) }));
    expect(listPrompts).toHaveBeenNthCalledWith(
      2,
      { cursor: 'page-2' },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });
});
