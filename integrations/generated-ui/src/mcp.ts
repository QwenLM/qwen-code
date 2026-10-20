/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile } from 'node:fs/promises';
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { APP_URI, createShowResult, showInputSchema } from './contracts.js';

const invalidDocument =
  'INVALID_DOCUMENT: Supply a complete generated view within the documented field and 24,000-byte result limits.';

export function createGeneratedUiServer(): McpServer {
  const server = new McpServer({ name: 'generated-ui', version: '1.0.0' });
  server.registerTool(
    'generated_ui_show',
    {
      description:
        'Show one complete local interactive view for parameter simulation or option comparison. Supply title, readable summary, HTML body, CSS and JavaScript using the documented ui.on/input/text/html/value API. JavaScript runs in an isolated bounded interpreter, without browser DOM, network, imports, timers, files or MCP tools/messages. No source executes on this server. Every call creates a separate immutable card; it does not update an earlier card. Field limits: title 120, summary 2000, HTML 12000, CSS 6000, JavaScript 12000 characters; complete result must fit 24000 characters and UTF-8 bytes. Use the generated-ui skill for the API and examples.',
      inputSchema: showInputSchema.strict(
        'INVALID_DOCUMENT: Unknown fields are not supported.',
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: APP_URI, visibility: ['model'] } },
    },
    async (input) => {
      try {
        return createShowResult(input);
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: invalidDocument }],
        };
      }
    },
  );
  const ui = {
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
  };
  registerAppResource(
    server,
    'Generated UI',
    APP_URI,
    { _meta: { ui } },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(new URL('./app.html', import.meta.url), 'utf8'),
          _meta: { ui },
        },
      ],
    }),
  );
  return server;
}
