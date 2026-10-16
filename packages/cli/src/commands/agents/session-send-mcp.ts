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
 * go to stderr. The daemon spawns it as `qwen agents session-send-mcp`,
 * which cli.ts routes straight here before normal startup (no settings,
 * banners or update checks, nothing HOME-dependent: Codex starts MCP servers
 * with a minimal environment). This module stays light because config.ts
 * registers the command on every start; the MCP SDK and zod load from
 * `session-send-mcp-server.ts` only when the command runs.
 */

import type { Argv, CommandModule } from 'yargs';

export const SESSION_SEND_TOKEN_ENV = 'QWEN_SESSION_SEND_TOKEN';
export const SESSION_SEND_TOOL_NAME = 'session_send';
const POST_TIMEOUT_MS = 30_000;

// TODO(multi-agent): model-facing text — needs eval before release
export const SESSION_SEND_DESCRIPTION =
  'Post a message into the shared conversation; mention @AgentName to ask another agent.';
// TODO(multi-agent): model-facing text — needs eval before release
export const SESSION_SEND_TEXT_DESCRIPTION = 'The message to post (Markdown).';

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
      const { runSessionSendMcp } = await import(
        './session-send-mcp-server.js'
      );
      await runSessionSendMcp(argv.url);
    },
  };

/**
 * `--url <endpoint>` / `--url=<endpoint>` from the argv after
 * `agents session-send-mcp`, for cli.ts's fast path. Undefined when absent,
 * empty, or given anything else (the daemon passes exactly this).
 */
export function readSessionSendMcpUrl(
  argv: readonly string[],
): string | undefined {
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--url' && i + 1 < argv.length) {
      url = argv[++i];
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else {
      return undefined;
    }
  }
  return url || undefined;
}
