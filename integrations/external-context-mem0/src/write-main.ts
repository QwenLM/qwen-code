/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigurationError } from './schemas.js';
import { loadWriteRuntimeConfiguration } from './write-config.js';
import { createMem0WriteMcpServer } from './write-mcp.js';
import { createWriteRequestEngine } from './write-request-engine.js';

try {
  const runtime = await loadWriteRuntimeConfiguration();
  const server = createMem0WriteMcpServer(createWriteRequestEngine(runtime));
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(
    error instanceof ConfigurationError
      ? `${error.message}\n`
      : 'Mem0 external context writer failed to start.\n',
  );
  process.exitCode = 1;
}
