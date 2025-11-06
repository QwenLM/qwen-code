/**
 * Factory function to create SDK-embedded MCP servers
 *
 * Creates MCP Server instances that run in the user's Node.js process
 * and are proxied to the CLI via the control plane.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../types/config.js';
import { formatToolResult, formatToolError } from './formatters.js';
import { validateToolName } from './tool.js';

/**
 * Create an SDK-embedded MCP server with custom tools
 *
 * The server runs in your Node.js process and is proxied to the CLI.
 *
 * @param name - Server name (must be unique)
 * @param version - Server version
 * @param tools - Array of tool definitions
 * @returns MCP Server instance
 *
 * @example
 * ```typescript
 * const server = createSdkMcpServer('database', '1.0.0', [
 *   tool({
 *     name: 'query_db',
 *     description: 'Query the database',
 *     inputSchema: {
 *       type: 'object',
 *       properties: { query: { type: 'string' } },
 *       required: ['query']
 *     },
 *     handler: async (input) => db.query(input.query)
 *   })
 * ]);
 * ```
 */
export function createSdkMcpServer(
  name: string,
  version: string,
  tools: ToolDefinition[],
): Server {
  // Validate server name
  if (!name || typeof name !== 'string') {
    throw new Error('MCP server name must be a non-empty string');
  }

  if (!version || typeof version !== 'string') {
    throw new Error('MCP server version must be a non-empty string');
  }

  if (!Array.isArray(tools)) {
    throw new Error('Tools must be an array');
  }

  // Validate tool names are unique
  const toolNames = new Set<string>();
  for (const tool of tools) {
    validateToolName(tool.name);

    if (toolNames.has(tool.name)) {
      throw new Error(
        `Duplicate tool name '${tool.name}' in MCP server '${name}'`,
      );
    }
    toolNames.add(tool.name);
  }

  // Create MCP Server instance
  const server = new Server(
    {
      name,
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Create tool map for fast lookup
  const toolMap = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  // Register list_tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Register call_tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: toolArgs } = request.params;

    // Find tool
    const tool = toolMap.get(toolName);
    if (!tool) {
      return formatToolError(
        new Error(`Tool '${toolName}' not found in server '${name}'`),
      ) as CallToolResult;
    }

    try {
      // Invoke tool handler
      const result = await tool.handler(toolArgs);

      // Format result
      return formatToolResult(result) as CallToolResult;
    } catch (error) {
      // Handle tool execution error
      return formatToolError(
        error instanceof Error
          ? error
          : new Error(`Tool '${toolName}' failed: ${String(error)}`),
      ) as CallToolResult;
    }
  });

  return server;
}

/**
 * Create MCP server with inline tool definitions
 *
 * @param name - Server name
 * @param version - Server version
 * @param toolDefinitions - Object mapping tool names to definitions
 * @returns MCP Server instance
 *
 * @example
 * ```typescript
 * const server = createSimpleMcpServer('utils', '1.0.0', {
 *   greeting: {
 *     description: 'Generate a greeting',
 *     inputSchema: {
 *       type: 'object',
 *       properties: { name: { type: 'string' } },
 *       required: ['name']
 *     },
 *     handler: async ({ name }) => `Hello, ${name}!`
 *   }
 * });
 * ```
 */
export function createSimpleMcpServer(
  name: string,
  version: string,
  toolDefinitions: Record<
    string,
    Omit<ToolDefinition, 'name'> & { name?: string }
  >,
): Server {
  const tools: ToolDefinition[] = Object.entries(toolDefinitions).map(
    ([toolName, def]) => ({
      name: def.name || toolName,
      description: def.description,
      inputSchema: def.inputSchema,
      handler: def.handler,
    }),
  );

  return createSdkMcpServer(name, version, tools);
}
