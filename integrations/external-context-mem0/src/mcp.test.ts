/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMem0McpServer } from './mcp.js';
import { parseInstanceConfig } from './schemas.js';
import type { SearchProvider } from './types.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Mem0 External Context MCP server', () => {
  it('exposes only the strict External Context Profile v1 search tool', async () => {
    const client = await connect(vi.fn().mockResolvedValue([]));
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(['context_search']);
    expect(tools.tools[0]?.annotations).toMatchObject({
      destructiveHint: false,
    });
    expect(tools.tools[0]?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools.tools[0]?.inputSchema).toHaveProperty(
      'additionalProperties',
      false,
    );
    expect(tools.tools[0]?.inputSchema).not.toHaveProperty(
      'properties.endpoint',
    );
    expect(tools.tools[0]?.inputSchema).not.toHaveProperty('properties.scope');
    expect(tools.tools[0]?.inputSchema).not.toHaveProperty('properties.preset');
  });

  it('matches the shared Profile v1 contract vectors', async () => {
    const client = await connect(vi.fn().mockResolvedValue([]));
    const tool = (await client.listTools()).tools[0];
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validateInput = ajv.compile(tool?.inputSchema ?? false);
    const validateOutput = ajv.compile(tool?.outputSchema ?? false);
    const vectors = JSON.parse(
      await readFile(
        new URL(
          '../../external-context/contracts/v1/test-vectors.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as ProfileVectors;

    for (const vector of vectors.validInputs) {
      expect({ name: vector.name, valid: validateInput(vector.value) }).toEqual(
        { name: vector.name, valid: true },
      );
    }
    for (const vector of vectors.invalidInputs) {
      expect({ name: vector.name, valid: validateInput(vector.value) }).toEqual(
        { name: vector.name, valid: false },
      );
    }
    for (const vector of vectors.validOutputs) {
      expect({
        name: vector.name,
        valid: validateOutput(vector.value),
      }).toEqual({ name: vector.name, valid: true });
    }
    for (const vector of vectors.invalidOutputs) {
      expect({
        name: vector.name,
        valid: validateOutput(vector.value),
      }).toEqual({ name: vector.name, valid: false });
    }
  });

  it('normalizes only the query and returns structured untrusted context', async () => {
    const search = vi
      .fn<SearchProvider>()
      .mockResolvedValue([{ id: 'memory-1', content: '<policy>' }]);
    const client = await connect(search);

    const result = await client.callTool({
      name: 'context_search',
      arguments: { query: '  deployment\n policy ' },
    });

    expect(search).toHaveBeenCalledWith({
      query: 'deployment policy',
      signal: expect.any(AbortSignal),
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content[0];
    expect(text).toMatchObject({ type: 'text' });
    expect(text?.type === 'text' ? text.text : '').toContain(
      '\\u003cpolicy\\u003e',
    );
    expect(result.structuredContent).toEqual(
      JSON.parse(text?.type === 'text' ? (text.text ?? '{}') : '{}'),
    );
  });

  it('rejects model-selected configuration before calling the provider', async () => {
    const search = vi.fn<SearchProvider>().mockResolvedValue([]);
    const client = await connect(search);

    const result = await client.callTool({
      name: 'context_search',
      arguments: {
        query: 'deployment policy',
        endpoint: 'https://model-selected.example.com',
      },
    });

    expect(result.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns a stable redacted provider error', async () => {
    const search = vi
      .fn<SearchProvider>()
      .mockRejectedValue(
        new Error(
          'https://secret.example.com token=secret query=deployment policy',
        ),
      );
    const client = await connect(search);

    const result = await client.callTool({
      name: 'context_search',
      arguments: { query: 'deployment policy' },
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(serialized).toContain('External context search failed.');
    expect(serialized).not.toContain('secret.example.com');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('deployment policy');
  });

  it('propagates client cancellation to the provider request', async () => {
    let providerSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const search = vi.fn<SearchProvider>(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          providerSignal = signal;
          notifyStarted?.();
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const client = await connect(search);
    const controller = new AbortController();

    const result = client.callTool(
      {
        name: 'context_search',
        arguments: { query: 'cancel this search' },
      },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  });

  it('returns a bounded error when the provider timeout aborts the search', async () => {
    let providerSignal: AbortSignal | undefined;
    const search = vi.fn<SearchProvider>(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const client = await connect(search, 100);

    const result = await client.callTool({
      name: 'context_search',
      arguments: { query: 'time out this search' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'External context search failed.' },
    ]);
    expect(providerSignal?.aborted).toBe(true);
  });
});

async function connect(
  search: SearchProvider,
  timeoutMs = 5000,
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMem0McpServer({
    instance: parseInstanceConfig({
      schemaVersion: 2,
      dialectPath: '/administrator/synthetic-v1.dialect.json',
      endpoint: { origin: 'https://memory.example.com' },
      credentialEnv: 'SYNTHETIC_MEMORY_TOKEN',
      scope: {},
      timeoutMs,
    }),
    search,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface ProfileVector {
  name: string;
  value: unknown;
}

interface ProfileVectors {
  validInputs: ProfileVector[];
  invalidInputs: ProfileVector[];
  validOutputs: ProfileVector[];
  invalidOutputs: ProfileVector[];
}
