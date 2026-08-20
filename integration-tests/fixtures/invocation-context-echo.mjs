import { appendFile } from 'node:fs/promises';
import process from 'node:process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const outputFile = process.env['INVOCATION_CONTEXT_ECHO_FILE'];
if (!outputFile) {
  throw new Error('INVOCATION_CONTEXT_ECHO_FILE is required');
}

const server = new Server(
  { name: 'invocation-context-echo', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'capture_invocation_context',
      description: 'Capture this tool request metadata.',
      inputSchema: {
        type: 'object',
        properties: { probe: { type: 'string' } },
        required: ['probe'],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const record = {
    arguments: request.params.arguments ?? {},
    metadata: request.params._meta ?? null,
    privateCapabilityInEnv:
      process.env['QWEN_CODE_PRIVATE_ACP_CAPABILITY'] !== undefined,
  };
  await appendFile(outputFile, `${JSON.stringify(record)}\n`);
  return {
    content: [{ type: 'text', text: JSON.stringify(record) }],
  };
});

await server.connect(new StdioServerTransport());
