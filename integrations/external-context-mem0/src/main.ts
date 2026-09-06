/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadRuntimeConfiguration } from './config.js';
import { createMem0McpServer } from './mcp.js';
import { createRequestEngine } from './request-engine.js';
import { ConfigurationError } from './schemas.js';

try {
  const runtime = await loadRuntimeConfiguration();
  const server = createMem0McpServer({
    instance: runtime.instance,
    search: createRequestEngine(runtime),
  });
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(
    error instanceof ConfigurationError
      ? `${error.message}\n`
      : 'Mem0 external context extension failed to start.\n',
  );
  process.exitCode = 1;
}
