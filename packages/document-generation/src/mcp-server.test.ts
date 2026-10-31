/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocumentServer } from './mcp-server.js';

let workspace: string;
let client: Client;
let server: Awaited<ReturnType<typeof createDocumentServer>>;

beforeEach(async () => {
  await mkdir(path.resolve('../../.qwen'), { recursive: true });
  workspace = await mkdtemp(path.resolve('../../.qwen/docx-mcp-'));
  server = await createDocumentServer(workspace);
  client = new Client({ name: 'docx-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('document MCP server', () => {
  it('exposes one bounded tool and creates a file with structured output', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['generate_docx']);
    expect(tools[0].inputSchema.properties).not.toHaveProperty('workspace');
    const result = await client.callTool({
      name: 'generate_docx',
      arguments: {
        outputPath: 'report.docx',
        title: 'Report',
        paragraphs: ['Actual document'],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      resolvedPath: path.join(workspace, 'report.docx'),
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    const bytes = await readFile(path.join(workspace, 'report.docx'));
    expect(result.structuredContent).toMatchObject({ sizeBytes: bytes.length });
  });

  it('returns actionable errors without overwriting a generated file', async () => {
    const request = {
      name: 'generate_docx',
      arguments: {
        outputPath: 'report.docx',
        title: 'Original',
        paragraphs: ['Keep this'],
      },
    };
    await client.callTool(request);
    const original = await readFile(path.join(workspace, 'report.docx'));
    const result = await client.callTool(request);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('already exists');
    expect(await readFile(path.join(workspace, 'report.docx'))).toEqual(
      original,
    );
  });

  it('rejects unsafe paths through the protocol', async () => {
    const result = await client.callTool({
      name: 'generate_docx',
      arguments: {
        outputPath: '../escape.docx',
        title: 'Invalid',
        paragraphs: ['Private body'],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain('Private body');
  });
});
