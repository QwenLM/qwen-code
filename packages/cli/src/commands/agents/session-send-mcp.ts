/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `qwen agents session-send-mcp --url <endpoint>` (hidden).
 *
 * A stdio MCP server the daemon hands to a session agent's program (Claude
 * Code `--mcp-config`, Codex `-c mcp_servers.*`) for one run. Its single
 * tool, `session_send`, posts a message into the shared chat session by
 * calling the daemon's per-run endpoint with the per-run bearer token from
 * `QWEN_SESSION_SEND_TOKEN`.
 *
 * stdout is the MCP stream: nothing else may be written there. Diagnostics
 * go to stderr.
 */

import type { Argv, CommandModule } from 'yargs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const SESSION_SEND_TOKEN_ENV = 'QWEN_SESSION_SEND_TOKEN';
export const SESSION_SEND_TOOL_NAME = 'session_send';
const POST_TIMEOUT_MS = 30_000;

// TODO(multi-agent): model-facing text — needs eval before release
const SESSION_SEND_DESCRIPTION =
  'Post a message into the shared conversation; mention @AgentName to ask another agent.';
// TODO(multi-agent): model-facing text — needs eval before release
const TEXT_DESCRIPTION = 'The message to post (Markdown).';

/**
 * POSTs `text` to the daemon. Resolves with the tool's answer ("sent"),
 * rejects with a message the model can read.
 */
export async function postSessionSend(
  url: string,
  token: string | undefined,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!token) throw new Error(`${SESSION_SEND_TOKEN_ENV} is not set.`);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (response.ok) return 'sent';
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: unknown;
      message?: unknown;
    };
    const message = typeof body.message === 'string' ? body.message : undefined;
    const code = typeof body.error === 'string' ? body.error : undefined;
    if (message || code) detail = `${detail}: ${message ?? code}`;
  } catch {
    // Not JSON.
  }
  throw new Error(`Could not post the message (${detail}).`);
}

export function createSessionSendMcpServer(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): McpServer {
  const server = new McpServer({ name: 'qwen-session', version: '1.0.0' });
  server.registerTool(
    SESSION_SEND_TOOL_NAME,
    {
      description: SESSION_SEND_DESCRIPTION,
      inputSchema: { text: z.string().describe(TEXT_DESCRIPTION) },
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

interface SessionSendMcpArgs {
  url: string;
}

export const sessionSendMcpCommand: CommandModule<object, SessionSendMcpArgs> =
  {
    command: 'session-send-mcp',
    describe: false,
    builder: (yargs: Argv) =>
      yargs.option('url', {
        type: 'string',
        demandOption: true,
        describe: 'Per-run session_send endpoint on the local daemon.',
      }) as unknown as Argv<SessionSendMcpArgs>,
    handler: async (argv) => {
      const server = createSessionSendMcpServer(argv.url);
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
    },
  };
