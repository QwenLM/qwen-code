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
import { checkDocument } from './check.js';
import { APP_URI, createShowResult, showInputSchema } from './contracts.js';
import type { BUNDLED_APP_URI } from './contracts.js';

const invalidDocument =
  'INVALID_DOCUMENT: Supply a complete generated view within the documented field and 24,000-byte result limits.';

export function createGeneratedUiServer(
  appUri: typeof APP_URI | typeof BUNDLED_APP_URI = APP_URI,
): McpServer {
  const server = new McpServer({ name: 'generated-ui', version: '1.0.0' });
  server.registerTool(
    'generated_ui_show',
    {
      description:
        'Show one complete local interactive view in the conversation for parameter simulation or option comparison. Use it when the user wants to adjust values and see results in the chat; write files instead only when the user asks for a file, page or project code. Supply title, readable summary, HTML body, CSS and JavaScript using the documented ui.on/input/text/html/value API. JavaScript runs in an isolated bounded interpreter, without browser DOM, network, imports, timers, Intl, files or MCP tools/messages. Before display, the initial calculation is checked once in the same interpreter against the initial input values in the markup; a VIEW_ERROR result names the problem so you can correct the document. Every call creates a separate immutable card; it does not update an earlier card. Field limits: title 120, summary 2000, HTML 12000, CSS 6000, JavaScript 12000 characters; complete result must fit 24000 characters and UTF-8 bytes. Use the generated-ui skill for the API and examples.',
      inputSchema: showInputSchema.strict(
        'INVALID_DOCUMENT: Unknown fields are not supported.',
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: appUri, visibility: ['model'] } },
    },
    async (input) => {
      let result;
      try {
        result = createShowResult(input);
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: invalidDocument }],
        };
      }
      const problem = await checkDocument(input);
      if (problem) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `VIEW_ERROR: ${problem} Nothing was displayed. Correct the document and call generated_ui_show again with all five fields.`,
            },
          ],
        };
      }
      return result;
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
    appUri,
    { _meta: { ui } },
    async () => ({
      contents: [
        {
          uri: appUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(new URL('./app.html', import.meta.url), 'utf8'),
          _meta: { ui },
        },
      ],
    }),
  );
  return server;
}
