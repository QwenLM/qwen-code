/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveStreamUrl, openVoiceStream } from './voiceStreamSession.js';

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  private readonly handlers = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(cb);
    this.handlers.set(event, handlers);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

function startSession(
  socket: FakeSocket,
  callbacks: Parameters<typeof openVoiceStream>[1] = {},
) {
  const sessionPromise = openVoiceStream(
    {
      baseUrl: 'https://dashscope.example/v1',
      model: 'paraformer-realtime-v2',
    },
    callbacks,
    { createWebSocket: () => socket },
  );
  socket.emit('open');
  socket.emit(
    'message',
    JSON.stringify({ header: { event: 'task-started' } }),
    false,
  );
  return sessionPromise;
}

describe('voiceStreamSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives websocket URLs from https/http base URLs with path prefixes', () => {
    expect(
      deriveStreamUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    ).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference');
    expect(deriveStreamUrl('http://localhost:8080/dashscope/v1')).toBe(
      'ws://localhost:8080/dashscope/api-ws/v1/inference',
    );
  });

  it('rejects finish when the task stream closes unexpectedly', async () => {
    const socket = new FakeSocket();
    const session = await startSession(socket);

    const transcriptPromise = session.finish();
    socket.emit('close');

    await expect(transcriptPromise).rejects.toThrow(
      'Voice stream connection closed unexpectedly.',
    );
  });

  it('notifies immediately when the task stream closes while recording', async () => {
    const socket = new FakeSocket();
    const onError = vi.fn();
    await startSession(socket, { onError });

    socket.emit('close');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Voice stream connection closed unexpectedly. Transcript may be incomplete.',
      }),
    );
  });

  it('rejects committed transcript when the stream closes before task-finished', async () => {
    const socket = new FakeSocket();
    const session = await startSession(socket);

    socket.emit(
      'message',
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: {
          output: { sentence: { text: 'hello world', sentence_end: true } },
        },
      }),
      false,
    );

    const transcriptPromise = session.finish();
    socket.emit('close');

    await expect(transcriptPromise).rejects.toThrow(
      'Voice stream connection closed unexpectedly.',
    );
  });

  it('rejects when task-finished arrives before task-started', async () => {
    const socket = new FakeSocket();
    const sessionPromise = openVoiceStream(
      {
        baseUrl: 'https://dashscope.example/v1',
        model: 'paraformer-realtime-v2',
      },
      {},
      { createWebSocket: () => socket },
    );
    socket.emit('open');
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-finished' } }),
      false,
    );

    await expect(sessionPromise).rejects.toThrow(
      'Voice stream finished before it started.',
    );
  });

  it('resolves finish when task-finished arrives before finish is called', async () => {
    const socket = new FakeSocket();
    const session = await startSession(socket);

    socket.emit(
      'message',
      JSON.stringify({
        header: { event: 'result-generated' },
        payload: {
          output: { sentence: { text: 'hello world', sentence_end: true } },
        },
      }),
      false,
    );
    socket.emit(
      'message',
      JSON.stringify({ header: { event: 'task-finished' } }),
      false,
    );

    await expect(session.finish()).resolves.toBe('hello world');
  });

  it('drops audio chunks when the socket buffer is backed up', async () => {
    const socket = new FakeSocket();
    const session = await startSession(socket);
    socket.sent.length = 0;

    socket.bufferedAmount = 1024 * 1024 + 1;
    session.pushAudio(new Uint8Array([1, 2, 3]));
    session.pushAudio(new Uint8Array([4, 5, 6]));

    expect(socket.sent).toEqual([]);

    socket.bufferedAmount = 0;
    session.pushAudio(new Uint8Array([7]));
    expect(socket.sent).toEqual([new Uint8Array([7])]);
  });

  it('rejects finish when the task never finishes', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const session = await startSession(socket);

    const transcriptPromise = session.finish();
    void transcriptPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(transcriptPromise).rejects.toThrow(
      'Voice stream finish timed out.',
    );
    expect(socket.readyState).toBe(3);
  });

  it('rejects finish when the server sends task-failed', async () => {
    const socket = new FakeSocket();
    const session = await startSession(socket);

    const transcriptPromise = session.finish();
    socket.emit(
      'message',
      JSON.stringify({
        header: {
          event: 'task-failed',
          error_code: '429',
          error_message: 'rate limited',
        },
      }),
      false,
    );

    await expect(transcriptPromise).rejects.toThrow('rate limited');
    await expect(transcriptPromise).rejects.toThrow(
      'wss://dashscope.example/api-ws/v1/inference',
    );
  });

  it('sanitizes and caps task-failed server messages', async () => {
    const socket = new FakeSocket();
    const session = await startSession(socket);

    const transcriptPromise = session.finish();
    const longMessage = `bad\x1b[8mhidden\x1b[0m ${'x'.repeat(300)}`;
    socket.emit(
      'message',
      JSON.stringify({
        header: {
          event: 'task-failed',
          error_code: '500',
          error_message: longMessage,
        },
      }),
      false,
    );

    await expect(transcriptPromise).rejects.toThrow(
      'bad\\u001b[8mhidden\\u001b[0m',
    );
    await expect(transcriptPromise).rejects.not.toThrow('x'.repeat(220));
  });
});
