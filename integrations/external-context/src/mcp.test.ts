/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExternalContextMcpServer } from './mcp.js';
import type { ExternalContextConfig, ProviderBinding } from './types.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('external context MCP server', () => {
  it.each([false, true])(
    'registers only search when write.enabled=%s and no writer is available',
    async (writeEnabled) => {
      const runtime = {
        config: config(writeEnabled),
        binding: searchBinding(),
      };
      const client = await connect(runtime);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['context_search']);
      expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(true);
      expect(tools.tools[0]?.inputSchema).not.toHaveProperty(
        'properties.tenantId',
      );
      expect(tools.tools[0]?.inputSchema).not.toHaveProperty(
        'properties.repositoryId',
      );
      expect(tools.tools[0]?.inputSchema).not.toHaveProperty(
        'properties.filters',
      );
    },
  );

  it('returns normalized context from the bound search provider', async () => {
    const search = vi
      .fn()
      .mockResolvedValue([{ id: 'one', content: 'repository policy' }]);
    const client = await connect({
      config: config(false),
      binding: {
        type: 'generic-http-search-v1',
        provider: { search },
      },
    });

    const result = await client.callTool({
      name: 'context_search',
      arguments: {
        query: '  deployment\n policy ',
        tenantId: 'model-controlled',
        filters: { repository: 'other' },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(search).toHaveBeenCalledWith({
      query: 'deployment policy',
      limit: 5,
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(search.mock.calls)).not.toContain('model-controlled');
    const text = result.content[0];
    expect(text).toMatchObject({ type: 'text' });
    expect(JSON.parse(text.type === 'text' ? text.text : '{}')).toMatchObject({
      untrusted_external_context: {
        items: [{ id: 'one', content: 'repository policy' }],
      },
    });
  });

  it('registers remember only for an enabled writer and returns its status', async () => {
    const log = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const remember = vi.fn().mockResolvedValue({
      status: 'accepted',
      providerOperationId: 'event-1',
    });
    const runtime = {
      config: config(true),
      binding: {
        ...searchBinding(),
        writer: { remember },
      },
    };
    const client = await connect(runtime);
    const tools = await client.listTools();
    const rememberTool = tools.tools.find(
      (tool) => tool.name === 'context_remember',
    );
    expect(rememberTool?.annotations?.readOnlyHint).toBe(false);

    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content: '  shared decision  ' },
    });
    expect(remember).toHaveBeenCalledWith({
      content: 'shared decision',
      signal: expect.any(AbortSignal),
    });
    const text = result.content[0];
    expect(JSON.parse(text.type === 'text' ? text.text : '{}')).toEqual({
      status: 'accepted',
      providerOperationId: 'event-1',
    });
    expect(log.mock.calls.join(' ')).toContain('status=accepted');
  });

  it('returns stable errors without provider details', async () => {
    const client = await connect({
      config: config(false),
      binding: {
        type: 'generic-http-search-v1',
        provider: {
          search: vi
            .fn()
            .mockRejectedValue(new Error('secret upstream response body')),
        },
      },
    });

    const result = await client.callTool({
      name: 'context_search',
      arguments: { query: 'deployment' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('External context search failed.');
    expect(JSON.stringify(result)).not.toContain('secret upstream');
  });
});

function config(writeEnabled: boolean): ExternalContextConfig {
  return {
    version: 1,
    repositoryRoot: process.cwd(),
    autoRecall: { enabled: false, timeoutMs: 1000 },
    write: { enabled: writeEnabled },
    provider: {
      type: 'generic-http-search-v1',
      baseUrl: 'https://context.example.com',
      tokenEnv: 'TOKEN',
      token: 'secret',
    },
  };
}

function searchBinding(): ProviderBinding {
  return {
    type: 'generic-http-search-v1',
    provider: { search: vi.fn().mockResolvedValue([]) },
  };
}

async function connect(runtime: {
  config: ExternalContextConfig;
  binding: ProviderBinding;
}): Promise<Client> {
  const server = createExternalContextMcpServer(runtime);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
