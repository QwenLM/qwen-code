#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const resources = [
  {
    name: 'web-shell-readme',
    uri: 'demo://web-shell/readme',
    title: 'Web Shell README',
    description: 'A short resource describing the web-shell demo surface.',
    text: [
      '# Web Shell MCP Resource',
      '',
      'This resource is served by the local web-shell demo MCP server.',
      'Use it to verify that @ mentions can browse MCP servers and resources.',
    ].join('\n'),
  },
  {
    name: 'release-notes',
    uri: 'demo://web-shell/release-notes',
    title: 'Release Notes',
    description: 'Example release notes exposed as an MCP resource.',
    text: [
      '# Release Notes',
      '',
      '- Added a three-level @ mention flow for MCP resources.',
      '- Resources are inserted as @server:uri references.',
    ].join('\n'),
  },
  {
    name: 'design-token-sample',
    uri: 'demo://web-shell/design-tokens',
    title: 'Design Token Sample',
    description: 'A JSON document with a few sample design tokens.',
    mimeType: 'application/json',
    text: JSON.stringify(
      {
        color: {
          accent: '#1677ff',
          surface: '#ffffff',
        },
        radius: {
          card: 8,
          dialog: 12,
        },
      },
      null,
      2,
    ),
  },
];

const server = new McpServer({
  name: 'web-shell-resource-demo',
  version: '1.0.0',
});

for (const resource of resources) {
  server.registerResource(
    resource.name,
    resource.uri,
    {
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType ?? 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType ?? 'text/markdown',
          text: resource.text,
        },
      ],
    }),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[web-shell-resource-demo] MCP server started');
