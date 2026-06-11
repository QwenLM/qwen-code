/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A2UI action inbound endpoint (the upstream half of A2UI-over-MCP).
 *
 * `POST /session/:id/a2ui-action`: web clients post user interactions on an
 * A2UI surface (`{name, surfaceId, context}`) to the daemon, which proxies
 * them to the UI MCP server's standard `action` tool (clients never talk to
 * MCP directly). Continuation A2UI commands returned by the tool
 * (EmbeddedResource, mimeType=application/a2ui+json) are sent back
 * synchronously in the HTTP response as `{commands, fallback}`.
 *
 * UI-server discovery order:
 *  1. the daemon's workspace MCP status (injected via getMcpServers) — this
 *     covers servers registered at runtime via POST /workspace/mcp/servers;
 *     any server whose name contains "a2ui" is a candidate, connected first;
 *  2. fallback: `mcpServers` in the workspace `.qwen/settings.json` (when the
 *     daemon status is unavailable).
 * Transports: stdio (command/args) and streamable HTTP (httpUrl). Legacy SSE
 * (`url`) is intentionally unsupported.
 * Each action spawns a one-shot client (the tool is stateless; a direct
 * per-call connection is the most robust option).
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, Request, RequestHandler, Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const A2UI_MIME = 'application/a2ui+json';
// Standard action-tool name from the official A2UI-over-MCP guide
// (a2ui.org/guides/a2ui_over_mcp).
const ACTION_TOOL = 'action';
const CALL_TIMEOUT_MS = 15_000;

export interface McpServerConfigLike {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  httpUrl?: string;
  cwd?: string;
}

export interface McpServerCell {
  name: string;
  mcpStatus?: string;
  config?: McpServerConfigLike;
}

export interface A2uiActionArgs {
  name: string;
  surfaceId?: string;
  context?: Record<string, unknown>;
}

export interface A2uiActionResult {
  commands: unknown[] | null;
  fallback: string;
}

export interface A2uiToolResult {
  isError?: boolean;
  content?: Array<{
    type: string;
    text?: string;
    resource?: { mimeType?: string; text?: string };
  }>;
}

interface RegisterA2uiActionRoutesOptions {
  boundWorkspace: string;
  mutate: () => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  /** Workspace MCP status from the daemon (includes runtime-registered servers). */
  getMcpServers: (req: Request) => Promise<McpServerCell[]>;
  /** Injectable for unit tests; defaults to the real one-shot MCP call. */
  callAction?: (
    cfg: McpServerConfigLike,
    args: A2uiActionArgs,
  ) => Promise<A2uiActionResult>;
}

/** Exported for unit testing. */
export function usableServerConfig(cfg?: McpServerConfigLike): boolean {
  return (
    !!cfg &&
    (typeof cfg.command === 'string' || typeof cfg.httpUrl === 'string')
  );
}

/**
 * Fallback: read the workspace settings file directly (when the daemon
 * status is unavailable). Exported for unit testing.
 */
export async function findFromSettingsFile(
  workspaceCwd: string,
): Promise<McpServerConfigLike | null> {
  try {
    const raw = await fsp.readFile(
      path.join(workspaceCwd, '.qwen', 'settings.json'),
      'utf8',
    );
    const settings = JSON.parse(raw) as {
      mcpServers?: Record<string, McpServerConfigLike>;
    };
    for (const [name, cfg] of Object.entries(settings.mcpServers ?? {})) {
      if (name.toLowerCase().includes('a2ui') && usableServerConfig(cfg)) {
        return cfg;
      }
    }
  } catch {
    /* Missing/unparseable settings file -> treated as not configured. */
  }
  return null;
}

/** Build a one-shot transport from the config shape: stdio (command) or streamable HTTP (httpUrl). */
export function buildTransport(cfg: McpServerConfigLike): Transport {
  if (typeof cfg.httpUrl === 'string') {
    return new StreamableHTTPClientTransport(new URL(cfg.httpUrl));
  }
  return new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args ?? [],
    // spawn() treats `env` as a complete replacement, not a merge — a partial
    // env (e.g. {API_KEY}) would strip PATH/HOME and break the child. Merge
    // over process.env like packages/core/src/tools/mcp-client.ts does; when
    // unset, let the SDK apply its safe default environment.
    ...(cfg.env
      ? { env: { ...process.env, ...cfg.env } as Record<string, string> }
      : {}),
    cwd: cfg.cwd,
  });
}

/** Exported for unit testing the MCP content normalization rules. */
export function extractA2uiActionResult(
  result: A2uiToolResult,
): A2uiActionResult {
  if (result.isError) {
    const errMsg = (result.content ?? [])
      .filter(
        (b): b is { type: string; text: string } =>
          b.type === 'text' && typeof b.text === 'string',
      )
      .map((b) => b.text)
      .join('');
    throw new Error(
      `a2ui action tool returned error: ${errMsg || 'unknown error'}`,
    );
  }

  let commands: unknown[] | null = null;
  let fallback = '';
  for (const block of result.content ?? []) {
    if (
      commands === null &&
      block.type === 'resource' &&
      block.resource?.mimeType === A2UI_MIME &&
      typeof block.resource.text === 'string'
    ) {
      // Single-block semantics: the first a2ui+json resource wins; further
      // resource blocks are ignored while text blocks keep accumulating.
      try {
        const parsed = JSON.parse(block.resource.text);
        if (Array.isArray(parsed)) commands = parsed;
      } catch {
        /* Invalid JSON -> treated as no continuation frame. */
      }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      fallback += block.text;
    }
  }
  return { commands, fallback };
}

/** Call the UI MCP server's action tool directly and extract the A2UI continuation commands plus fallback text. */
export async function callA2uiAction(
  cfg: McpServerConfigLike,
  args: A2uiActionArgs,
): Promise<A2uiActionResult> {
  const transport = buildTransport(cfg);
  const client = new Client({ name: 'qwen-serve-a2ui', version: '0.0.1' });
  try {
    await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
    const result = (await client.callTool(
      { name: ACTION_TOOL, arguments: { ...args } },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    )) as A2uiToolResult;
    return extractA2uiActionResult(result);
  } finally {
    // Close the transport explicitly as well: client.close() alone may not
    // reap a spawned stdio child when connect() failed mid-handshake.
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

export function registerA2uiActionRoutes(
  app: Application,
  opts: RegisterA2uiActionRoutesOptions,
): void {
  const { boundWorkspace, mutate, safeBody, getMcpServers } = opts;
  const callAction = opts.callAction ?? callA2uiAction;

  app.post(
    '/session/:id/a2ui-action',
    mutate(),
    async (req: Request, res: Response) => {
      const body = safeBody(req);
      const name = body['name'];
      if (typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: '`name` is required' });
        return;
      }
      const surfaceId =
        typeof body['surfaceId'] === 'string' ? body['surfaceId'] : undefined;
      const context =
        body['context'] &&
        typeof body['context'] === 'object' &&
        !Array.isArray(body['context'])
          ? (body['context'] as Record<string, unknown>)
          : undefined;

      // Discover the UI server: daemon status first (covers runtime
      // registration), settings file as fallback.
      let cfg: McpServerConfigLike | null = null;
      try {
        const servers = (await getMcpServers(req)).filter(
          (s) =>
            s.name.toLowerCase().includes('a2ui') &&
            usableServerConfig(s.config),
        );
        const live = servers.find((s) => s.mcpStatus === 'connected');
        cfg = (live ?? servers[0])?.config ?? null;
      } catch {
        /* Status unavailable -> fall through to the settings fallback. */
      }
      if (!cfg) cfg = await findFromSettingsFile(boundWorkspace);
      if (!cfg) {
        res.status(503).json({
          error:
            'no a2ui MCP server found (neither runtime-registered nor in workspace settings mcpServers)',
        });
        return;
      }
      try {
        const { commands, fallback } = await callAction(cfg, {
          name: name.trim(),
          surfaceId,
          context,
        });
        res.status(200).json({ commands, fallback });
      } catch (err) {
        // Log the detail server-side; keep the client-facing message generic
        // so internal paths/commands/URLs never leak.
        writeStderrLine(
          `a2ui-action proxy failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.status(502).json({ error: 'a2ui action call failed' });
      }
    },
  );
}
