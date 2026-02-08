#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from '../shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;

// Read configuration from stdio-config.json
const loadConfig = () => {
  try {
    const configPath = path.join(__dirname, 'stdio-config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('Failed to load stdio-config.json:', error);
    throw new Error(
      'Configuration file stdio-config.json not found or invalid',
    );
  }
};

export const getStdioMcpServer = () => {
  if (stdioMcpServer) {
    return stdioMcpServer;
  }
  stdioMcpServer = new Server(
    {
      name: 'StdioChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  setupTools(stdioMcpServer);
  return stdioMcpServer;
};

export const ensureMcpClient = async () => {
  try {
    if (mcpClient) {
      const pingResult = await mcpClient.ping();
      if (pingResult) {
        return mcpClient;
      }
    }

    const config = loadConfig();
    mcpClient = new Client(
      { name: 'Mcp Chrome Proxy', version: '1.0.0' },
      { capabilities: {} },
    );

    // Bypass proxy for localhost connections by setting NO_PROXY
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    const originalAllProxy = process.env.ALL_PROXY;
    const originalNoProxy = process.env.NO_PROXY;

    process.env.HTTP_PROXY = '';
    process.env.HTTPS_PROXY = '';
    process.env.ALL_PROXY = '';
    process.env.NO_PROXY = 'localhost,127.0.0.1';

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {},
      );
      await mcpClient.connect(transport);
    } finally {
      // Restore original proxy settings
      if (originalHttpProxy !== undefined)
        process.env.HTTP_PROXY = originalHttpProxy;
      else delete process.env.HTTP_PROXY;
      if (originalHttpsProxy !== undefined)
        process.env.HTTPS_PROXY = originalHttpsProxy;
      else delete process.env.HTTPS_PROXY;
      if (originalAllProxy !== undefined)
        process.env.ALL_PROXY = originalAllProxy;
      else delete process.env.ALL_PROXY;
      if (originalNoProxy !== undefined) process.env.NO_PROXY = originalNoProxy;
      else delete process.env.NO_PROXY;
    }

    return mcpClient;
  } catch (error) {
    mcpClient?.close();
    mcpClient = null;
    console.error('Failed to connect to MCP server:', error);
  }
};

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SCHEMAS,
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name, request.params.arguments || {}),
  );

  // List resources handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));

  // List prompts handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));
};

const handleToolCall = async (
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> => {
  try {
    const client = await ensureMcpClient();
    if (!client) {
      throw new Error('Failed to connect to MCP server');
    }
    // Use a sane default of 2 minutes; the previous value mistakenly used 2*6*1000 (12s)
    const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: DEFAULT_CALL_TIMEOUT_MS,
    });
    return result as CallToolResult;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${(error as Error).message || String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

async function main() {
  const transport = new StdioServerTransport();
  await getStdioMcpServer().connect(transport);
}

main().catch((error) => {
  console.error('Fatal error Chrome MCP Server main():', error);
  process.exit(1);
});
