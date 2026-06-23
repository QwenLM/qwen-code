/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { afterEach, describe, it, expect, vi } from 'vitest';
import { createVoiceWsConnectionHandler } from './voice-ws.js';
import type { DaemonVoiceContext } from './resolve-voice-config.js';
import type { VoiceStreamSession } from '../../ui/voice/voice-stream-session.js';

/** Minimal stand-in for a `ws` WebSocket the handler attaches to. */
class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<string | 'binary'> = [];
  closeCode: number | undefined;
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : 'binary');
  }
  close(code?: number): void {
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close');
  }
  emit(event: string, ...args: unknown[]): void {
    (this.handlers[event] ?? []).forEach((cb) => cb(...args));
  }

  // ── test drivers ──
  text(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)), false);
  }
  binary(bytes: number[]): void {
    this.emit('message', Buffer.from(bytes), true);
  }
  binaryBuffer(buffer: Buffer): void {
    this.emit('message', buffer, true);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => s !== 'binary')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function streamingCtx(): DaemonVoiceContext {
  return {
    settings: {} as DaemonVoiceContext['settings'],
    models: { getAllConfiguredModels: () => [] },
    voiceModel: 'paraformer-realtime-v2',
    streaming: true,
  };
}

function batchCtx(): DaemonVoiceContext {
  return {
    settings: {} as DaemonVoiceContext['settings'],
    models: { getAllConfiguredModels: () => [] },
    voiceModel: 'qwen3-asr-flash',
    streaming: false,
  };
}

describe('createVoiceWsConnectionHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams audio to the upstream session and returns the final transcript', async () => {
    const pushed: Uint8Array[] = [];
    let onInterim: ((t: string) => void) | undefined;
    const session: VoiceStreamSession = {
      pushAudio: (pcm) => pushed.push(pcm),
      finish: vi.fn(async () => 'hello world'),
      abort: vi.fn(),
    };
    const openStream = vi.fn(async (_ctx, callbacks) => {
      onInterim = callbacks.onInterim;
      return session;
    });
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    expect(openStream).toHaveBeenCalledOnce();
    expect(ws.frames()[0]).toMatchObject({ type: 'ready', streaming: true });

    ws.binary([1, 2, 3, 4]);
    await tick();
    expect(pushed).toHaveLength(1);

    onInterim?.('hel');
    expect(
      ws.frames().some((f) => f['type'] === 'interim' && f['text'] === 'hel'),
    ).toBe(true);

    ws.text({ type: 'stop' });
    await tick();
    expect(session.finish).toHaveBeenCalledOnce();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'final',
      text: 'hello world',
    });
    expect(ws.closeCode).toBe(1000);
  });

  it('lazily starts on the first audio frame', async () => {
    const loadContext = vi.fn(() => streamingCtx());
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext,
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.binary([9, 9]);
    await tick();
    expect(loadContext).toHaveBeenCalledOnce();
    expect(session.pushAudio).toHaveBeenCalledOnce();
  });

  it('buffers audio and batch-transcribes non-streaming models on stop', async () => {
    const transcribe = vi.fn(
      async (_ctx, pcm: Uint8Array) => `batched:${pcm.byteLength}`,
    );
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => batchCtx(),
      transcribe,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.binary([1, 2, 3]);
    ws.binary([4, 5]);
    await tick();
    ws.text({ type: 'stop' });
    await tick();

    expect(transcribe).toHaveBeenCalledOnce();
    // The two 3- and 2-byte frames concatenate to 5 bytes.
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'final',
      text: 'batched:5',
    });
  });

  it('reports an error frame and aborts the session when start fails', async () => {
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => {
        throw new Error('No voice model is configured for this workspace.');
      },
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'No voice model is configured for this workspace.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('aborts the upstream session on abort', async () => {
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.text({ type: 'abort' });
    await tick();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(ws.closeCode).toBe(1000);
  });

  it('lets abort preempt a pending streaming start', async () => {
    const sessionReady = deferred<VoiceStreamSession>();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => sessionReady.promise,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.text({ type: 'abort' });
    await tick();
    sessionReady.resolve(session);
    await tick();

    expect(ws.closeCode).toBe(1000);
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it('aborts a streaming session that resolves after the socket closed', async () => {
    const sessionReady = deferred<VoiceStreamSession>();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => sessionReady.promise,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.close();
    sessionReady.resolve(session);
    await tick();

    expect(session.abort).toHaveBeenCalledOnce();
  });

  it('aborts the streaming session if finalization times out', async () => {
    vi.useFakeTimers();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(() => new Promise<string>(() => {})),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await vi.runAllTicks();
    ws.text({ type: 'stop' });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(session.abort).toHaveBeenCalledOnce();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Voice session exceeded the time limit.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('fails oversized batch audio before buffering it', async () => {
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => batchCtx(),
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.binaryBuffer(Buffer.alloc(10 * 1024 * 1024 + 1));
    await tick();

    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Recording is too long for transcription (max ~5 minutes).',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('rejects queued audio while streaming start is pending', async () => {
    const sessionReady = deferred<VoiceStreamSession>();
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => sessionReady.promise,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.binaryBuffer(Buffer.alloc(20 * 1024 * 1024 + 1));
    await tick();

    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Queued voice audio exceeded the memory limit.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('fails and cleans up when the hard timer fires', async () => {
    vi.useFakeTimers();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(session.abort).toHaveBeenCalledOnce();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Voice session exceeded the time limit.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('rejects connections past the concurrency cap and frees slots on close', async () => {
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => ({
        pushAudio: vi.fn(),
        finish: vi.fn(async () => ''),
        abort: vi.fn(),
      }),
    });
    // Open the cap (8) and hold them; the 9th must be refused with 1013.
    const open = Array.from({ length: 8 }, () => new FakeWs());
    for (const ws of open) handler(ws as never, {} as never);
    const overflow = new FakeWs();
    handler(overflow as never, {} as never);
    expect(overflow.closeCode).toBe(1013);
    expect(overflow.frames().at(-1)).toMatchObject({ type: 'error' });

    // Closing one frees a slot for a new connection.
    open[0].close();
    const next = new FakeWs();
    handler(next as never, {} as never);
    expect(next.closeCode).not.toBe(1013);
  });
});
