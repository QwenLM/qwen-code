/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory function to create SDK-embedded MCP servers
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SdkMcpToolDefinition } from './tool.js';
import { validateToolName } from './tool.js';

/**
 * Options for creating an SDK MCP server
 */
export type CreateSdkMcpServerOptions = {
  name: string;
  version?: string;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  tools?: Array<SdkMcpToolDefinition<any>>;
};

/**
 * SDK MCP Server configuration with instance
 */
export type McpSdkServerConfigWithInstance = {
  type: 'sdk';
  name: string;
  instance: McpServer;
};

/**
 * Creates an MCP server instance that can be used with the SDK transport.
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { tool, createSdkMcpServer } from '@qwen-code/sdk';
 *
 * const calculatorTool = tool(
 *   'calculate_sum',
 *   'Add two numbers',
 *   { a: z.number(), b: z.number() },
 *   async (args) => ({ content: [{ type: 'text', text: String(args.a + args.b) }] })
 * );
 *
 * const server = createSdkMcpServer({
 *   name: 'calculator',
 *   version: '1.0.0',
 *   tools: [calculatorTool],
 * });
 * ```
 */
export function createSdkMcpServer(
  options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const { name, version = '1.0.0', tools } = options;

  if (!name || typeof name !== 'string') {
    throw new Error('MCP server name must be a non-empty string');
  }

  if (!version || typeof version !== 'string') {
    throw new Error('MCP server version must be a non-empty string');
  }

  if (tools !== undefined && !Array.isArray(tools)) {
    throw new Error('Tools must be an array');
  }

  const toolNames = new Set<string>();
  if (tools) {
    for (const t of tools) {
      validateToolName(t.name);
      if (toolNames.has(t.name)) {
        throw new Error(
          `Duplicate tool name '${t.name}' in MCP server '${name}'`,
        );
      }
      toolNames.add(t.name);
    }
  }

  const server = new McpServer(
    { name, version },
    {
      capabilities: {
        tools: tools ? {} : undefined,
      },
    },
  );

  if (tools) {
    tools.forEach((toolDef) => {
      server.tool(
        toolDef.name,
        toolDef.description,
        toolDef.inputSchema,
        toolDef.handler,
      );
    });
  }

  return { type: 'sdk', name, instance: server };
}
