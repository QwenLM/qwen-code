/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openVoiceStream } from './voiceStreamSession.js';

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
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

function startSession(socket: FakeSocket) {
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
    JSON.stringify({ header: { event: 'task-started' } }),
    false,
  );
  return sessionPromise;
}

describe('voiceStreamSession', () => {
  afterEach(() => {
    vi.useRealTimers();
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
  });
});
