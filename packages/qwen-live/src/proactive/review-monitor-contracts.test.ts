/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QWEN_REALTIME_LIMITS } from '../realtime/realtime-session.js';
import { PROACTIVE_MONITOR_SYSTEM_PROMPT } from './monitor-protocol.js';
import { DashScopeRealtimeMonitor } from './realtime-monitor.js';

class ReviewSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  on(event: string, callback: (...args: unknown[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
  }

  message(body: Record<string, unknown>): void {
    for (const callback of this.handlers.get('message') ?? []) {
      callback(JSON.stringify(body), false);
    }
  }
}

const active: DashScopeRealtimeMonitor[] = [];

afterEach(() => {
  for (const monitor of active.splice(0)) monitor.close();
});

async function harness(sessionRecycleEvals = 60) {
  const sockets: ReviewSocket[] = [];
  const callbacks = {
    onReady: vi.fn(),
    onResult: vi.fn(),
    onLifecycleError: vi.fn(),
    onDebug: vi.fn(),
  };
  const monitor = new DashScopeRealtimeMonitor(
    {
      endpoint: 'https://review.example.test',
      apiKey: 'synthetic-test-key',
      model: 'qwen3.5-omni-plus-realtime',
      taskId: 'review-task',
      taskGeneration: 1,
      instruction: 'Report a visible change.',
      monitorMode: 'event',
      modalities: ['audio', 'vision'],
      contextWindowSec: { audio: 60, vision: 60 },
      sessionRecycleEvals,
    },
    callbacks,
    {
      createWebSocket: () => {
        const socket = new ReviewSocket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  active.push(monitor);
  const pending = monitor.start();
  const socket = sockets[0]!;
  ready(socket);
  await pending;
  return { monitor, sockets, callbacks };
}

function ready(socket: ReviewSocket): void {
  socket.message({ type: 'session.created' });
  socket.message({ type: 'session.updated' });
}

function complete(socket: ReviewSocket, id: string, text = 'wait'): void {
  socket.message({ type: 'input_audio_buffer.committed' });
  socket.message({ type: 'response.created', response: { id } });
  socket.message({ type: 'response.text.done', response_id: id, text });
  socket.message({ type: 'response.done', response: { id } });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('PR #11369 monitor review reproduction', () => {
  it('R1-11: recovers when the recycled transport errors after its ready microtasks', async () => {
    const { monitor, sockets, callbacks } = await harness(1);
    expect(monitor.requestEvaluation()).toBe(true);
    complete(sockets[0]!, 'first');
    expect(monitor.requestEvaluation()).toBe(false);
    ready(sockets[1]!);
    await nextTurn();
    sockets[1]!.message({ type: 'error', error: { code: 'server_error' } });
    expect(callbacks.onLifecycleError).toHaveBeenCalledOnce();
    expect(monitor.requestEvaluation()).toBe(false);
    expect(sockets).toHaveLength(3);
    ready(sockets[2]!);
    await nextTurn();
    expect(monitor.requestEvaluation()).toBe(true);
  });

  it('R1-11: recovers when ready and error arrive synchronously during recycling', async () => {
    const { monitor, sockets, callbacks } = await harness(1);
    expect(monitor.requestEvaluation()).toBe(true);
    complete(sockets[0]!, 'first');
    expect(monitor.requestEvaluation()).toBe(false);
    const second = sockets[1]!;
    ready(second);
    second.message({ type: 'error', error: { code: 'server_error' } });
    await nextTurn();
    const requests = Array.from({ length: 8 }, () =>
      monitor.requestEvaluation(),
    );
    expect(callbacks.onLifecycleError).toHaveBeenCalledOnce();
    expect(callbacks.onResult).toHaveBeenCalledOnce();
    expect(requests).toEqual(Array(8).fill(false));
    expect(second.readyState).toBe(3);
    expect(sockets).toHaveLength(3);
    ready(sockets[2]!);
    await nextTurn();
    expect(monitor.requestEvaluation()).toBe(true);
  });

  it('R1-26: preserves the prototype Func_call action without granting tool authority', async () => {
    const { monitor, sockets, callbacks } = await harness();
    const socket = sockets[0]!;
    expect(PROACTIVE_MONITOR_SYSTEM_PROMPT).toHaveLength(3496);
    expect(
      createHash('sha256')
        .update(PROACTIVE_MONITOR_SYSTEM_PROMPT)
        .digest('hex'),
    ).toBe('f54e454d494047f8b43651e58a9d36edb62267f5ba6f7bcfed7cc292c2f9e6f4');
    expect(
      socket.sent.find((entry) => entry['type'] === 'session.update'),
    ).toMatchObject({
      session: {
        tools: [],
        tool_choice: 'none',
        instructions: PROACTIVE_MONITOR_SYSTEM_PROMPT,
      },
    });
    const results: unknown[] = [];
    const debugResults: unknown[] = [];
    for (const [index, action] of [
      'wait',
      'Func_call:已记下\n{"name":"mind-map-generate_mindmap","intent":"private-intent-marker"}',
    ].entries()) {
      expect(monitor.requestEvaluation()).toBe(true);
      complete(socket, `action-${index}`, action);
      results.push(callbacks.onResult.mock.lastCall?.[0]);
      debugResults.push(
        callbacks.onDebug.mock.calls
          .filter(([event]) => event === 'proactive.monitor_result')
          .at(-1)?.[1],
      );
    }
    expect(results).toEqual([
      { triggered: false, summary: '', currentState: '' },
      {
        triggered: false,
        summary: '',
        currentState: '',
        ignoredAction: 'function_call',
      },
    ]);
    expect(debugResults).toEqual([
      { taskId: 'review-task', taskGeneration: 1, triggered: false },
      {
        taskId: 'review-task',
        taskGeneration: 1,
        triggered: false,
        ignoredAction: 'function_call',
      },
    ]);
    expect(callbacks.onLifecycleError).not.toHaveBeenCalled();
    expect(JSON.stringify(callbacks.onDebug.mock.calls)).not.toContain(
      'mind-map-generate_mindmap',
    );
    for (const privateText of ['已记下', 'private-intent-marker']) {
      expect(JSON.stringify(callbacks.onDebug.mock.calls)).not.toContain(
        privateText,
      );
      expect(JSON.stringify(socket.sent)).not.toContain(privateText);
    }
  });

  it('R1-27: rejects non-JPEG, noncanonical and oversized monitor image input', async () => {
    const { monitor, sockets } = await harness();
    const socket = sockets[0]!;
    const maximum = Buffer.alloc(QWEN_REALTIME_LIMITS.maxInputImageBytes);
    maximum.set([0xff, 0xd8]);
    maximum.set([0xff, 0xd9], maximum.length - 2);
    const invalid = [
      '',
      Buffer.from('not a jpeg').toString('base64'),
      '/9j/2R==',
      '/9j/2Q==\n',
      '/9j/2Q=',
      Buffer.from([0xff, 0xd8, 0, 0]).toString('base64'),
      Buffer.concat([maximum, Buffer.from([0xff, 0xd9])]).toString('base64'),
    ];
    const countBefore = socket.sent.length;
    for (const image of invalid) expect(monitor.feedImage(image)).toBe(false);
    expect(socket.sent).toHaveLength(countBefore);
    expect(monitor.feedImage('/9j/2Q==')).toBe(true);
    expect(monitor.feedImage(maximum.toString('base64'))).toBe(true);
  });
});
