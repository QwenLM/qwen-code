/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SettingsService } from '@qwen-code/resource';
import { HttpTransport } from '../../client/transport/httpTransport.js';
import type { ModelProvider } from '../modelProvider.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import { ChatCompletionsTransport } from '../transport/impl/chatCompletionsTransport.js';
import { MessagesTransport } from '../transport/impl/messagesTransport.js';
import { ResponsesTransport } from '../transport/impl/responsesTransport.js';
import { createCustomModelProviders } from './customModelProviderFactory.js';

const protocols = [
  {
    name: 'openai',
    metadata: [
      {
        id: 'a',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      },
    ],
    payload: [
      {
        id: 'a',
        model: 'm',
        choices: [
          { index: 0, delta: { content: 'answer' }, finish_reason: null },
        ],
      },
    ],
    terminal: [
      {
        id: 'a',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ],
  },
  {
    name: 'openai-responses',
    metadata: [{ type: 'response.created', response: { id: 'a', model: 'm' } }],
    payload: [
      { type: 'response.output_text.delta', output_index: 0, delta: 'answer' },
    ],
    terminal: [{ type: 'response.completed', response: {} }],
  },
  {
    name: 'anthropic',
    metadata: [{ type: 'message_start', message: { id: 'a', model: 'm' } }],
    payload: [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'answer' },
      },
    ],
    terminal: [
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ],
  },
];
type Protocol = (typeof protocols)[number];
const active: Array<{ provider: ModelProvider; completed: Promise<unknown> }> =
  [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const h of active.splice(0)) {
    await h.provider.stop();
    await h.completed;
  }
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Exercise settings → factory → Provider → real protocol/client/pipeline; replace only HTTP. */
async function setup(
  protocol: Protocol,
  options: {
    firstPayloadTimeoutMs?: number;
    type?: string;
    stalledHeaders?: boolean;
    skipMetadata?: boolean;
  } = {},
) {
  const sends: Array<{
    signal: AbortSignal;
    body: ReadableStreamDefaultController<Uint8Array>;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const write = (frames: unknown[]) =>
    sends
      .at(-1)!
      .body.enqueue(
        new TextEncoder().encode(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
        ),
      );
  vi.spyOn(HttpTransport.prototype, 'invoke').mockImplementation(
    async (request, response) => {
      const cancel = vi.fn();
      const raw = new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            sends.push({ signal: request.signal!, body, cancel });
          },
          cancel,
        }),
      );
      if (options.stalledHeaders) {
        await new Promise<never>((_resolve, reject) =>
          request.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          ),
        );
      }
      response.raw = raw;
      if (!options.skipMetadata) write(protocol.metadata);
    },
  );
  const provider = createCustomModelProviders(
    {
      gateway: {
        baseUrl: 'https://gateway.invalid/v1',
        apiKey: 'test-only-key',
        protocol: protocol.name,
        models: [{ model: 'm' }],
        ...(options.type ? { type: options.type } : {}),
        ...(options.firstPayloadTimeoutMs === undefined
          ? {}
          : { firstPayloadTimeoutMs: options.firstPayloadTimeoutMs }),
      },
    },
    new ModelTransportManager([
      new ChatCompletionsTransport(),
      new ResponsesTransport(),
      new MessagesTransport(),
    ]),
    new SettingsService(),
    'user',
  )[0]!;
  const model = (await provider.getModel('gateway/m'))!;
  const caller = new AbortController();
  const response = await provider.inference({
    resolution: { model, config: {} },
    prompt: { messages: [{ role: 'user', content: 'hello' }] },
    control: { signal: caller.signal },
  });
  const completed = response.completed.catch((error) => error);
  active.push({ provider, completed });
  await vi.advanceTimersByTimeAsync(0);
  const finish = () => {
    write(protocol.terminal);
    sends.at(-1)!.body.close();
  };
  return { response, completed, caller, sends, write, finish };
}

describe('Custom Provider first effective payload budget', () => {
  it.each([
    { firstPayloadTimeoutMs: 120_000, type: undefined, budget: 120_000 },
    { firstPayloadTimeoutMs: undefined, type: 'alibaba', budget: 180_000 },
    { firstPayloadTimeoutMs: undefined, type: undefined, budget: 60_000 },
  ])(
    'honors parsed Provider budget $budget',
    async ({ firstPayloadTimeoutMs, type, budget }) => {
      const h = await setup(protocols[0], {
        firstPayloadTimeoutMs,
        type,
        skipMetadata: true,
      });
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sends[0].signal.aborted).toBe(true);
    },
  );

  it.each(protocols)(
    'does not reset the budget for $name metadata or keepalives',
    async (protocol) => {
      const h = await setup(protocol, { firstPayloadTimeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(40_000);
      h.write(protocol.metadata);
      h.sends[0].body.enqueue(new TextEncoder().encode(':keepalive\n\n'));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.sends[0].signal.aborted).toBe(true);
      expect(h.sends[0].cancel).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      const error = await h.completed;
      expect(error).toMatchObject({
        kind: 'network',
        code: 'network_failure',
        phase: 'before_output',
      });
      expect(h.sends).toHaveLength(5);
      const streamed = (async () => {
        try {
          for await (const _event of h.response.events) {
            // Drain buffered events before observing the terminal failure.
          }
        } catch (failure) {
          return failure;
        }
        return undefined;
      })();
      expect(await streamed).toBe(error);
    },
  );

  it.each(protocols)(
    'allows $name generation beyond the startup budget after output',
    async (protocol) => {
      const h = await setup(protocol, { firstPayloadTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(40);
      h.write(protocol.payload);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0].signal.aborted).toBe(false);
      h.finish();
      expect((await h.response.completed).blocks).toEqual([
        { type: 'text', text: 'answer' },
      ]);
    },
  );

  it.each([
    { reasoning_content: 'thinking' },
    {
      tool_calls: [
        {
          index: 0,
          id: 'tool',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        },
      ],
    },
  ])('accepts reasoning and tool payloads', async (delta) => {
    const h = await setup(protocols[0], { firstPayloadTimeoutMs: 50 });
    h.write([
      {
        id: 'a',
        model: 'm',
        choices: [{ index: 0, delta, finish_reason: null }],
      },
    ]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.sends[0].signal.aborted).toBe(false);
    h.write(protocols[0].payload);
    h.finish();
    expect((await h.response.completed).blocks).toContainEqual({
      type: 'text',
      text: 'answer',
    });
  });

  it('bounds response-header waits and preserves timeout classification through AbortError', async () => {
    const h = await setup(protocols[0], {
      firstPayloadTimeoutMs: 50,
      stalledHeaders: true,
    });
    await vi.runAllTimersAsync();
    expect(await h.completed).toMatchObject({
      kind: 'network',
      code: 'network_failure',
    });
    expect(h.sends).toHaveLength(5);
  });

  it('keeps caller cancellation ahead of the timeout and prevents retries', async () => {
    const h = await setup(protocols[0], { firstPayloadTimeoutMs: 50 });
    const error = new DOMException('User cancelled', 'AbortError');
    h.caller.abort(error);
    expect(await h.completed).toBe(error);
    await vi.runAllTimersAsync();
    expect(h.sends).toHaveLength(1);
  });

  it.each([false, true])(
    'cancels real HTTP before effective output (headers=%s)',
    async (headers) => {
      vi.useRealTimers();
      let disconnect!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        disconnect = resolve;
      });
      let requests = 0;
      const server = createServer((req, res) => {
        requests++;
        req.resume();
        req.on('end', () => {
          res.once('close', disconnect);
          if (headers) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify(protocols[0].metadata[0])}\n\n`);
          }
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const provider = createCustomModelProviders(
        {
          gateway: {
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            apiKey: 'test-only',
            protocol: 'openai',
            models: [{ model: 'm' }],
            firstPayloadTimeoutMs: 200,
          },
        },
        new ModelTransportManager([new ChatCompletionsTransport()]),
        new SettingsService(),
        'user',
      )[0]!;
      try {
        const model = (await provider.getModel('gateway/m'))!;
        const response = await provider.inference({
          resolution: { model, config: {} },
          prompt: { messages: [] },
        });
        active.push({
          provider,
          completed: response.completed.catch((error) => error),
        });
        await disconnected;
        expect(requests).toBe(1);
      } finally {
        await provider.stop();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    5000,
  );
});
