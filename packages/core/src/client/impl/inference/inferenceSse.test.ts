/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomProviderConfig } from '../../../provider/impl/customProviderConfig.js';
import { OPENAI_CHAT_COMPLETIONS } from '../../../provider/transport/modelProtocol.js';
import { ClientError } from '../../clientError.js';
import { CustomClientImpl } from '../../customClientImpl.js';
import { INFERENCE } from '../../endpoint/endpointType.js';
import { runLogger } from '../../../utils/runLogger.js';

interface Received {
  readonly method?: string;
  readonly path?: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

type Reply = (res: ServerResponse) => void;

function sse(...frames: string[]): Reply {
  return (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const frame of frames) res.write(`data: ${frame}\n\n`);
    res.end();
  };
}

let server: Server;
let origin: string;
let received: Received[];
let reply: Reply;

beforeAll(async () => {
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  reply = sse('[DONE]');
});

function client(
  baseUrl: string,
  authType: 'bearer' | 'api-key' = 'bearer',
): CustomClientImpl {
  return new CustomClientImpl({
    customProviderConfig: new CustomProviderConfig({
      providerId: 'p',
      baseUrl,
      apiKey: 'sk-test',
      authType,
      models: [],
      protocol: OPENAI_CHAT_COMPLETIONS,
    }),
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('CustomProviderConfig 端点反馈', () => {
  it.each(['success', 'failure'] as const)(
    '%s 反馈保留固定端点和凭证，仅失败时记录脱敏提示',
    async (outcome) => {
      const config = new CustomProviderConfig({
        providerId: 'private-provider',
        baseUrl: 'https://user:password@provider.test/v1?token=private-token',
        apiKey: 'private-key',
        authType: 'bearer',
        models: [],
        protocol: OPENAI_CHAT_COMPLETIONS,
      });
      const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      try {
        const before = await config.resolve(INFERENCE);

        expect(before?.report).toEqual(expect.any(Function));
        expect(before!.report!(outcome)).toBeUndefined();

        expect((await config.resolve(INFERENCE))?.origin).toBe(before!.origin);
        expect(config.baseUrl).toBe(before!.origin);
        expect(config.getBearer()).toBe('private-key');
        if (outcome === 'failure') {
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            '[custom-provider] Fixed endpoint request failed; only one endpoint can be configured; endpoint failover is not supported.'
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe('streamInferenceSse via CustomClientImpl', () => {
  it('Chat Completions：拼 /chat/completions，带 JSON/SSE 标头与 Bearer，解析到 [DONE] 为止', async () => {
    reply = sse('{"id":"a"}', '', '{"id":"b"}', '[DONE]', '{"id":"late"}');
    const body = {
      model: 'gpt-4o',
      messages: [{ role: 'user' as const, content: 'hi' }],
      stream: true as const,
    };

    const events = await collect(
      client(`${origin}/v1`).api.inference.chatCompletions.stream(body),
    );

    expect(events).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['accept']).toBe('text/event-stream');
    expect(request.headers['authorization']).toBe('Bearer sk-test');
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.body).toEqual(body);
  });

  it('baseUrl 已以完整路径结尾时直接使用', async () => {
    await collect(
      client(`${origin}/v1/chat/completions`).api.inference.chatCompletions.stream(
        { model: 'm', messages: [], stream: true },
      ),
    );
    expect(received[0].path).toBe('/v1/chat/completions');
  });

  it('Responses：baseUrl 带不带 /v1 都落到 /v1/responses', async () => {
    const body = { model: 'm', input: 'hi', stream: true as const };
    await collect(
      client(`${origin}/v1`).api.inference.responses.stream(body),
    );
    await collect(client(origin).api.inference.responses.stream(body));
    expect(received.map((request) => request.path)).toEqual([
      '/v1/responses',
      '/v1/responses',
    ]);
  });

  it('Messages：baseUrl 带不带 /v1 都落到 /v1/messages，带 anthropic-version 与 x-api-key', async () => {
    const body = {
      model: 'claude',
      max_tokens: 16,
      messages: [{ role: 'user' as const, content: 'hi' }],
      stream: true as const,
    };
    await collect(
      client(origin, 'api-key').api.inference.messages.stream(body),
    );
    await collect(
      client(`${origin}/v1`, 'api-key').api.inference.messages.stream(body),
    );

    expect(received.map((r) => r.path)).toEqual([
      '/v1/messages',
      '/v1/messages',
    ]);
    expect(received[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(received[0].headers['x-api-key']).toBe('sk-test');
    expect(received[0].headers['authorization']).toBeUndefined();
  });

  it('非 2xx 抛 ClientError，携带状态码与完整响应体', async () => {
    reply = (res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad key"}');
    };

    const error = await collect(
      client(`${origin}/v1`).api.inference.chatCompletions.stream({
        model: 'm',
        messages: [],
        stream: true,
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      operation: 'inference.chatCompletions.stream',
      statusCode: 401,
      responseBody: '{"error":"bad key"}',
    });
    expect((error as Error).message).toContain('HTTP 401');
  });

  it('SSE 帧不是 JSON 时抛 ClientError', async () => {
    reply = sse('not json');

    await expect(
      collect(
        client(`${origin}/v1`).api.inference.responses.stream({
          model: 'm',
          input: 'hi',
          stream: true,
        }),
      ),
    ).rejects.toThrow('inference.responses.stream: invalid SSE event');
  });

  it('signal 已中止时不发请求', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(
        client(`${origin}/v1`).api.inference.chatCompletions.stream(
          { model: 'm', messages: [], stream: true },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toThrow();
    expect(received).toHaveLength(0);
  });

  it('流式过程中中止会结束迭代并抛错', async () => {
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"a"}\n\n');
      // 保持连接不结束，等待客户端中止。
    };
    const controller = new AbortController();
    const stream = client(`${origin}/v1`).api.inference.chatCompletions.stream(
      { model: 'm', messages: [], stream: true },
      { signal: controller.signal },
    );

    const events: unknown[] = [];
    const error = await (async () => {
      for await (const event of stream) {
        events.push(event);
        controller.abort();
      }
    })().catch((e: unknown) => e);

    expect(events).toEqual([{ id: 'a' }]);
    expect(error).toBeDefined();
  });
});
