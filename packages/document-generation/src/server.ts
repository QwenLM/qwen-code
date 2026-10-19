/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDocumentServer } from './mcp-server.js';

try {
  const { values } = parseArgs({ options: { workspace: { type: 'string' } } });
  if (!values.workspace)
    throw new Error('Usage: node server.js --workspace <absolute-directory>');
  const server = await createDocumentServer(values.workspace);
  const close = () => {
    void server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Unable to start the document server.'}\n`,
  );
  process.exitCode = 1;
}
