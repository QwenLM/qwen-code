/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scriptable stand-in for the DashScope qwen-omni realtime endpoint that
 * `packages/qwen-live` connects to (`ws://…/api-ws/v1/realtime?model=…`).
 *
 * Wire behavior mirrors what the daemon's realtime client
 * (`packages/qwen-live/src/realtime/realtime-session.ts`) expects:
 *   - on connect the server sends `session.created`; the client answers with
 *     `session.update`, which we acknowledge with `session.updated` so the
 *     client resolves its open() promise;
 *   - every client message is recorded in `inbox` for assertions
 *     (session.update payload, input_audio_buffer.append frames,
 *     conversation.item.create context/function_call_output items,
 *     response.create, …);
 *   - the test drives the model side through the per-connection script API
 *     (`speakTranscript`, `functionCall`, `respondWithAudio`,
 *     `beginResponse`/`finishResponse`). Message shapes follow the provider
 *     events the client's `case` branches parse (see the responseCreated /
 *     functionCall / responseDone helpers in
 *     packages/qwen-live/src/realtime/realtime-session.test.ts).
 *
 * `autoAckResponses` (default on) answers client-initiated `response.create`
 * requests (speakToUser flow) with an immediate `response.created` +
 * `response.done` pair so the client's response arbitration never stalls.
 * Tests that need a response held in flight open one manually with
 * `beginResponse()` and settle it with `finishResponse()`.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FakeDashScopeFunctionCall {
  name: string;
  /** Raw JSON string handed to the client as `item.arguments`. */
  argumentsJson: string;
  callId: string;
}

export interface FakeDashScopeConnection {
  readonly index: number;
  readonly socket: WebSocket;
  /** Raw upgrade-request URL (path + query). */
  readonly requestUrl: string;
  /** `model` query parameter from the upgrade URL. */
  readonly model: string | undefined;
  /** `Authorization` header presented by the client. */
  readonly authorization: string | undefined;
  /** Send one raw provider event (an `event_id` is added automatically). */
  send(message: JsonObject): void;
  /**
   * Simulate one finished user utterance:
   * speech_started → speech_stopped → input_audio_buffer.committed →
   * conversation.item.input_audio_transcription.completed.
   * Returns the item id.
   */
  speakTranscript(text: string): string;
  /**
   * Simulate the model calling a tool: response.created →
   * response.output_item.done (item.type = 'function_call') → response.done.
   * Returns the response id.
   */
  functionCall(call: FakeDashScopeFunctionCall): string;
  /**
   * Simulate a direct spoken answer: response.created →
   * response.audio.delta (base64) → response.audio.done → response.done.
   * Returns the response id.
   */
  respondWithAudio(pcm16: Uint8Array): string;
  /** Open a response and leave it in flight. Returns the response id. */
  beginResponse(): string;
  /** Settle a response previously opened with beginResponse(). */
  finishResponse(responseId: string, status?: string): void;
}

export interface WaitForMessageOptions {
  timeoutMs?: number;
  /** Only consider inbox entries at or after this index (default 0). */
  fromIndex?: number;
  description?: string;
}

export interface FakeDashScopeServer {
  /** HTTP origin, e.g. `http://127.0.0.1:PORT` — feed to the daemon as QWEN_LIVE_REALTIME_ENDPOINT. */
  url: string;
  port: number;
  connections: FakeDashScopeConnection[];
  /** Every JSON message received from every connection, in arrival order. */
  inbox: JsonObject[];
  /** Answer client `response.create` with created+done automatically. */
  autoAckResponses: boolean;
  waitForConnection(timeoutMs?: number): Promise<FakeDashScopeConnection>;
  waitForMessage(
    predicate: (message: JsonObject) => boolean,
    opts?: WaitForMessageOptions,
  ): Promise<JsonObject>;
  close(): Promise<void>;
}

/**
 * If `message` is a `conversation.item.create` carrying a
 * `function_call_output` item, return its call id and output string.
 */
export function functionCallOutputOf(
  message: JsonObject,
): { callId: string; output: string } | undefined {
  if (message['type'] !== 'conversation.item.create') return undefined;
  const item = message['item'];
  if (!isRecord(item) || item['type'] !== 'function_call_output') {
    return undefined;
  }
  if (
    typeof item['call_id'] !== 'string' ||
    typeof item['output'] !== 'string'
  ) {
    return undefined;
  }
  return { callId: item['call_id'], output: item['output'] };
}

/**
 * If `message` is a `conversation.item.create` carrying a user text item
 * (the daemon's context/speech injections), return its text body.
 */
export function contextTextOf(message: JsonObject): string | undefined {
  if (message['type'] !== 'conversation.item.create') return undefined;
  const item = message['item'];
  if (!isRecord(item) || item['type'] !== 'message') return undefined;
  const content = item['content'];
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (!isRecord(first) || first['type'] !== 'input_text') return undefined;
  return typeof first['text'] === 'string' ? first['text'] : undefined;
}

export async function startFakeDashScopeServer(): Promise<FakeDashScopeServer> {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server: httpServer });
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const connections: FakeDashScopeConnection[] = [];
  const inbox: JsonObject[] = [];
  let eventSeq = 0;
  let itemSeq = 0;
  let responseSeq = 0;

  const handle: FakeDashScopeServer = {
    url: '',
    port: 0,
    connections,
    inbox,
    autoAckResponses: true,
    waitForConnection: (timeoutMs = 15_000) => {
      if (connections.length > 0) return Promise.resolve(connections[0]);
      return new Promise<FakeDashScopeConnection>((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('connection', onConnection);
          reject(
            new Error(
              `fake DashScope: no realtime connection within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        const onConnection = (connection: FakeDashScopeConnection) => {
          clearTimeout(timer);
          resolve(connection);
        };
        emitter.once('connection', onConnection);
      });
    },
    waitForMessage: (predicate, opts = {}) => {
      const fromIndex = opts.fromIndex ?? 0;
      const timeoutMs = opts.timeoutMs ?? 15_000;
      for (let i = Math.max(fromIndex, 0); i < inbox.length; i++) {
        if (predicate(inbox[i])) return Promise.resolve(inbox[i]);
      }
      return new Promise<JsonObject>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          emitter.off('message', onMessage);
        };
        const timer = setTimeout(() => {
          cleanup();
          const recent = inbox
            .slice(-15)
            .map((message) => String(message['type']))
            .join(', ');
          reject(
            new Error(
              `fake DashScope: timed out after ${timeoutMs}ms waiting for ` +
                `${opts.description ?? 'a matching client message'} ` +
                `(inbox=${inbox.length}, recent types: ${recent})`,
            ),
          );
        }, timeoutMs);
        const onMessage = (message: JsonObject) => {
          if (!predicate(message)) return;
          cleanup();
          resolve(message);
        };
        emitter.on('message', onMessage);
      });
    },
    close: () => {
      for (const connection of connections) {
        try {
          connection.socket.terminate();
        } catch {
          /* already gone */
        }
      }
      wss.close();
      return new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
    },
  };

  wss.on('connection', (socket: WebSocket, req) => {
    const requestUrl = req.url ?? '';
    const query = new URL(requestUrl, 'http://127.0.0.1').searchParams;
    const authorization =
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined;

    const sendJson = (body: JsonObject) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ event_id: `evt-${++eventSeq}`, ...body }));
    };

    const beginResponse = (): string => {
      const responseId = `resp-${++responseSeq}`;
      sendJson({
        type: 'response.created',
        response: { id: responseId, status: 'in_progress' },
      });
      return responseId;
    };
    const finishResponse = (responseId: string, status = 'completed') => {
      sendJson({
        type: 'response.done',
        response: { id: responseId, status },
      });
    };

    const connection: FakeDashScopeConnection = {
      index: connections.length,
      socket,
      requestUrl,
      model: query.get('model') ?? undefined,
      authorization,
      send: sendJson,
      speakTranscript: (text) => {
        const itemId = `item-${++itemSeq}`;
        sendJson({
          type: 'input_audio_buffer.speech_started',
          item_id: itemId,
          audio_start_ms: 0,
        });
        sendJson({
          type: 'input_audio_buffer.speech_stopped',
          item_id: itemId,
          audio_end_ms: 400,
        });
        sendJson({ type: 'input_audio_buffer.committed', item_id: itemId });
        sendJson({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: itemId,
          transcript: text,
        });
        return itemId;
      },
      functionCall: (call) => {
        const responseId = beginResponse();
        sendJson({
          type: 'response.output_item.done',
          response_id: responseId,
          item: {
            id: `item-${call.callId}`,
            type: 'function_call',
            name: call.name,
            call_id: call.callId,
            arguments: call.argumentsJson,
          },
        });
        finishResponse(responseId);
        return responseId;
      },
      respondWithAudio: (pcm16) => {
        if (pcm16.byteLength === 0 || pcm16.byteLength % 2 !== 0) {
          throw new Error('respondWithAudio needs a non-empty PCM16 buffer');
        }
        const responseId = beginResponse();
        sendJson({
          type: 'response.audio.delta',
          response_id: responseId,
          item_id: `item-audio-${responseSeq}`,
          delta: Buffer.from(pcm16).toString('base64'),
        });
        sendJson({ type: 'response.audio.done', response_id: responseId });
        finishResponse(responseId);
        return responseId;
      },
      beginResponse,
      finishResponse,
    };
    connections.push(connection);

    socket.on('message', (data, isBinary) => {
      if (isBinary) return; // the realtime protocol is JSON-text only
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      inbox.push(parsed);
      if (parsed['type'] === 'session.update') {
        sendJson({ type: 'session.updated', session: { id: 'sess-1' } });
      } else if (
        parsed['type'] === 'response.create' &&
        handle.autoAckResponses
      ) {
        finishResponse(beginResponse());
      }
      emitter.emit('message', parsed);
    });

    // First provider event on a fresh connection; the client answers with
    // session.update.
    sendJson({ type: 'session.created' });
    emitter.emit('connection', connection);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  handle.port = address.port;
  handle.url = `http://127.0.0.1:${address.port}`;
  return handle;
}
