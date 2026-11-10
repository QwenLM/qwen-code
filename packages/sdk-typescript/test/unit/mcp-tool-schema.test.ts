/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, expectTypeOf, it, vi } from 'vitest';
import { type ZodType, z } from 'zod';
import * as mini from 'zod/mini';
import { z as z3 } from 'zod/v3';
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

      const invalidCount = await client.callTool({
        name: 'count',
        arguments: { count: 'not-a-number' },
      });
      expect(invalidCount.isError).toBe(true);
      expect(textOf(invalidCount)).toContain('-32602');
      expect(observed).not.toHaveBeenCalled();

      await expect(
        client.callTool({ name: 'custom', arguments: { value: 'valid' } }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'valid' }],
      });
      expect(customObserved).toHaveBeenCalledWith({ value: 'valid' });
      customObserved.mockClear();

      const invalidCustom = await client.callTool({
        name: 'custom',
        arguments: { value: 7 },
      });
      expect(invalidCustom.isError).toBe(true);
      expect(textOf(invalidCustom)).toContain('-32602');
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
            request: z
              .object({
                kind: z.literal('search'),
                limit: z.number().int().min(1).max(50),
                value: z.custom<string>((value) => typeof value === 'string'),
              })
              .describe('search request'),
            tags: z
              .array(z.custom<string>((value) => typeof value === 'string'))
              .min(1)
              .describe('one or more tags'),
          },
          async (args) => {
            nestedObserved(args);
            return {
              content: [{ type: 'text', text: args.request.value }],
            };
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
            type: 'object',
            description: 'search request',
            properties: {
              kind: { type: 'string', const: 'search' },
              limit: { type: 'integer', minimum: 1, maximum: 50 },
              value: {},
            },
            required: ['kind', 'limit', 'value'],
          },
          tags: {
            type: 'array',
            items: {},
            minItems: 1,
            description: 'one or more tags',
          },
        },
        required: ['request', 'tags'],
      });

      await expect(
        client.callTool({ name: 'mini', arguments: { value: 'valid' } }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'valid' }],
      });
      expect(miniObserved).toHaveBeenCalledWith({ value: 'valid' });
      miniObserved.mockClear();
      const invalidMini = await client.callTool({
        name: 'mini',
        arguments: { value: 7 },
      });
      expect(invalidMini.isError).toBe(true);
      expect(textOf(invalidMini)).toContain('-32602');
      expect(miniObserved).not.toHaveBeenCalled();

      await expect(
        client.callTool({
          name: 'nested',
          arguments: {
            request: { kind: 'search', limit: 51, value: 'valid' },
            tags: ['t'],
          },
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(nestedObserved).not.toHaveBeenCalled();

      const invalidArray = await client.callTool({
        name: 'nested',
        arguments: {
          request: { kind: 'search', limit: 1, value: 'valid' },
          tags: [],
        },
      });
      expect(invalidArray.isError).toBe(true);
      expect(nestedObserved).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.instance.close();
    }
  },
);

type ZodV3Shape = { value: z.ZodString; count: z.ZodNumber };

it.each([
  ['sdk', tool, createSdkMcpServer],
  ['daemon', daemonTool, createDaemonSdkMcpServer],
] as const)(
  '%s MCP discovery accepts Zod v3 and Mini raw shapes',
  async (_, defineTool, createServer) => {
    const v3Observed = vi.fn();
    const miniObserved = vi.fn();
    const server = createServer({
      name: 'legacy-shape-test',
      tools: [
        defineTool(
          'v3',
          'Validate a Zod v3 value',
          {
            value: z3.string(),
            count: z3.number().int().min(1),
          } as unknown as ZodV3Shape,
          async (args) => {
            v3Observed(args);
            return {
              content: [{ type: 'text', text: `${args.value}:${args.count}` }],
            };
          },
        ),
        defineTool(
          'mini',
          'Validate a Mini value',
          { value: mini.string() },
          async (args) => {
            miniObserved(args);
            return { content: [{ type: 'text', text: args.value }] };
          },
        ),
      ],
    });
    const client = new Client({
      name: 'legacy-shape-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(
        tools.find(({ name }) => name === 'v3')?.inputSchema,
      ).toMatchObject({
        type: 'object',
        properties: {
          value: { type: 'string' },
          count: { type: 'integer', minimum: 1 },
        },
        required: ['value', 'count'],
      });
      expect(
        tools.find(({ name }) => name === 'mini')?.inputSchema,
      ).toMatchObject({
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      });

      await expect(
        client.callTool({
          name: 'v3',
          arguments: { value: 'ok', count: 2 },
        }),
      ).resolves.toMatchObject({
        content: [{ type: 'text', text: 'ok:2' }],
      });
      expect(v3Observed).toHaveBeenCalledWith({ value: 'ok', count: 2 });
      v3Observed.mockClear();

      const wrongType = await client.callTool({
        name: 'v3',
        arguments: { value: 7, count: 2 },
      });
      expect(textOf(wrongType)).toContain('-32602');
      expect(v3Observed).not.toHaveBeenCalled();

      const tooSmall = await client.callTool({
        name: 'v3',
        arguments: { value: 'ok', count: 0 },
      });
      expect(textOf(tooSmall)).toContain('-32602');
      expect(v3Observed).not.toHaveBeenCalled();

      await expect(
        client.callTool({ name: 'mini', arguments: { value: 'ok' } }),
      ).resolves.toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
      expect(miniObserved).toHaveBeenCalledWith({ value: 'ok' });
      miniObserved.mockClear();
      await expect(
        client.callTool({ name: 'mini', arguments: { value: 7 } }),
      ).resolves.toMatchObject({ isError: true });
      expect(miniObserved).not.toHaveBeenCalled();
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
  '%s MCP registration leaves unrecognised shapes to the MCP SDK',
  (_, defineTool, createServer) => {
    // A field that is neither Zod v4 nor Zod v3 is returned untouched, exactly
    // as before this helper existed, so MCP's own registration guard rejects
    // it. It must not be silently routed down the Zod 4 conversion path.
    for (const field of [{ type: 'string' }, 42]) {
      expect(() =>
        createServer({
          name: 'unrecognised-shape-test',
          tools: [
            defineTool(
              'weird',
              'Non-schema field',
              { value: field } as unknown as { value: ZodType },
              async () => ({ content: [{ type: 'text', text: 'ok' }] }),
            ),
          ],
        }),
      ).toThrow('inputSchema must be a Zod schema or raw shape');
    }
  },
);

it('registerTool parses arguments and wraps errors like the legacy tool() call', async () => {
  const shape = {
    count: z.coerce.number().int().min(1),
    label: z.string().default('total'),
  };
  type CountArgs = { count: number; label: string };

  const makeHandler = () => {
    const seen: CountArgs[] = [];
    return {
      seen,
      handler: async (args: CountArgs): Promise<CallToolResult> => {
        seen.push(args);
        return {
          content: [{ type: 'text', text: `${args.label}: ${args.count}` }],
        };
      },
    };
  };

  const callAll = async (server: McpServer) => {
    const client = new Client({
      name: 'equivalence-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const results = [];
      for (const args of [
        { count: '7' },
        { count: '0' },
        { count: 'nope' },
        {},
      ]) {
        results.push(await client.callTool({ name: 'count', arguments: args }));
      }
      return results;
    } finally {
      await client.close();
      await server.close();
    }
  };

  const viaSdk = makeHandler();
  const viaLegacy = makeHandler();
  const sdkServer = createSdkMcpServer({
    name: 'equivalence',
    version: '1.0.0',
    tools: [tool('count', 'Parse a count', shape, viaSdk.handler)],
  }).instance;
  const legacyServer = new McpServer(
    { name: 'equivalence', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  legacyServer.tool('count', 'Parse a count', shape, viaLegacy.handler);

  const sdkResults = await callAll(sdkServer);
  const legacyResults = await callAll(legacyServer);

  expect(sdkResults).toEqual(legacyResults);
  expect(viaSdk.seen).toEqual(viaLegacy.seen);
  expect(viaSdk.seen).toEqual([{ count: 7, label: 'total' }]);
  expect(textOf(sdkResults[1])).toContain('-32602');
  expect(textOf(sdkResults[2])).toContain('-32602');
});

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content;
  return content?.[0]?.text ?? '';
}
