/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMem0WriteMcpServer } from './write-mcp.js';
import type { RememberProvider, RememberResult } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connect(remember: RememberProvider) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMem0WriteMcpServer(remember);
  const client = new Client({ name: 'write-test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('Mem0 writer MCP', () => {
  it('exposes only strict content-only non-idempotent remember', async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['context_remember']);
    expect(tools[0]?.inputSchema['additionalProperties']).toBe(false);
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual([
      'content',
    ]);
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it.each(['scope', 'userId', 'endpoint', 'metadata', 'infer', 'memoryId'])(
    'rejects model-selected %s',
    async (field) => {
      const remember = vi.fn<RememberProvider>();
      const client = await connect(remember);
      const result = await client.callTool({
        name: 'context_remember',
        arguments: { content: 'save this', [field]: 'override' },
      });
      expect(result.isError).toBe(true);
      expect(remember).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' \n', '\u0000\u202e', '\ud800', 'x'.repeat(4001)])(
    'rejects invalid content locally',
    async (content) => {
      const remember = vi.fn<RememberProvider>();
      const client = await connect(remember);
      const result = await client.callTool({
        name: 'context_remember',
        arguments: { content },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'failed' });
      expect(remember).not.toHaveBeenCalled();
    },
  );

  it.each<RememberResult>([
    { status: 'stored', memoryId: 'record-1' },
    { status: 'accepted', providerOperationId: 'operation-1' },
    { status: 'failed' },
    { status: 'unknown' },
  ])(
    'preserves exact content and reports $status with fixed text',
    async (outcome) => {
      const remember = vi.fn<RememberProvider>().mockResolvedValue(outcome);
      const client = await connect(remember);
      const content = '  keep\n中文 😀 "quote"\t\u202e  ';
      const result = await client.callTool({
        name: 'context_remember',
        arguments: { content },
      });
      expect(remember).toHaveBeenCalledExactlyOnceWith({
        content,
        signal: expect.any(AbortSignal),
      });
      expect(result.isError).toBe(
        outcome.status === 'failed' || outcome.status === 'unknown',
      );
      expect(result.structuredContent).toMatchObject(outcome);
      expect(JSON.stringify(result)).not.toContain('keep');
      const text = (result.content as Array<{ type: string; text: string }>)[0]!
        .text;
      expect(JSON.parse(text)).toEqual(result.structuredContent);
    },
  );

  it('redacts unexpected provider errors as unknown', async () => {
    const client = await connect(
      vi
        .fn<RememberProvider>()
        .mockRejectedValue(
          new Error('secret-token https://private.example.com'),
        ),
    );
    const result = await client.callTool({
      name: 'context_remember',
      arguments: { content: 'save' },
    });
    expect(result.structuredContent).toMatchObject({ status: 'unknown' });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|private.example/);
  });

  it('forwards cancellation without initiating another write', async () => {
    let signal: AbortSignal | undefined;
    const remember = vi.fn<RememberProvider>(({ signal: incoming }) => {
      signal = incoming;
      return new Promise((resolve) =>
        incoming.addEventListener(
          'abort',
          () => resolve({ status: 'unknown' }),
          { once: true },
        ),
      );
    });
    const client = await connect(remember);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'context_remember', arguments: { content: 'save' } },
      undefined,
      { signal: controller.signal },
    );
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(remember).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(remember).toHaveBeenCalledOnce();
  });
});
