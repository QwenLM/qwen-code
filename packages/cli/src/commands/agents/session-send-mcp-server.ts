/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The `session_send` stdio MCP server itself, loaded only when
 * `qwen agents session-send-mcp` runs (see session-send-mcp.ts). Nothing
 * here writes to stdout except the MCP transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  postSessionSend,
  SESSION_SEND_DESCRIPTION,
  SESSION_SEND_TEXT_DESCRIPTION,
  SESSION_SEND_TOKEN_ENV,
  SESSION_SEND_TOOL_NAME,
} from './session-send-mcp.js';

function createSessionSendMcpServer(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): McpServer {
  const server = new McpServer({ name: 'qwen-session', version: '1.0.0' });
  server.registerTool(
    SESSION_SEND_TOOL_NAME,
    {
      description: SESSION_SEND_DESCRIPTION,
      inputSchema: {
        text: z.string().describe(SESSION_SEND_TEXT_DESCRIPTION),
      },
    },
    async ({ text }) => {
      try {
        const answer = await postSessionSend(
          url,
          env[SESSION_SEND_TOKEN_ENV],
          text,
          fetchImpl,
        );
        return { content: [{ type: 'text' as const, text: answer }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );
  return server;
}

/** Serves `session_send` on stdio until the client goes away. */
export async function runSessionSendMcp(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const server = createSessionSendMcpServer(url, env);
  const transport = new StdioServerTransport();
  // Resolve only when the client goes away: the CLI exits as soon as a
  // subcommand handler returns.
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
    process.stdin.once('close', () => resolve());
  });
  await server.connect(transport);
  await closed;
  await server.close().catch(() => {});
}
