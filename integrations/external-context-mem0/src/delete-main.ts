/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigurationError } from './schemas.js';
import { loadDeleteRuntimeConfiguration } from './delete-config.js';
import { createMem0DeleteMcpServer } from './delete-mcp.js';
import { createDeleteRequestEngine } from './delete-request-engine.js';

try {
  const runtime = await loadDeleteRuntimeConfiguration();
  const server = createMem0DeleteMcpServer(createDeleteRequestEngine(runtime));
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(
    error instanceof ConfigurationError
      ? `${error.message}\n`
      : 'Mem0 external context deletion server failed to start.\n',
  );
  process.exitCode = 1;
}
