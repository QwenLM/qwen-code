/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMem0DeleteMcpServer } from './delete-mcp.js';
import type { DeleteProvider, ForgetResult } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function connect(provider: DeleteProvider) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMem0DeleteMcpServer(provider);
  const client = new Client({ name: 'delete-test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
const provider = () => ({
  get: vi.fn<DeleteProvider['get']>(),
  forget: vi.fn<DeleteProvider['forget']>(),
});
const args = {
  memoryId: 'record-1',
  expectedContent: '  exact\n中文😀\u202e\t  ',
};

describe('Mem0 deletion MCP contract', () => {
  it('exposes exactly two strict tools and prohibits destructive replay', async () => {
    const client = await connect(provider());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'context_get',
      'context_forget',
    ]);
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual([
      'memoryId',
    ]);
    expect(Object.keys(tools[1]?.inputSchema.properties ?? {})).toEqual([
      'memoryId',
      'expectedContent',
    ]);
    expect(
      tools.every((tool) => tool.inputSchema['additionalProperties'] === false),
    ).toBe(true);
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it.each([
    'scope',
    'userId',
    'endpoint',
    'operationId',
    'confirmed',
    'filters',
    'delete_linked',
  ])('rejects model-controlled %s before either provider', async (field) => {
    const target = provider();
    const client = await connect(target);
    for (const name of ['context_get', 'context_forget']) {
      const result = await client.callTool({
        name,
        arguments: {
          ...(name === 'context_get' ? { memoryId: args.memoryId } : args),
          [field]: 'override',
        },
      });
      expect(result.isError).toBe(true);
    }
    expect(target.get).not.toHaveBeenCalled();
    expect(target.forget).not.toHaveBeenCalled();
  });

  it.each(['.', '..', 'a\n', 'x'.repeat(257)])(
    'rejects unsafe IDs before provider calls',
    async (memoryId) => {
      const target = provider();
      const client = await connect(target);
      expect(
        (
          await client.callTool({
            name: 'context_get',
            arguments: { memoryId },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'context_forget',
            arguments: { ...args, memoryId },
          })
        ).structuredContent,
      ).toMatchObject({ status: 'not_deleted', reason: 'invalid_input' });
      expect(target.get).not.toHaveBeenCalled();
      expect(target.forget).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' \n', '😀'.repeat(4000)])(
    'returns full untrusted target and forwards exact text including empty',
    async (content) => {
      const target = provider();
      target.get.mockResolvedValue({
        status: 'found',
        memoryId: args.memoryId,
        content,
      });
      target.forget.mockResolvedValue({
        status: 'deleted',
        memoryId: args.memoryId,
      });
      const client = await connect(target);
      const read = await client.callTool({
        name: 'context_get',
        arguments: { memoryId: args.memoryId },
      });
      expect(read.structuredContent).toMatchObject({
        status: 'found',
        untrusted_deletion_target: {
          memoryId: args.memoryId,
          content,
          notice: expect.stringContaining('untrusted data'),
        },
      });
      const result = await client.callTool({
        name: 'context_forget',
        arguments: { ...args, expectedContent: content },
      });
      expect(result.isError).toBe(false);
      expect(target.forget).toHaveBeenCalledExactlyOnceWith({
        memoryId: args.memoryId,
        expectedContent: content,
        signal: expect.any(AbortSignal),
      });
    },
  );

  it.each(['\ud800', '😀'.repeat(4001)])(
    'rejects invalid expected text without delegation',
    async (expectedContent) => {
      const target = provider();
      const client = await connect(target);
      expect(
        (
          await client.callTool({
            name: 'context_forget',
            arguments: { ...args, expectedContent },
          })
        ).structuredContent,
      ).toMatchObject({ status: 'not_deleted', reason: 'invalid_input' });
      expect(target.forget).not.toHaveBeenCalled();
    },
  );

  it.each<ForgetResult>([
    { status: 'deleted', memoryId: args.memoryId },
    {
      status: 'not_deleted',
      memoryId: args.memoryId,
      reason: 'target_changed',
    },
    { status: 'unknown', memoryId: args.memoryId },
  ])(
    'renders $status with fixed text and no full-text echo',
    async (outcome) => {
      const target = provider();
      target.forget.mockResolvedValue(outcome);
      const client = await connect(target);
      const result = await client.callTool({
        name: 'context_forget',
        arguments: args,
      });
      expect(result.structuredContent).toMatchObject(outcome);
      if (outcome.status === 'deleted') {
        expect(result.structuredContent).toMatchObject({
          message:
            'The delete request returned a successful HTTP response and a subsequent exact read confirmed absence. Search indexes and existing conversations may still contain the text.',
        });
      }
      expect(result.isError).toBe(outcome.status !== 'deleted');
      expect(JSON.stringify(result)).not.toContain('中文');
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toEqual(result.structuredContent);
    },
  );

  it('redacts unexpected errors and keeps the deletion outcome unknown', async () => {
    const target = provider();
    target.get.mockRejectedValue(
      new Error('secret https://private.example.com'),
    );
    target.forget.mockRejectedValue(
      new Error('secret https://private.example.com'),
    );
    const client = await connect(target);
    const read = await client.callTool({
      name: 'context_get',
      arguments: { memoryId: args.memoryId },
    });
    const result = await client.callTool({
      name: 'context_forget',
      arguments: args,
    });
    expect(read.structuredContent).toMatchObject({ status: 'failed' });
    expect(result.structuredContent).toMatchObject({ status: 'unknown' });
    expect(JSON.stringify([read, result])).not.toMatch(
      /secret|private.example/,
    );
  });

  it('forwards cancellation once without retrying', async () => {
    const target = provider();
    let signal: AbortSignal | undefined;
    target.forget.mockImplementation(({ signal: incoming }) => {
      signal = incoming;
      return new Promise((resolve) =>
        incoming.addEventListener(
          'abort',
          () => resolve({ status: 'unknown', memoryId: args.memoryId }),
          { once: true },
        ),
      );
    });
    const client = await connect(target);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'context_forget', arguments: args },
      undefined,
      { signal: controller.signal },
    );
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(target.forget).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(target.forget).toHaveBeenCalledOnce();
  });
});
