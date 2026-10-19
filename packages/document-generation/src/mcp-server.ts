/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createDocxGenerator,
  docxInputShape,
  docxResultShape,
} from './generate-docx.js';

export async function createDocumentServer(
  workspacePath: string,
): Promise<McpServer> {
  const generate = await createDocxGenerator(workspacePath);
  const server = new McpServer({
    name: 'document-generation',
    version: '0.25.2',
  });
  server.registerTool(
    'generate_docx',
    {
      title: 'Generate Word document',
      description:
        'Create a DOCX from a title and plain paragraphs inside the configured workspace. Maximum 200 title characters, 1000 paragraphs, and 1 MiB total UTF-8 text. Existing files are never overwritten. After success, call record_artifact with the returned resolvedPath as workspacePath and kind="document" to publish the document.',
      inputSchema: z.object(docxInputShape).strict(),
      outputSchema: docxResultShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, { signal }) => {
      try {
        const result = await generate(input, signal);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        let message =
          'Unable to generate the document. Check workspace permissions and filesystem hard-link support.';
        if (signal.aborted) message = 'Document generation was cancelled.';
        else if (error instanceof z.ZodError)
          message = error.issues.map((issue) => issue.message).join(' ');
        else if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        )
          message = 'The output file already exists. Choose a new outputPath.';
        else if (
          error instanceof Error &&
          error.message ===
            'Output directories must be real directories inside the workspace.'
        )
          message = error.message;
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  );
  return server;
}
