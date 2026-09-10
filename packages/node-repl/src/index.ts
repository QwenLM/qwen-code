#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createNodeReplMcpServer,
  resolveContextFromEnv,
} from './mcp-server.js';
import { createDebugLogger } from './debug-log.js';

export {
  createNodeReplMcpServer,
  resolveContextFromEnv,
  type NodeReplServerContext,
} from './mcp-server.js';

const debugLogger = createDebugLogger('node-repl');

async function main(): Promise<void> {
  const { server, dispose } = createNodeReplMcpServer(resolveContextFromEnv());

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    dispose();
    void server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(code));
  };

  process.once('SIGINT', () => shutdown());
  process.once('SIGTERM', () => shutdown());
  process.once('SIGHUP', () => shutdown());
  // A stdio MCP host signals shutdown by closing our stdin. The SDK's stdio
  // transport only listens for 'data'/'error', so without these the server and
  // its kernel child would survive every host restart.
  process.stdin.once('end', () => shutdown());
  process.stdin.once('close', () => shutdown());
  // Best-effort synchronous cleanup for any other exit path.
  process.on('exit', () => dispose());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  debugLogger.debug('MCP server connected over stdio');
}

/**
 * True when this module is the process entry point. `process.argv[1]` is
 * resolved but not realpath'd (npm installs `bin` as a symlink) and may contain
 * characters that need URL encoding, so normalize both sides before comparing.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    // stderr — stdout is the JSON-RPC protocol channel.
    process.stderr.write(
      `[node-repl] fatal: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  });
}
