import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

type ToolShape = z.ZodRawShape;
type ToolHandler<Args extends ToolShape> = (
  args: z.output<z.ZodObject<Args>>,
) => CallToolResult | Promise<CallToolResult>;

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: ToolShape;
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
  annotations?: ToolAnnotations;
}

export function localTool<Args extends ToolShape>(
  name: string,
  description: string,
  inputSchema: Args,
  handler: ToolHandler<Args>,
  options?: { annotations?: ToolAnnotations },
): LocalTool {
  return {
    name,
    description,
    inputSchema,
    handler: handler as (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>,
    annotations: options?.annotations,
  };
}

export function createLocalMcpServer(args: {
  name: string;
  version: string;
  tools: LocalTool[];
}): McpServer {
  const server = new McpServer({ name: args.name, version: args.version });

  for (const tool of args.tools) {
    const registerTool = server.registerTool.bind(server) as any;
    registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      // The MCP SDK validates the input schema before invoking this callback.
      (input: Record<string, unknown>) => tool.handler(input),
    );
  }

  return server;
}
