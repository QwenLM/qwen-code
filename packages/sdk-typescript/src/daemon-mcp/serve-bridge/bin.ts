#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone stdio entry point for the qwen-serve-bridge MCP server.
 *
 * Usage:
 *   QWEN_DAEMON_URL=http://127.0.0.1:4170 \
 *   QWEN_DAEMON_TOKEN=<token> \
 *   node dist/daemon-mcp/serve-bridge/bin.js
 *
 * Environment variables:
 *   QWEN_DAEMON_URL   - Daemon base URL (default: http://127.0.0.1:4170)
 *   QWEN_DAEMON_TOKEN - Bearer token for auth (optional for loopback)
 *   QWEN_WORKSPACE_CWD - Default workspace path for session creation
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServeBridgeMcpServer } from './createServeBridgeMcpServer.js';

const server = createServeBridgeMcpServer({
  daemonUrl: process.env['QWEN_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
  token: process.env['QWEN_DAEMON_TOKEN'],
  workspaceCwd: process.env['QWEN_WORKSPACE_CWD'],
  allowGlobalScope: process.env['QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE'] === 'true',
});

const transport = new StdioServerTransport();

// Graceful shutdown on signals
function shutdown() {
  server.instance.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Prevent silent crashes from unhandled rejections
process.on('unhandledRejection', (err) => {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[qwen-serve-bridge] unhandled rejection: ${detail}\n`);
  process.exit(1);
});

// Exit cleanly when stdio pipe closes (parent process gone)
process.stdin.on('close', shutdown);

await server.instance.connect(transport);
