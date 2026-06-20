/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveQwenRealtimeUrl,
  openQwenAsrRealtimeStream,
} from './qwenAsrRealtimeSession.js';

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

function parseSent(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(String(socket.sent[index]));
}

describe('qwenAsrRealtimeSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the Qwen realtime endpoint from the provider host', () => {
    expect(
      deriveQwenRealtimeUrl(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen3-asr-flash-realtime',
      ),
    ).toBe(
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
    );
  });

  it('streams PCM chunks as base64 events and resolves the completed transcript', async () => {
    const socket = new FakeSocket();
    const createWebSocket = vi.fn(() => socket);
    const interim = vi.fn();
    const sessionPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.example/v1',
        apiKey: 'sk-test',
        model: 'qwen3-asr-flash-realtime',
        language: 'zh',
        keytermsContext: 'grep regex OAuth',
      },
      { onInterim: interim },
      { createWebSocket },
    );

    expect(createWebSocket).toHaveBeenCalledWith(
      'wss://dashscope.example/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
      { headers: { Authorization: 'Bearer sk-test' } },
    );

    socket.emit(
      'message',
      JSON.stringify({ type: 'session.created', event_id: 'created' }),
      false,
    );
    expect(parseSent(socket, 0)).toMatchObject({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        input_audio_transcription: {
          language: 'zh',
          corpus_text: 'grep regex OAuth',
        },
        turn_detection: null,
      },
    });

    socket.emit(
      'message',
      JSON.stringify({ type: 'session.updated', event_id: 'updated' }),
      false,
    );
    const session = await sessionPromise;

    session.pushAudio(new Uint8Array([1, 2, 3]));
    expect(parseSent(socket, 1)).toMatchObject({
      type: 'input_audio_buffer.append',
      audio: 'AQID',
    });

    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.text',
        text: 'hello',
        stash: ' world',
      }),
      false,
    );
    expect(interim).toHaveBeenCalledWith('hello world');

    const transcriptPromise = session.finish();
    expect(parseSent(socket, 2)).toMatchObject({
      type: 'input_audio_buffer.commit',
    });
    expect(parseSent(socket, 3)).toMatchObject({
      type: 'session.finish',
    });

    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello world',
      }),
      false,
    );
    socket.emit(
      'message',
      JSON.stringify({ type: 'session.finished', event_id: 'finished' }),
      false,
    );

    await expect(transcriptPromise).resolves.toBe('hello world');
  });

  it('rejects finish when the server never sends session.finished', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const sessionPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.example/v1',
        model: 'qwen3-asr-flash-realtime',
      },
      {},
      { createWebSocket: () => socket },
    );
    socket.emit(
      'message',
      JSON.stringify({ type: 'session.updated', event_id: 'updated' }),
      false,
    );
    const session = await sessionPromise;

    const transcriptPromise = session.finish();
    const expectation = await expect(transcriptPromise).rejects.toThrow(
      'Qwen ASR realtime finish timed out.',
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await expectation;
    expect(socket.readyState).toBe(3);
  });

  it('preserves transcription failures that arrive before finish', async () => {
    const socket = new FakeSocket();
    const sessionPromise = openQwenAsrRealtimeStream(
      {
        baseUrl: 'https://dashscope.example/v1',
        model: 'qwen3-asr-flash-realtime',
      },
      {},
      { createWebSocket: () => socket },
    );
    socket.emit(
      'message',
      JSON.stringify({ type: 'session.updated', event_id: 'updated' }),
      false,
    );
    const session = await sessionPromise;

    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.failed',
        error: { message: 'server failed' },
      }),
      false,
    );

    await expect(session.finish()).rejects.toThrow('server failed');
  });
});
