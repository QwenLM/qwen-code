/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGeneratedUiServer } from './mcp.js';

try {
  await createGeneratedUiServer().connect(new StdioServerTransport());
} catch {
  process.stderr.write('Generated UI could not start its MCP server.\n');
  process.exitCode = 1;
}
