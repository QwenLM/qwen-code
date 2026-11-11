/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { SchemaCompatibleMcpClient } from './schema-compatible-client.js';

const closePeers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closePeers.splice(0).map((close) => close()));
});

function definition(answer: unknown = true) {
  return {
    name: 'answer',
    inputSchema: { type: 'object' as const },
    outputSchema: {
      type: 'object' as const,
      properties: { answer, forbidden: false },
    },
  };
}

async function peer(tools: unknown[] = [definition()]) {
  const state = {
    tools,
    output: { answer: 'ok' } as Record<string, unknown>,
    listRequests: [] as Array<string | undefined>,
  };
  const server = new Server(
    { name: 'schema-peer', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    state.listRequests.push(request.params?.cursor);
    // Invalid fixtures must reach the real client's wire schema unchanged.
    return {
      tools: state.tools,
      nextCursor: 'next-page',
      _meta: { fixture: true },
    } as ListToolsResult;
  });
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: state.output,
  }));
  const client = new SchemaCompatibleMcpClient({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  closePeers.push(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, state };
}

describe('SchemaCompatibleMcpClient', () => {
  it('discovers boolean output schemas without dropping adjacent healthy tools or metadata', async () => {
    const { client, state } = await peer([
      definition(),
      { name: 'healthy', inputSchema: { type: 'object' } },
    ]);
    const result = await client.listTools({ cursor: 'page-two' });
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'answer',
      'healthy',
    ]);
    expect(result.tools[0].outputSchema?.properties).toEqual({
      answer: true,
      forbidden: false,
    });
    expect(result.nextCursor).toBe('next-page');
    expect(result._meta).toEqual({ fixture: true });
    expect(state.listRequests).toEqual(['page-two']);
  });

  it('keeps output validation, including the meaning of false schemas', async () => {
    const { client, state } = await peer();
    await client.listTools();
    await expect(client.callTool({ name: 'answer' })).resolves.toMatchObject({
      structuredContent: { answer: 'ok' },
    });
    state.output = { answer: 'ok', forbidden: 'must reject' };
    await expect(client.callTool({ name: 'answer' })).rejects.toThrow(
      'Structured content does not match',
    );
  });

  it('rebuilds output validators and task metadata on subsequent lists', async () => {
    const { client, state } = await peer([
      { ...definition(), execution: { taskSupport: 'required' } },
    ]);
    await client.listTools();
    await expect(client.callTool({ name: 'answer' })).rejects.toThrow(
      'requires task-based execution',
    );
    state.tools = [definition(false)];
    await client.listTools();
    await expect(client.callTool({ name: 'answer' })).rejects.toThrow(
      'Structured content does not match',
    );
  });

  it.each([{}, { type: 'string' }])(
    'retains ordinary object schemas: %j',
    async (answer) => {
      const { client } = await peer([definition(answer)]);
      const result = await client.listTools();
      expect(result.tools[0].outputSchema?.properties?.['answer']).toEqual(
        answer,
      );
      await expect(client.callTool({ name: 'answer' })).resolves.toMatchObject({
        structuredContent: { answer: 'ok' },
      });
    },
  );

  it.each([null, 'invalid', 42, []])(
    'still rejects invalid output property schemas: %j',
    async (answer) => {
      const { client } = await peer([definition(answer)]);
      await expect(client.listTools()).rejects.toThrow();
    },
  );

  it('does not relax input schemas or output root constraints', async () => {
    const { client, state } = await peer([
      {
        ...definition(),
        inputSchema: { type: 'object', properties: { input: true } },
      },
    ]);
    await expect(client.listTools()).rejects.toThrow();
    state.tools = [{ ...definition(), outputSchema: { type: 'string' } }];
    await expect(client.listTools()).rejects.toThrow();
  });

  it('does not replace an explicitly supplied tools/list response schema', async () => {
    const { client } = await peer([definition(null)]);
    await expect(
      client.request(
        { method: 'tools/list' },
        z.object({ tools: z.array(z.unknown()) }),
      ),
    ).resolves.toMatchObject({ tools: [definition(null)] });
    // The SDK default still receives our narrow compatibility schema.
    await expect(
      client.request({ method: 'tools/list' }, ListToolsResultSchema),
    ).rejects.toThrow();
  });

  it('does not relax other request methods', async () => {
    const { client } = await peer();
    await expect(
      client.request(
        { method: 'tools/call', params: { name: 'answer' } },
        z.object({ mustExist: z.string() }),
      ),
    ).rejects.toThrow();
  });

  it('forwards cancellation options', async () => {
    const { client } = await peer();
    const controller = new AbortController();
    controller.abort(new Error('cancel schema list'));
    await expect(
      client.listTools({}, { signal: controller.signal }),
    ).rejects.toThrow('cancel schema list');
  });
});
