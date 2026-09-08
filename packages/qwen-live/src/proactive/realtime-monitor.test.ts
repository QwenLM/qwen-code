/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { QWEN_REALTIME_LIMITS } from '../realtime/realtime-session.js';
import {
  DashScopeRealtimeMonitor,
  type DashScopeRealtimeMonitorCallbacks,
  type DashScopeRealtimeMonitorDeps,
  type DashScopeRealtimeMonitorOptions,
} from './realtime-monitor.js';

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  readonly failingTypes = new Set<string>();
  closeCalls = 0;
  private readonly handlers = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(data: string | Uint8Array): void {
    const body = JSON.parse(String(data)) as Record<string, unknown>;
    if (this.failingTypes.has(String(body['type']))) {
      throw new Error(`send failed for ${String(body['type'])}`);
    }
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(cb);
    this.handlers.set(event, handlers);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  message(body: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(body), false);
  }
}

const DEFAULT_OPTIONS: DashScopeRealtimeMonitorOptions = {
  endpoint: 'https://dashscope.example/compatible-mode/v1',
  apiKey: 'sk-test',
  model: 'qwen3.5-omni-plus-realtime',
  taskId: 'task-1',
  taskGeneration: 7,
  instruction: 'Tell me when the kettle boils.',
  monitorMode: 'event',
  modalities: ['audio', 'vision'],
  contextWindowSec: { audio: 60, vision: 60 },
  sessionRecycleEvals: 100,
};

const API_KEY_SENTINEL = 'sk-monitor-api-key-sentinel';
const PROVIDER_SECRET_SENTINEL = 'provider-private-sentinel';

function sentBodies(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map(
    (entry) => JSON.parse(String(entry)) as Record<string, unknown>,
  );
}

function sentTypes(socket: FakeSocket): string[] {
  return sentBodies(socket).map((body) => String(body['type']));
}

function jpeg(marker: number): string {
  return Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]).toString('base64');
}

function createHarness(
  optionOverrides: Partial<DashScopeRealtimeMonitorOptions> = {},
  depOverrides: Omit<DashScopeRealtimeMonitorDeps, 'createWebSocket'> = {},
) {
  const sockets: FakeSocket[] = [];
  const callbacks = {
    onReady: vi.fn(),
    onResult: vi.fn(),
    onLifecycleError: vi.fn(),
    onDebug: vi.fn(),
  } satisfies DashScopeRealtimeMonitorCallbacks;
  const monitor = new DashScopeRealtimeMonitor(
    { ...DEFAULT_OPTIONS, ...optionOverrides },
    callbacks,
    {
      ...depOverrides,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  return { callbacks, monitor, sockets };
}

async function startMonitor(
  monitor: DashScopeRealtimeMonitor,
  sockets: FakeSocket[],
): Promise<FakeSocket> {
  const opening = monitor.start();
  const socket = sockets.at(-1);
  if (!socket) throw new Error('Expected the monitor to create a socket.');
  socket.message({ type: 'session.created' });
  socket.message({ type: 'session.updated' });
  await opening;
  return socket;
}

function completeEvaluation(socket: FakeSocket, responseId: string): void {
  socket.message({ type: 'input_audio_buffer.committed' });
  socket.message({
    type: 'response.created',
    response: { id: responseId },
  });
  socket.message({
    type: 'response.text.done',
    response_id: responseId,
    text: 'Reply: The kettle is boiling.',
  });
  socket.message({
    type: 'response.done',
    response: { id: responseId },
  });
}

describe('DashScopeRealtimeMonitor', () => {
  it.each(['failed', 'cancelled', 'incomplete'])(
    'rejects a matching %s terminal instead of triggering from its partial reply and recovers on a new transport',
    async (status) => {
      const { callbacks, monitor, sockets } = createHarness();
      const first = await startMonitor(monitor, sockets);
      monitor.feedAudio(Uint8Array.from([1, 0]));
      expect(monitor.requestEvaluation()).toBe(true);
      first.message({ type: 'input_audio_buffer.committed' });
      first.message({
        type: 'response.created',
        response: { id: 'failed-response' },
      });
      first.message({
        type: 'response.text.delta',
        response_id: 'failed-response',
        delta: 'Reply: The kettle is boiling.',
      });
      const terminal = {
        type: 'response.done',
        response: {
          id: 'failed-response',
          status,
          status_details: {
            error: {
              code: 'server_error',
              type: 'server_error',
              message: PROVIDER_SECRET_SENTINEL,
            },
          },
        },
      };
      first.message(terminal);
      first.message(terminal);
      expect(callbacks.onResult).toHaveBeenCalledOnce();
      expect(callbacks.onResult).toHaveBeenLastCalledWith(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: expect.any(String),
        },
        DEFAULT_OPTIONS.taskGeneration,
      );
      expect(JSON.stringify(callbacks.onResult.mock.calls)).not.toContain(
        PROVIDER_SECRET_SENTINEL,
      );
      expect(JSON.stringify(callbacks.onDebug.mock.calls)).not.toContain(
        PROVIDER_SECRET_SENTINEL,
      );
      expect(monitor.requestEvaluation()).toBe(false);
      const second = sockets[1]!;
      second.message({ type: 'session.created' });
      second.message({ type: 'session.updated' });
      await vi.waitFor(() =>
        expect(callbacks.onReady).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(() => expect(monitor.requestEvaluation()).toBe(true));
      first.message(terminal);
      second.message({ type: 'input_audio_buffer.committed' });
      second.message({
        type: 'response.created',
        response: { id: 'recovered-response' },
      });
      second.message({
        ...terminal,
        response: { ...terminal.response, id: 'stale-response' },
      });
      expect(callbacks.onResult).toHaveBeenCalledOnce();
      second.message({
        type: 'response.text.done',
        response_id: 'recovered-response',
        text: 'Reply: A new confirmed observation.',
      });
      second.message({
        type: 'response.done',
        response: { id: 'recovered-response', status: 'completed' },
      });
      expect(callbacks.onResult).toHaveBeenCalledTimes(2);
      expect(callbacks.onResult).toHaveBeenLastCalledWith(
        {
          triggered: true,
          summary: 'A new confirmed observation.',
          currentState: '',
        },
        DEFAULT_OPTIONS.taskGeneration,
      );
      monitor.close();
    },
  );

  it.each([undefined, 'completed'])(
    'accepts a completed action with the compatible terminal status %s',
    async (status) => {
      const { callbacks, monitor, sockets } = createHarness();
      const socket = await startMonitor(monitor, sockets);
      expect(monitor.requestEvaluation()).toBe(true);
      socket.message({ type: 'input_audio_buffer.committed' });
      socket.message({
        type: 'response.created',
        response: { id: 'ok-response' },
      });
      socket.message({
        type: 'response.text.done',
        response_id: 'ok-response',
        text: 'Reply: The kettle is boiling.',
      });
      socket.message({
        type: 'response.done',
        response: { id: 'ok-response', ...(status ? { status } : {}) },
      });
      expect(callbacks.onResult).toHaveBeenLastCalledWith(
        {
          triggered: true,
          summary: 'The kettle is boiling.',
          currentState: '',
        },
        DEFAULT_OPTIONS.taskGeneration,
      );
      monitor.close();
    },
  );

  it('configures a text-only session without a voice', async () => {
    const { monitor, sockets } = createHarness();
    const socket = await startMonitor(monitor, sockets);
    const update = sentBodies(socket).find(
      (body) => body['type'] === 'session.update',
    );

    expect(update).toBeDefined();
    expect(update?.['session']).toMatchObject({ modalities: ['text'] });
    expect(update?.['session']).not.toHaveProperty('voice');
    monitor.close();
  });

  it('ignores a second response.created with a different response id', async () => {
    const { callbacks, monitor, sockets } = createHarness();
    const socket = await startMonitor(monitor, sockets);
    expect(monitor.requestEvaluation()).toBe(true);

    socket.message({ type: 'input_audio_buffer.committed' });
    socket.message({
      type: 'response.created',
      response: { id: 'response-1' },
    });
    socket.message({
      type: 'response.created',
      response: { id: 'response-2' },
    });
    socket.message({
      type: 'response.text.done',
      response_id: 'response-1',
      text: 'Reply: The kettle is boiling.',
    });
    socket.message({
      type: 'response.done',
      response: { id: 'response-1' },
    });

    expect(callbacks.onResult).toHaveBeenCalledTimes(1);
    expect(callbacks.onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        triggered: true,
        summary: 'The kettle is boiling.',
      }),
      DEFAULT_OPTIONS.taskGeneration,
    );
    expect(callbacks.onLifecycleError).not.toHaveBeenCalled();
    monitor.close();
  });

  it('keeps backpressured media ahead of fresh silence and commit', async () => {
    const { monitor, sockets } = createHarness();
    const socket = await startMonitor(monitor, sockets);
    socket.sent.length = 0;
    socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;

    const audio = Uint8Array.from([1, 0, 2, 0]);
    const image = jpeg(1);
    expect(monitor.feedAudio(audio)).toBe(true);
    expect(monitor.feedImage(image)).toBe(true);
    expect(socket.sent).toHaveLength(0);
    expect(monitor.requestEvaluation()).toBe(false);
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    expect(monitor.requestEvaluation()).toBe(true);
    expect(sentTypes(socket)).toEqual([
      'input_audio_buffer.append',
      'input_image_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    const bodies = sentBodies(socket);
    expect(bodies[0]?.['audio']).toBe(Buffer.from(audio).toString('base64'));
    expect(bodies[1]?.['image']).toBe(image);
    expect(bodies[2]?.['audio']).not.toBe(bodies[0]?.['audio']);
    monitor.close();
  });

  it('keeps the recent-input cap independent from the writable queue', async () => {
    const { callbacks, monitor, sockets } = createHarness(
      {},
      { maxQueuedInputs: 2 },
    );
    const socket = await startMonitor(monitor, sockets);
    socket.sent.length = 0;

    expect(monitor.feedAudio(Uint8Array.from([1, 0]))).toBe(true);
    expect(monitor.feedAudio(Uint8Array.from([2, 0]))).toBe(true);
    expect(monitor.feedImage(jpeg(3))).toBe(true);

    expect(sentTypes(socket)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_image_buffer.append',
    ]);
    expect(callbacks.onDebug).not.toHaveBeenCalledWith(
      'proactive.monitor_input_dropped',
      expect.anything(),
    );
    monitor.close();
  });

  it('bounds the media queue and reports an intentional drop', async () => {
    const { callbacks, monitor, sockets } = createHarness(
      {},
      {
        maxQueuedInputs: 2,
      },
    );
    const socket = await startMonitor(monitor, sockets);
    socket.sent.length = 0;
    socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;

    expect(monitor.feedImage(jpeg(1))).toBe(true);
    expect(monitor.feedImage(jpeg(2))).toBe(true);
    expect(monitor.feedImage(jpeg(3))).toBe(true);
    expect(callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_input_dropped',
      expect.objectContaining({
        modality: 'vision',
        reason: 'writer_queue_full',
      }),
    );

    socket.bufferedAmount = 0;
    expect(monitor.requestEvaluation()).toBe(true);
    const forwardedImages = sentBodies(socket)
      .filter((body) => body['type'] === 'input_image_buffer.append')
      .map((body) => body['image']);
    expect(forwardedImages).toEqual([jpeg(2), jpeg(3)]);
    monitor.close();
  });

  it('redacts provider secrets from evaluation errors and debug metadata', async () => {
    const { callbacks, monitor, sockets } = createHarness({
      apiKey: API_KEY_SENTINEL,
    });
    const socket = await startMonitor(monitor, sockets);
    expect(monitor.requestEvaluation()).toBe(true);

    socket.message({
      type: 'error',
      error: {
        code: 'rate_limit_exceeded',
        status: 429,
        type: 'rate_limit_error',
        param: 'input_audio_buffer',
        message: `${API_KEY_SENTINEL} ${PROVIDER_SECRET_SENTINEL}`,
      },
    });
    socket.emit('close');

    expect(callbacks.onResult).toHaveBeenCalledTimes(1);
    expect(callbacks.onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        triggered: false,
        error: 'DashScope monitor provider request failed.',
      }),
      DEFAULT_OPTIONS.taskGeneration,
    );
    expect(callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_result',
      expect.objectContaining({
        error: true,
        kind: 'transient',
        code: 'rate_limit_exceeded',
        status: 429,
        providerType: 'rate_limit_error',
        param: 'input_audio_buffer',
      }),
    );
    expect(JSON.stringify(callbacks.onDebug.mock.calls)).not.toContain(
      API_KEY_SENTINEL,
    );
    expect(JSON.stringify(callbacks.onDebug.mock.calls)).not.toContain(
      PROVIDER_SECRET_SENTINEL,
    );
    expect(JSON.stringify(callbacks.onResult.mock.calls)).not.toContain(
      API_KEY_SENTINEL,
    );
    expect(JSON.stringify(callbacks.onResult.mock.calls)).not.toContain(
      PROVIDER_SECRET_SENTINEL,
    );
    expect(callbacks.onLifecycleError).not.toHaveBeenCalled();
    monitor.close();
  });

  it('redacts provider secrets from lifecycle errors while retaining metadata', async () => {
    const { callbacks, monitor, sockets } = createHarness({
      apiKey: API_KEY_SENTINEL,
    });
    const socket = await startMonitor(monitor, sockets);

    socket.message({
      type: 'error',
      error: {
        code: 'rate_limit_exceeded',
        status: '429',
        type: 'rate_limit_error',
        param: 'input_audio_buffer',
        message: `${PROVIDER_SECRET_SENTINEL} ${API_KEY_SENTINEL}`,
      },
    });
    socket.emit('close');

    expect(callbacks.onLifecycleError).toHaveBeenCalledTimes(1);
    expect(callbacks.onLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'DashScope monitor provider request failed.',
        code: 'rate_limit_exceeded',
        kind: 'transient',
        status: 429,
        providerType: 'rate_limit_error',
        param: 'input_audio_buffer',
      }),
      DEFAULT_OPTIONS.taskGeneration,
    );
    const lifecycleError = callbacks.onLifecycleError.mock.calls[0]?.[0];
    expect(lifecycleError?.message).not.toContain(API_KEY_SENTINEL);
    expect(lifecycleError?.message).not.toContain(PROVIDER_SECRET_SENTINEL);
    expect(JSON.stringify(lifecycleError)).not.toContain(API_KEY_SENTINEL);
    expect(JSON.stringify(lifecycleError)).not.toContain(
      PROVIDER_SECRET_SENTINEL,
    );
    expect(callbacks.onResult).not.toHaveBeenCalled();
    monitor.close();
  });

  it('does not expose raw WebSocket error text through lifecycle callbacks', async () => {
    const { callbacks, monitor, sockets } = createHarness({
      apiKey: API_KEY_SENTINEL,
    });
    const socket = await startMonitor(monitor, sockets);

    socket.emit(
      'error',
      new Error(`${API_KEY_SENTINEL} ${PROVIDER_SECRET_SENTINEL}`),
    );

    expect(callbacks.onLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Monitor WebSocket failed.',
        code: 'monitor_socket_error',
        kind: 'transient',
      }),
      DEFAULT_OPTIONS.taskGeneration,
    );
    const lifecycleError = callbacks.onLifecycleError.mock.calls[0]?.[0];
    expect(lifecycleError?.message).not.toContain(API_KEY_SENTINEL);
    expect(lifecycleError?.message).not.toContain(PROVIDER_SECRET_SENTINEL);
    monitor.close();
  });

  it('rejects a pending connection immediately when closed', async () => {
    const { monitor } = createHarness({}, { connectTimeoutMs: 60_000 });
    const opening = monitor.start();

    monitor.close();

    await expect(opening).rejects.toThrow('closed while connecting');
  });

  it('clears pending capture while preserving the resident conversation', async () => {
    const { callbacks, monitor, sockets } = createHarness();
    const socket = await startMonitor(monitor, sockets);
    expect(monitor.feedAudio(Uint8Array.from([7, 0]))).toBe(true);
    expect(monitor.requestEvaluation()).toBe(true);
    completeEvaluation(socket, 'response-before-reset');
    expect(callbacks.onResult).toHaveBeenCalledOnce();

    monitor.resetPendingCapture();
    expect(sentTypes(socket).at(-1)).toBe('input_audio_buffer.clear');

    socket.sent.length = 0;
    expect(monitor.feedAudio(Uint8Array.from([8, 0]))).toBe(true);
    expect(monitor.requestEvaluation()).toBe(true);

    expect(sockets).toHaveLength(1);
    expect(socket.closeCalls).toBe(0);
    expect(sentTypes(socket)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    monitor.close();
  });

  it('clears replay state and recycles after a clear send failure', async () => {
    const { callbacks, monitor, sockets } = createHarness();
    const first = await startMonitor(monitor, sockets);
    first.sent.length = 0;
    expect(monitor.feedAudio(Uint8Array.from([9, 0]))).toBe(true);
    first.failingTypes.add('input_audio_buffer.clear');

    monitor.resetPendingCapture();
    first.emit('error', new Error('late first-generation error'));
    first.emit('close');
    expect(callbacks.onLifecycleError).toHaveBeenCalledTimes(1);

    expect(monitor.requestEvaluation()).toBe(false);
    const second = sockets[1];
    if (!second) throw new Error('Expected the monitor to recycle its socket.');
    second.message({ type: 'session.created' });
    second.message({ type: 'session.updated' });
    await vi.waitFor(() => {
      expect(callbacks.onReady).toHaveBeenCalledTimes(2);
    });

    expect(sentTypes(second)).toEqual([
      'session.update',
      'conversation.item.create',
      'input_audio_buffer.append',
    ]);
    expect(callbacks.onLifecycleError).toHaveBeenCalledTimes(1);
    monitor.close();
  });

  it('recycles at the evaluation limit and fences late old-socket events', async () => {
    const { callbacks, monitor, sockets } = createHarness({
      sessionRecycleEvals: 1,
    });
    const first = await startMonitor(monitor, sockets);
    const audio = Uint8Array.from([7, 0, 8, 0]);
    expect(monitor.feedAudio(audio)).toBe(true);
    expect(monitor.requestEvaluation()).toBe(true);
    completeEvaluation(first, 'response-1');
    expect(callbacks.onResult).toHaveBeenCalledTimes(1);

    expect(monitor.requestEvaluation()).toBe(false);
    const second = sockets[1];
    if (!second) throw new Error('Expected the monitor to recycle its socket.');
    first.message({
      type: 'error',
      error: { message: 'late provider failure' },
    });
    first.emit('error', new Error('late socket failure'));
    first.emit('close');
    first.message({ type: 'session.updated' });

    second.message({ type: 'session.created' });
    second.message({ type: 'session.updated' });
    await vi.waitFor(() => {
      expect(callbacks.onReady).toHaveBeenCalledTimes(2);
    });

    expect(callbacks.onLifecycleError).not.toHaveBeenCalled();
    expect(callbacks.onResult).toHaveBeenCalledTimes(1);
    const replay = sentBodies(second).filter(
      (body) => body['type'] === 'input_audio_buffer.append',
    );
    expect(replay).toHaveLength(2);
    expect(replay[1]?.['audio']).toBe(Buffer.from(audio).toString('base64'));
    monitor.close();
  });

  it.each([
    { audio: 60, vision: 10, retained: 'audio' },
    { audio: 10, vision: 60, retained: 'vision' },
  ])(
    'replays the independent media windows after reconnect: $retained retained',
    async ({ audio, vision, retained }) => {
      let now = 100_000;
      const { monitor, sockets, callbacks } = createHarness(
        {
          contextWindowSec: { audio, vision },
          sessionRecycleEvals: 1,
        },
        { now: () => now },
      );
      const first = await startMonitor(monitor, sockets);
      const oldAudio = Uint8Array.from([7, 0, 8, 0]);
      const freshAudio = Uint8Array.from([9, 0, 10, 0]);
      monitor.feedAudio(oldAudio);
      monitor.feedImage(jpeg(1));
      now += 20_000;
      monitor.feedAudio(freshAudio);
      monitor.feedImage(jpeg(2));
      expect(monitor.requestEvaluation()).toBe(true);
      completeEvaluation(first, 'response-1');
      expect(monitor.requestEvaluation()).toBe(false);

      const second = sockets[1]!;
      second.message({ type: 'session.created' });
      second.message({ type: 'session.updated' });
      await vi.waitFor(() => {
        expect(callbacks.onReady).toHaveBeenCalledTimes(2);
      });
      const images = sentBodies(second)
        .filter((body) => body['type'] === 'input_image_buffer.append')
        .map((body) => body['image']);
      const audioPayloads = sentBodies(second)
        .filter((body) => body['type'] === 'input_audio_buffer.append')
        .map((body) => body['audio']);
      expect(images).toEqual(
        retained === 'vision' ? [jpeg(1), jpeg(2)] : [jpeg(2)],
      );
      expect(audioPayloads).toContain(
        Buffer.from(freshAudio).toString('base64'),
      );
      expect(
        audioPayloads.includes(Buffer.from(oldAudio).toString('base64')),
      ).toBe(retained === 'audio');
      monitor.close();
    },
  );

  it.each([
    { audio: 60, vision: 10, retained: 'audio' },
    { audio: 10, vision: 60, retained: 'vision' },
  ])(
    'expires a backpressured writer queue by modality: $retained retained',
    async ({ audio, vision, retained }) => {
      let now = 100_000;
      const { monitor, sockets } = createHarness(
        {
          contextWindowSec: { audio, vision },
        },
        { now: () => now },
      );
      const socket = await startMonitor(monitor, sockets);
      socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;
      const oldAudio = Uint8Array.from([7, 0, 8, 0]);
      const freshAudio = Uint8Array.from([9, 0, 10, 0]);
      monitor.feedAudio(oldAudio);
      monitor.feedImage(jpeg(1));
      now += 20_000;
      monitor.feedAudio(freshAudio);
      monitor.feedImage(jpeg(2));
      socket.bufferedAmount = 0;
      expect(monitor.requestEvaluation()).toBe(true);

      const images = sentBodies(socket)
        .filter((body) => body['type'] === 'input_image_buffer.append')
        .map((body) => body['image']);
      const audioPayloads = sentBodies(socket)
        .filter((body) => body['type'] === 'input_audio_buffer.append')
        .map((body) => body['audio']);
      expect(images).toEqual(
        retained === 'vision' ? [jpeg(1), jpeg(2)] : [jpeg(2)],
      );
      expect(audioPayloads).toContain(
        Buffer.from(freshAudio).toString('base64'),
      );
      expect(
        audioPayloads.includes(Buffer.from(oldAudio).toString('base64')),
      ).toBe(retained === 'audio');
      expect(sentTypes(socket).at(-1)).toBe('input_audio_buffer.commit');
      monitor.close();
    },
  );
});
