/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { McpGetTool } from '../mcp-get-tool.js';

describe('mcp_get marketplace identity', () => {
  it.each([true, false])(
    'uses the selected tool initialize snapshot without activating its plugin (metadata=%s)',
    async (present) => {
      const metadata = present
        ? {
            marketItemId: 'gateway-id',
            displayName: 'Gateway MCP',
            version: 'gateway-version',
          }
        : undefined;
      const config = {
        getMcpClientManager: () => ({
          getLazyDiscoveredMcpToolByQualifiedName: () => ({
            qualifiedName: 'mcp__server__search',
            serverName: 'server',
            toolName: 'search',
            tool: { mcpMarketplace: metadata },
          }),
        }),
      } as never;
      const rawRecord = {};

      const result = await new McpGetTool(config)
        .build({ toolName: 'mcp__server__search' })
        .executeWithContext!({
          signal: new AbortController().signal,
          extensionExecutionRawRecord: rawRecord,
        });

      expect(result.error).toBeUndefined();
      expect(rawRecord).toMatchObject({
        marketItemId: present ? 'gateway-id' : '',
        displayName: present ? 'Gateway MCP' : '',
        version: present ? 'gateway-version' : '',
      });
      expect(rawRecord).not.toHaveProperty('pluginName');
    },
  );
});
