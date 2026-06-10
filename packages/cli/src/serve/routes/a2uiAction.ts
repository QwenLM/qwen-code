/**
 * @license
 * Copyright 2025 Qwen
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
 * Transports: stdio (command/args) and streamable HTTP (httpUrl).
 * Each action spawns a one-shot client (the tool is stateless; a direct
 * per-call connection is the most robust option).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Application, Request, RequestHandler, Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const A2UI_MIME = 'application/a2ui+json';
// Standard action-tool name from the official A2UI-over-MCP guide
// (a2ui.org/guides/a2ui_over_mcp).
const ACTION_TOOL = 'action';
const CALL_TIMEOUT_MS = 15_000;

interface McpServerConfigLike {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  httpUrl?: string;
  url?: string;
  cwd?: string;
}

interface McpServerCell {
  name: string;
  mcpStatus?: string;
  config?: McpServerConfigLike;
}

interface RegisterA2uiActionRoutesOptions {
  boundWorkspace: string;
  mutate: () => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  /** Workspace MCP status from the daemon (includes runtime-registered servers). */
  getMcpServers: (req: Request) => Promise<McpServerCell[]>;
}

function usable(cfg?: McpServerConfigLike): boolean {
  return (
    !!cfg &&
    (typeof cfg.command === 'string' || typeof cfg.httpUrl === 'string')
  );
}

/** Fallback: read the workspace settings file directly (when the daemon status is unavailable). */
function findFromSettingsFile(
  workspaceCwd: string,
): McpServerConfigLike | null {
  try {
    const raw = fs.readFileSync(
      path.join(workspaceCwd, '.qwen', 'settings.json'),
      'utf8',
    );
    const settings = JSON.parse(raw) as {
      mcpServers?: Record<string, McpServerConfigLike>;
    };
    for (const [name, cfg] of Object.entries(settings.mcpServers ?? {})) {
      if (name.toLowerCase().includes('a2ui') && usable(cfg)) return cfg;
    }
  } catch {
    /* Missing/unparseable settings file -> treated as not configured. */
  }
  return null;
}

/** Build a one-shot transport from the config shape: stdio (command) or streamable HTTP (httpUrl). */
function buildTransport(cfg: McpServerConfigLike): Transport {
  if (typeof cfg.httpUrl === 'string') {
    return new StreamableHTTPClientTransport(new URL(cfg.httpUrl));
  }
  return new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args ?? [],
    env: cfg.env,
    cwd: cfg.cwd,
  });
}

/** Call the UI MCP server's action tool directly and extract the A2UI continuation commands plus fallback text. */
async function callA2uiAction(
  cfg: McpServerConfigLike,
  args: { name: string; surfaceId?: string; context?: Record<string, unknown> },
): Promise<{ commands: unknown[] | null; fallback: string }> {
  const transport = buildTransport(cfg);
  const client = new Client({ name: 'qwen-serve-a2ui', version: '0.0.1' });
  try {
    await client.connect(transport);
    const result = (await client.callTool(
      { name: ACTION_TOOL, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    )) as {
      content?: Array<{
        type: string;
        text?: string;
        resource?: { mimeType?: string; text?: string };
      }>;
    };
    let commands: unknown[] | null = null;
    let fallback = '';
    for (const block of result.content ?? []) {
      if (
        block.type === 'resource' &&
        block.resource?.mimeType === A2UI_MIME &&
        typeof block.resource.text === 'string'
      ) {
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
  } finally {
    await client.close().catch(() => {});
  }
}

export function registerA2uiActionRoutes(
  app: Application,
  opts: RegisterA2uiActionRoutesOptions,
): void {
  const { boundWorkspace, mutate, safeBody, getMcpServers } = opts;

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
        body['context'] && typeof body['context'] === 'object'
          ? (body['context'] as Record<string, unknown>)
          : undefined;

      // Discover the UI server: daemon status first (covers runtime
      // registration), settings file as fallback.
      let cfg: McpServerConfigLike | null = null;
      try {
        const servers = (await getMcpServers(req)).filter(
          (s) => s.name.toLowerCase().includes('a2ui') && usable(s.config),
        );
        const live = servers.find((s) => s.mcpStatus === 'connected');
        cfg = (live ?? servers[0])?.config ?? null;
      } catch {
        /* Status unavailable -> fall through to the settings fallback. */
      }
      if (!cfg) cfg = findFromSettingsFile(boundWorkspace);
      if (!cfg) {
        res.status(503).json({
          error:
            'no a2ui MCP server found (neither runtime-registered nor in workspace settings mcpServers)',
        });
        return;
      }
      try {
        const { commands, fallback } = await callA2uiAction(cfg, {
          name: name.trim(),
          surfaceId,
          context,
        });
        res.status(200).json({ commands, fallback });
      } catch (err) {
        res.status(502).json({
          error: `a2ui action call failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    },
  );
}
