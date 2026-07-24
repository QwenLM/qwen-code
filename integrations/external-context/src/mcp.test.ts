/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExternalContextMcpServer } from './mcp.js';
import type {
  ExternalContextConfig,
  ExternalContextProvider,
} from './types.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('external context MCP server', () => {
  it('registers only a provider-bound retrieval tool', async () => {
    const client = await connect({
      config: config(),
      provider: searchProvider(),
    });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['context_search']);
    expect(tools.tools[0]?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools.tools[0]?.annotations?.destructiveHint).toBe(false);
    expect(tools.tools[0]?.inputSchema).not.toHaveProperty(
      'properties.tenantId',
    );
    expect(tools.tools[0]?.inputSchema).not.toHaveProperty(
      'properties.repositoryId',
    );
    expect(tools.tools[0]?.inputSchema).not.toHaveProperty(
      'properties.filters',
    );
  });

  it('returns normalized context from the bound search provider', async () => {
    const search = vi
      .fn()
      .mockResolvedValue([{ id: 'one', content: 'repository policy' }]);
    const client = await connect({
      config: config(),
      provider: { search },
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

  it('accepts 2000 astral Unicode characters and rejects 2001', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const client = await connect({
      config: config(),
      provider: { search },
    });
    const acceptedQuery = '🙂'.repeat(2000);

    const result = await client.callTool({
      name: 'context_search',
      arguments: { query: acceptedQuery },
    });
    expect(result.isError).not.toBe(true);
    expect(search).toHaveBeenCalledWith({
      query: acceptedQuery,
      limit: 5,
      signal: expect.any(AbortSignal),
    });

    const rejected = await client.callTool({
      name: 'context_search',
      arguments: { query: `${acceptedQuery}🙂` },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain(
      'Search query must contain at most 2000',
    );
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('aborts the provider when the client cancels a tool request', async () => {
    let providerSignal: AbortSignal | undefined;
    let signalReceived: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      signalReceived = resolve;
    });
    const search = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          providerSignal = signal;
          signalReceived?.();
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const client = await connect({
      config: config(),
      provider: { search },
    });
    const controller = new AbortController();

    const result = client.callTool(
      {
        name: 'context_search',
        arguments: { query: 'cancel this request' },
      },
      undefined,
      { signal: controller.signal },
    );
    await received;
    controller.abort();

    await expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  });

  it('returns stable errors without provider details', async () => {
    const client = await connect({
      config: config(),
      provider: {
        search: vi
          .fn()
          .mockRejectedValue(new Error('secret upstream response body')),
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

function config(): ExternalContextConfig {
  return {
    version: 1,
    timeoutMs: 1000,
    provider: {
      type: 'generic-http-search-v1',
      baseUrl: 'https://context.example.com',
      tokenEnv: 'TOKEN',
      token: 'secret',
    },
  };
}

function searchProvider(): ExternalContextProvider {
  return {
    search: vi.fn().mockResolvedValue([]),
  };
}

async function connect(runtime: {
  config: ExternalContextConfig;
  provider: ExternalContextProvider;
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
