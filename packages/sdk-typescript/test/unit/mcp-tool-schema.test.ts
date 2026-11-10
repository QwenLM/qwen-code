/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
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
