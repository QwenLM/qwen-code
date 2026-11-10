/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import * as mini from 'zod/mini';
import { createSdkMcpServer } from '../../src/mcp/createSdkMcpServer.js';
import { tool } from '../../src/mcp/tool.js';
import { createSdkMcpServer as createDaemonSdkMcpServer } from '../../src/daemon-mcp/createSdkMcpServer.js';
import { tool as daemonTool } from '../../src/daemon-mcp/tool.js';

it.each([
  ['sdk', tool, createSdkMcpServer],
  ['daemon', daemonTool, createDaemonSdkMcpServer],
] as const)(
  '%s MCP tools infer and validate parsed Zod arguments',
  async (_, defineTool, createServer) => {
    const observed = vi.fn();
    const customObserved = vi.fn();
    const definition = defineTool(
      'count',
      'Parse a count',
      {
        count: z.coerce.number(),
        label: z.string().default('total'),
        note: z.string().optional(),
      },
      async (args) => {
        expectTypeOf(args.count).toEqualTypeOf<number>();
        expectTypeOf(args.label).toEqualTypeOf<string>();
        expectTypeOf(args.note).toEqualTypeOf<string | undefined>();
        observed(args);
        return {
          content: [{ type: 'text', text: `${args.label}: ${args.count}` }],
        };
      },
    );
    const customDefinition = defineTool(
      'custom',
      'Validate a custom value',
      { value: z.custom<string>((value) => typeof value === 'string') },
      async (args) => {
        customObserved(args);
        return { content: [{ type: 'text', text: args.value }] };
      },
    );
    const server = createServer({
      name: 'schema-test',
      tools: [definition, customDefinition],
    });
    const client = new Client({ name: 'schema-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: 'count' }, { name: 'custom' }],
      });
      await expect(
        client.callTool({ name: 'count', arguments: { count: '7' } }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'total: 7' }],
      });
      expect(observed).toHaveBeenCalledWith({ count: 7, label: 'total' });
      observed.mockClear();

      await expect(
        client.callTool({
          name: 'count',
          arguments: { count: 'not-a-number' },
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(observed).not.toHaveBeenCalled();

      await expect(
        client.callTool({ name: 'custom', arguments: { value: 'valid' } }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'valid' }],
      });
      expect(customObserved).toHaveBeenCalledWith({ value: 'valid' });
      customObserved.mockClear();

      await expect(
        client.callTool({ name: 'custom', arguments: { value: 7 } }),
      ).resolves.toMatchObject({ isError: true });
      expect(customObserved).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.instance.close();
    }
  },
);

it.each([
  ['sdk', tool, createSdkMcpServer],
  ['daemon', daemonTool, createDaemonSdkMcpServer],
] as const)(
  '%s MCP discovery preserves Mini schemas, nested constraints, and lazy defaults',
  async (_, defineTool, createServer) => {
    const miniObserved = vi.fn();
    const nestedObserved = vi.fn();
    let defaultCalls = 0;
    const server = createServer({
      name: 'schema-discovery-test',
      tools: [
        defineTool(
          'mini',
          'Validate a Mini value',
          { value: mini.string() },
          async (args) => {
            expectTypeOf(args.value).toEqualTypeOf<string>();
            miniObserved(args);
            return { content: [{ type: 'text', text: args.value }] };
          },
        ),
        defineTool(
          'nested',
          'Validate nested constraints',
          {
            request: z.object({
              kind: z.literal('search'),
              limit: z.number().int().min(1).max(50),
              value: z.custom<string>((value) => typeof value === 'string'),
            }),
          },
          async (args) => {
            nestedObserved(args);
            return { content: [{ type: 'text', text: args.request.value }] };
          },
        ),
        defineTool(
          'default',
          'Apply a lazy default',
          {
            value: z.string().default(() => {
              defaultCalls += 1;
              return 'fallback';
            }),
          },
          async (args) => ({
            content: [{ type: 'text', text: args.value }],
          }),
        ),
      ],
    });
    expect(defaultCalls).toBe(0);

    const client = new Client({
      name: 'schema-discovery-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(defaultCalls).toBe(1);
      expect(
        listed.tools.find(({ name }) => name === 'mini')?.inputSchema,
      ).toMatchObject({
        properties: { value: { type: 'string' } },
        required: ['value'],
      });
      expect(
        listed.tools.find(({ name }) => name === 'nested')?.inputSchema,
      ).toMatchObject({
        properties: {
          request: {
            properties: {
              kind: { type: 'string', const: 'search' },
              limit: { type: 'integer', minimum: 1, maximum: 50 },
              value: {},
            },
            required: ['kind', 'limit', 'value'],
          },
        },
        required: ['request'],
      });

      await expect(
        client.callTool({ name: 'mini', arguments: { value: 'valid' } }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'valid' }],
      });
      expect(miniObserved).toHaveBeenCalledWith({ value: 'valid' });
      miniObserved.mockClear();
      await expect(
        client.callTool({ name: 'mini', arguments: { value: 7 } }),
      ).resolves.toMatchObject({ isError: true });
      expect(miniObserved).not.toHaveBeenCalled();

      await expect(
        client.callTool({
          name: 'nested',
          arguments: {
            request: { kind: 'search', limit: 51, value: 'valid' },
          },
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(nestedObserved).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.instance.close();
    }
  },
);
