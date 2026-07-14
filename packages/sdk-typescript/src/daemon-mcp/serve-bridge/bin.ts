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
import { createShutdownController } from './shutdown.js';

const server = createServeBridgeMcpServer({
  daemonUrl: process.env['QWEN_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
  token: process.env['QWEN_DAEMON_TOKEN'],
  workspaceCwd: process.env['QWEN_WORKSPACE_CWD'],
  allowGlobalScope: process.env['QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE'] === 'true',
});

const transport = new StdioServerTransport();

const { shutdown, markInstanceClosed } = createShutdownController({
  close: () => server.instance.close(),
  dispose: () => server.dispose(),
  exit: (code) => process.exit(code),
  reportCloseError: (err) => {
    process.stderr.write(`[qwen-serve-bridge] close error: ${err}\n`);
  },
});

const previousOnclose = server.instance.server.onclose;
server.instance.server.onclose = () => {
  markInstanceClosed();
  previousOnclose?.();
  void shutdown();
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Prevent silent crashes from unhandled rejections
process.on('unhandledRejection', (err) => {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[qwen-serve-bridge] unhandled rejection: ${detail}\n`);
  process.exit(1);
});

// Exit cleanly when stdio pipe closes (parent process gone)
process.stdin.on('close', () => void shutdown());

await server.instance.connect(transport);
