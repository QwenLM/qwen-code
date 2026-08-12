/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from './config.js';
import { createExternalContextMcpServer, runMcp } from './mcp.js';
import type {
  ExternalContextConfig,
  ExternalContextConfigV1,
  ExternalContextProvider,
  ExternalMemoryWriter,
  RememberResult,
} from './types.js';

const loadConfig = vi.hoisted(() => vi.fn());

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  loadConfig,
}));

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  loadConfig.mockReset();
});

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

  it('reports an empty normalized query without calling the provider', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const client = await connect({
      config: config(),
      provider: { search },
    });

    const result = await client.callTool({
      name: 'context_search',
      arguments: { query: ' \t\n ' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Search query must not be empty.',
    );
    expect(search).not.toHaveBeenCalled();
  });

  it('registers the write tool only for an enabled Mem0 writer', async () => {
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer: memoryWriter({
        status: 'accepted',
        providerOperationId: '123e4567-e89b-12d3-a456-426614174000',
      }),
    });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'context_search',
      'context_remember',
    ]);
    const remember = tools.tools[1];
    expect(remember?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(remember?.inputSchema).toHaveProperty('properties.content');
    expect(JSON.stringify(remember?.inputSchema.properties)).not.toMatch(
      /tenant|repository|namespace|filter|metadata|app.?id/i,
    );
  });

  it('stores exact validated content without forwarding model selectors', async () => {
    const remember = vi.fn().mockResolvedValue({
      status: 'accepted',
      providerOperationId: '123e4567-e89b-12d3-a456-426614174000',
    });
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer: { remember },
    });
    const content = '  Keep 🙂 this\nexactly.  ';

    const result = await client.callTool({
      name: 'context_remember',
      arguments: {
        content,
        app_id: 'model-controlled',
        tenant: 'other',
        filters: { repository: 'other' },
        metadata: { private: true },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(remember).toHaveBeenCalledWith({
      content,
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(remember.mock.calls)).not.toMatch(
      /model-controlled|tenant|filter|metadata/i,
    );
    const text = result.content[0];
    expect(text).toMatchObject({ type: 'text' });
    expect(JSON.parse(text.type === 'text' ? text.text : '{}')).toEqual({
      status: 'accepted',
      providerOperationId: '123e4567-e89b-12d3-a456-426614174000',
    });
  });

  it.each([
    [{ status: 'stored' } satisfies RememberResult, false],
    [{ status: 'unknown' } satisfies RememberResult, true],
  ])('maps memory result %# to bounded MCP output', async (status, isError) => {
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer: memoryWriter(status),
    });

    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content: 'repository policy' },
    });

    expect(result.isError === true).toBe(isError);
    const text = result.content[0];
    expect(text).toMatchObject({ type: 'text' });
    expect(JSON.parse(text.type === 'text' ? text.text : '{}')).toMatchObject({
      status: status.status,
    });
    if (status.status === 'unknown') {
      expect(JSON.stringify(result)).toContain('Do not retry automatically.');
    }
  });

  it('returns a stable error for a definitive provider rejection', async () => {
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer: memoryWriter({ status: 'failed' }),
    });

    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content: 'repository policy' },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text).toMatchObject({ type: 'text' });
    const body = JSON.parse(text.type === 'text' ? text.text : '{}');
    expect(body).toMatchObject({ status: 'failed' });
    expect(body.message).toContain('provider rejected the memory');
    expect(body.message).toContain(
      'Do not retry without changing the content or configuration.',
    );
  });

  it('returns a stable memory error without provider details', async () => {
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer: {
        remember: vi
          .fn()
          .mockRejectedValue(new Error('secret upstream response body')),
      },
    });

    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content: 'repository policy' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'External context memory write failed.',
    );
    expect(JSON.stringify(result)).not.toContain('secret upstream');
  });

  it('aborts the memory writer when the client cancels the request', async () => {
    let writerSignal: AbortSignal | undefined;
    let signalReceived: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      signalReceived = resolve;
    });
    const remember = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          writerSignal = signal;
          signalReceived?.();
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer: { remember },
    });
    const controller = new AbortController();

    const result = client.callTool(
      {
        name: 'context_remember',
        arguments: { content: 'cancel this memory write' },
      },
      undefined,
      { signal: controller.signal },
    );
    await received;
    controller.abort();

    await expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(writerSignal?.aborted).toBe(true));
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('aborts the memory writer at the configured timeout', async () => {
    let writerSignal: AbortSignal | undefined;
    const remember = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<RememberResult>((resolve) => {
          writerSignal = signal;
          signal.addEventListener(
            'abort',
            () => resolve({ status: 'unknown' }),
            { once: true },
          );
        }),
    );
    const client = await connect({
      config: writeConfig(20),
      provider: searchProvider(),
      writer: { remember },
    });

    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content: 'time out this memory write' },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text).toMatchObject({ type: 'text' });
    const body = JSON.parse(text.type === 'text' ? text.text : '{}');
    expect(body).toMatchObject({ status: 'unknown' });
    expect(body.message).toContain('Do not retry automatically.');
    expect(writerSignal?.aborted).toBe(true);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['whitespace', ' \t\n '],
    ['control and format characters', '\u0000\u001f\u200b\u202e'],
    ['an unpaired high surrogate', '\ud800'],
    ['an unpaired low surrogate', '\udc00'],
    ['4001 Unicode characters', '🙂'.repeat(4001)],
  ])('rejects invalid memory content: %s', async (_name, content) => {
    const writer = memoryWriter({ status: 'stored' });
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer,
    });

    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content },
    });

    expect(result.isError).toBe(true);
    expect(writer.remember).not.toHaveBeenCalled();
  });

  it('accepts exactly 4000 astral Unicode characters', async () => {
    const writer = memoryWriter({ status: 'stored' });
    const client = await connect({
      config: writeConfig(),
      provider: searchProvider(),
      writer,
    });
    const content = '🙂'.repeat(4000);

    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content },
    });

    expect(result.isError).not.toBe(true);
    expect(writer.remember).toHaveBeenCalledWith({
      content,
      signal: expect.any(AbortSignal),
    });
  });
});

describe('runMcp', () => {
  it('registers the write tool for a write-enabled Mem0 config', async () => {
    loadConfig.mockResolvedValue(writeConfig());
    const registerTool = vi.spyOn(McpServer.prototype, 'registerTool');
    vi.spyOn(McpServer.prototype, 'connect').mockResolvedValue();

    await runMcp();

    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      'context_search',
      'context_remember',
    ]);
  });

  it('rejects a non-version-1 config at startup', async () => {
    loadConfig.mockResolvedValue({
      version: 2,
      timeoutMs: 5000,
      autoRecall: { repositoryRoot: '/tmp', timeoutMs: 1500 },
      provider: {
        type: 'generic-http-search-v1',
        baseUrl: 'https://context.example.com',
        tokenEnv: 'TOKEN',
        token: 'secret',
      },
    } satisfies ExternalContextConfig);

    await expect(runMcp()).rejects.toThrow(ConfigurationError);
    await expect(runMcp()).rejects.toThrow(
      'External context MCP server requires a version 1 configuration.',
    );
  });
});

function config(): ExternalContextConfigV1 {
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

function writeConfig(timeoutMs = 1000): ExternalContextConfigV1 {
  return {
    version: 1,
    timeoutMs,
    write: { enabled: true },
    provider: {
      type: 'mem0-platform-v3',
      apiKeyEnv: 'MEM0_API_KEY',
      apiKey: 'secret',
      appId: 'fixed-repository',
    },
  };
}

function searchProvider(): ExternalContextProvider {
  return {
    search: vi.fn().mockResolvedValue([]),
  };
}

function memoryWriter(result: RememberResult): ExternalMemoryWriter {
  return {
    remember: vi.fn().mockResolvedValue(result),
  };
}

async function connect(runtime: {
  config: ExternalContextConfigV1;
  provider: ExternalContextProvider;
  writer?: ExternalMemoryWriter;
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
