/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

type JsonObject = Record<string, unknown>;

export type FakeOpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type FakeOpenAIResponse = {
  content?: string;
  contentChunks?: string[];
  toolCalls?: FakeOpenAIToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length';
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type FakeOpenAIErrorResponse = {
  status: number;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

export type FakeOpenAIRequest = {
  body: JsonObject;
};

export type FakeOpenAIServer = {
  baseUrl: string;
  requests: FakeOpenAIRequest[];
  close: () => Promise<void>;
};

export type FakeOpenAIServerOptions =
  | { listenHost?: undefined; baseUrlHost?: undefined }
  | { listenHost: string; baseUrlHost: string };

export type FakeOpenAIHandler = (ctx: {
  body: JsonObject;
  requestIndex: number;
}) =>
  | FakeOpenAIResponse
  | FakeOpenAIErrorResponse
  | Promise<FakeOpenAIResponse | FakeOpenAIErrorResponse>;

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('fake OpenAI request body too large');
  }
}

export function fakeToolCall(
  name: string,
  args: JsonObject,
  id = `call_${randomUUID()}`,
): FakeOpenAIToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

export async function startFakeOpenAIServer(
  handler: FakeOpenAIHandler,
  options: FakeOpenAIServerOptions = {},
): Promise<FakeOpenAIServer> {
  const requests: FakeOpenAIRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    try {
      const rawBody = await readRequestBody(req);
      const body = parseJsonBody(rawBody);
      if (!body) {
        res.writeHead(400);
        res.end('bad json');
        return;
      }

      const requestIndex = requests.length;
      requests.push({ body });

      const response = await handler({ body, requestIndex });
      if (isErrorResponse(response)) {
        writeErrorResponse(res, response);
        return;
      }

      if (body['stream'] === true) {
        writeStreamed(res, getModel(body), response);
      } else {
        writeNonStreamed(res, getModel(body), response);
      }
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        res.writeHead(413);
        res.end('request body too large');
        return;
      }

      if (res.headersSent) {
        if (!res.writableEnded) {
          res.destroy();
        }
        return;
      }

      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'fake OpenAI server handler failed',
            type: 'server_error',
          },
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, options.listenHost ?? '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to start fake OpenAI server');
  }

  return {
    baseUrl: `http://${options.baseUrlHost ?? '127.0.0.1'}:${
      (address as AddressInfo).port
    }/v1`,
    requests,
    close: () => closeServer(server),
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      totalLength += chunk.length;
      if (totalLength > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseJsonBody(rawBody: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getModel(body: JsonObject): string {
  return typeof body['model'] === 'string' ? body['model'] : 'fake-model';
}

function isErrorResponse(
  response: FakeOpenAIResponse | FakeOpenAIErrorResponse,
): response is FakeOpenAIErrorResponse {
  return 'status' in response;
}

function writeErrorResponse(
  res: ServerResponse,
  response: FakeOpenAIErrorResponse,
): void {
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      error: response.error ?? {
        message: `fake OpenAI error ${response.status}`,
        type: response.status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    }),
  );
}

function writeNonStreamed(
  res: ServerResponse,
  model: string,
  message: FakeOpenAIResponse,
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: chatCompletionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: message.content ?? message.contentChunks?.join('') ?? null,
            ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
          },
          finish_reason: finishReason(message),
        },
      ],
      usage: message.usage ?? DEFAULT_USAGE,
    }),
  );
}

function writeStreamed(
  res: ServerResponse,
  model: string,
  message: FakeOpenAIResponse,
): void {
  res.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream',
  });

  const id = chatCompletionId();
  const created = nowSeconds();
  const chunk = (
    delta: JsonObject,
    finish_reason: string | null = null,
    usage?: FakeOpenAIResponse['usage'],
  ) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  });
  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send(chunk({ role: 'assistant' }));
  for (const content of message.contentChunks ?? []) {
    send(chunk({ content }));
  }
  if (!message.contentChunks && message.content) {
    send(chunk({ content: message.content }));
  }
  for (const [index, toolCall] of (message.toolCalls ?? []).entries()) {
    send(
      chunk({
        tool_calls: [
          {
            index,
            id: toolCall.id,
            type: toolCall.type,
            function: {
              name: toolCall.function.name,
              arguments: '',
            },
          },
        ],
      }),
    );
    if (toolCall.function.arguments) {
      send(
        chunk({
          tool_calls: [
            {
              index,
              function: {
                arguments: toolCall.function.arguments,
              },
            },
          ],
        }),
      );
    }
  }
  send(chunk({}, finishReason(message), message.usage ?? DEFAULT_USAGE));
  res.write('data: [DONE]\n\n');
  res.end();
}

function finishReason(message: FakeOpenAIResponse): string {
  return message.finishReason ?? (message.toolCalls ? 'tool_calls' : 'stop');
}

const DEFAULT_USAGE: NonNullable<FakeOpenAIResponse['usage']> = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

function chatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
