/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  renderRememberResult,
  isValidMemoryContent,
  writeInputSchema,
  writeOutputSchema,
} from './write-profile.js';
import type { RememberProvider } from './types.js';

export function createMem0WriteMcpServer(
  remember: RememberProvider,
): McpServer {
  const server = new McpServer({
    name: 'external-context-mem0-write',
    version: '0.1.0',
  });
  server.registerTool(
    'context_remember',
    {
      title: 'Remember external context',
      description:
        'Store the exact supplied text in the administrator-bound workspace memory. Call only when the user explicitly asks to save a memory. This non-idempotent operation can create duplicates; never retry an unknown or accepted write automatically.',
      inputSchema: writeInputSchema,
      outputSchema: writeOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ content }, extra) => {
      if (!isValidMemoryContent(content) || extra.signal.aborted) {
        return renderRememberResult({ status: 'failed' });
      }
      try {
        return renderRememberResult(
          await remember({ content, signal: extra.signal }),
        );
      } catch {
        return renderRememberResult({ status: 'unknown' });
      }
    },
  );
  return server;
}
