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
 *   node dist/mcp/serve-bridge/bin.js
 *
 * Environment variables:
 *   QWEN_DAEMON_URL   - Daemon base URL (default: http://127.0.0.1:4170)
 *   QWEN_DAEMON_TOKEN - Bearer token for auth (optional for loopback)
 *   QWEN_WORKSPACE_CWD - Default workspace path for session creation
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServeBridgeMcpServer } from './createServeBridgeMcpServer.js';

const server = createServeBridgeMcpServer({
  daemonUrl: process.env.QWEN_DAEMON_URL ?? 'http://127.0.0.1:4170',
  token: process.env.QWEN_DAEMON_TOKEN,
  workspaceCwd: process.env.QWEN_WORKSPACE_CWD,
});

const transport = new StdioServerTransport();
await server.instance.connect(transport);
