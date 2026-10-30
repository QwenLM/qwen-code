/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationStreamQueue } from '@qwen-code/acp-bridge';
import type { BridgeGenerationStreamEvent } from '@qwen-code/acp-bridge';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { BtwStreamError, BtwStreamRequests } from './btw-stream.js';

function fixture() {
  const queues: Array<GenerationStreamQueue<BridgeGenerationStreamEvent>> = [];
  let generationSignal: AbortSignal | undefined;
  const generateSessionBtwStream = vi.fn(
    (_session: string, _question: string, signal: AbortSignal) => {
      generationSignal ??= signal;
      const queue = new GenerationStreamQueue<BridgeGenerationStreamEvent>(8);
      queues.push(queue);
      signal.addEventListener('abort', () => queue.close(), { once: true });
      return queue;
    },
  );
  const bridge = { generateSessionBtwStream } as unknown as AcpSessionBridge;
  const requests = new BtwStreamRequests();
  const open = (resume = false, question = 'Why?') =>
    requests.open(bridge, 'session', 'client', 'request', question, resume);
  const push = (event: BridgeGenerationStreamEvent) => queues[0]!.push(event);
  return {
    requests,
    bridge,
    open,
    push,
    generateSessionBtwStream,
    signal: () => generationSignal,
  };
}

afterEach(() => vi.useRealTimers());

describe('BTW answer snapshots', () => {
  it('reconnects to the latest answer without duplicating model calls or text', async () => {
    const f = fixture();
    const request = f.open();
    const connection = new AbortController();
    const stream = request.subscribe(connection.signal);
    expect((await stream.next()).value).toMatchObject({
      type: 'answer',
      answer: '',
    });
    f.push({ type: 'delta', requestId: 'upstream', seq: 0, text: 'Hello' });
    expect((await stream.next()).value).toMatchObject({ answer: 'Hello' });
    connection.abort();
    await stream.return(undefined);
    expect(f.signal()?.aborted).toBe(false);

    f.push({ type: 'delta', requestId: 'upstream', seq: 1, text: ' world' });
    f.push({
      type: 'done',
      requestId: 'upstream',
      model: 'main',
      modelSource: 'main',
    });
    const resumed = f.open(true).subscribe(new AbortController().signal);
    const snapshots = [];
    for await (const snapshot of resumed) snapshots.push(snapshot);
    expect(snapshots.at(-1)).toEqual({
      type: 'done',
      requestId: 'request',
      answer: 'Hello world',
    });
    expect(f.generateSessionBtwStream).toHaveBeenCalledTimes(1);
    expect(f.open()).toBe(request);
  });

  it('rejects conflicts and missing resumes without starting model work', () => {
    const f = fixture();
    expect(() => f.open(true)).toThrow('expired');
    expect(f.generateSessionBtwStream).not.toHaveBeenCalled();
    f.open();
    expect(() => f.open(true, 'Another question')).toThrow(
      'different question',
    );
    expect(f.generateSessionBtwStream).toHaveBeenCalledTimes(1);
    f.requests.cancel(f.bridge, 'session', 'client', 'request');
  });

  it('isolates bridge, session and client identity on resume', () => {
    const f = fixture();
    f.open();
    for (const [bridge, session, client] of [
      [{} as AcpSessionBridge, 'session', 'client'],
      [f.bridge, 'other-session', 'client'],
      [f.bridge, 'session', 'other-client'],
    ] as const) {
      expect(() =>
        f.requests.open(bridge, session, client, 'request', 'Why?', true),
      ).toThrow('expired');
    }
    f.requests.cancel(f.bridge, 'session', 'client', 'request');
  });

  it('cancels only the requested generation and remembers cancel-before-start', async () => {
    const f = fixture();
    const request = f.open();
    f.requests.cancel(f.bridge, 'session', 'client', 'request');
    expect(f.signal()?.aborted).toBe(true);
    expect(
      (await request.subscribe(new AbortController().signal).next()).value,
    ).toMatchObject({ type: 'error', code: 'btw_cancelled' });

    f.requests.cancel(f.bridge, 'session', 'client', 'not-started');
    const cancelled = f.requests.open(
      f.bridge,
      'session',
      'client',
      'not-started',
      'Why?',
      false,
    );
    expect(
      (await cancelled.subscribe(new AbortController().signal).next()).value,
    ).toMatchObject({ code: 'btw_cancelled' });
    expect(f.generateSessionBtwStream).toHaveBeenCalledTimes(1);
  });

  it('rejects a 33rd active request but always allows cancelling a known request', async () => {
    const f = fixture();
    const request = f.open();
    for (let i = 1; i < 32; i++)
      f.requests.open(
        f.bridge,
        'session',
        'client',
        `active-${i}`,
        'Why?',
        false,
      );
    for (const operation of [
      () =>
        f.requests.open(
          f.bridge,
          'session',
          'client',
          'overflow',
          'Why?',
          false,
        ),
      () => f.requests.cancel(f.bridge, 'session', 'client', 'unknown'),
    ]) {
      expect(operation).toThrow(BtwStreamError);
      try {
        operation();
      } catch (error) {
        expect(error).toMatchObject({ status: 429, code: 'btw_limit' });
      }
    }
    expect(f.generateSessionBtwStream).toHaveBeenCalledTimes(32);
    f.requests.cancel(f.bridge, 'session', 'client', 'request');
    expect(f.signal()?.aborted).toBe(true);
    expect(
      (await request.subscribe(new AbortController().signal).next()).value,
    ).toMatchObject({ code: 'btw_cancelled' });
    for (let i = 1; i < 32; i++) {
      expect(f.requests.has(f.bridge, 'session', 'client', `active-${i}`)).toBe(
        true,
      );
      f.requests.cancel(f.bridge, 'session', 'client', `active-${i}`);
    }
  });

  it('evicts the oldest terminal receipt and clears its expiry before reusing the ID', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.open();
    for (let i = 1; i < 32; i++)
      f.requests.open(
        f.bridge,
        'session',
        'client',
        `active-${i}`,
        'Why?',
        false,
      );
    f.requests.cancel(f.bridge, 'session', 'client', 'active-1');
    f.push({
      type: 'done',
      requestId: 'upstream',
      model: 'main',
      modelSource: 'main',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    f.requests.open(f.bridge, 'session', 'client', 'new', 'Why?', false);
    expect(() => f.open(true)).toThrow('expired');
    expect(f.requests.has(f.bridge, 'session', 'client', 'active-1')).toBe(
      true,
    );
    f.open();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f.requests.has(f.bridge, 'session', 'client', 'request')).toBe(true);
    expect(f.requests.has(f.bridge, 'session', 'client', 'active-1')).toBe(
      false,
    );
    expect(f.generateSessionBtwStream).toHaveBeenCalledTimes(34);
    for (const id of [
      'request',
      'new',
      ...Array.from({ length: 30 }, (_, i) => `active-${i + 2}`),
    ])
      f.requests.cancel(f.bridge, 'session', 'client', id);
  });

  it('retains completion and cancellation until their individual 60-second boundary', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.open();
    f.push({
      type: 'done',
      requestId: 'upstream',
      model: 'main',
      modelSource: 'main',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    f.requests.cancel(f.bridge, 'session', 'client', 'cancelled');
    await vi.advanceTimersByTimeAsync(58_999);
    expect(f.requests.has(f.bridge, 'session', 'client', 'request')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => f.open(true)).toThrow('expired');
    expect(f.requests.has(f.bridge, 'session', 'client', 'cancelled')).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(f.requests.has(f.bridge, 'session', 'client', 'cancelled')).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requests.has(f.bridge, 'session', 'client', 'cancelled')).toBe(
      false,
    );
  });

  it('owns the five-minute timeout before the child or bridge deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = f.open();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(f.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signal()?.aborted).toBe(true);
    expect(
      (await request.subscribe(new AbortController().signal).next()).value,
    ).toMatchObject({ type: 'error', code: 'btw_timeout' });
  });

  it.each([1024 * 1024, 1024 * 1024 + 1])(
    'bounds an answer of %i UTF-8 bytes',
    async (bytes) => {
      const f = fixture();
      const request = f.open();
      f.push({
        type: 'delta',
        requestId: 'upstream',
        seq: 0,
        text: 'x'.repeat(bytes),
      });
      f.push({
        type: 'done',
        requestId: 'upstream',
        model: 'main',
        modelSource: 'main',
      });
      const snapshots = [];
      for await (const snapshot of request.subscribe(
        new AbortController().signal,
      ))
        snapshots.push(snapshot);
      if (bytes === 1024 * 1024) {
        expect(snapshots.at(-1)).toMatchObject({
          type: 'done',
          answer: 'x'.repeat(bytes),
        });
        expect(f.signal()?.aborted).toBe(false);
      } else {
        expect(snapshots.at(-1)).toMatchObject({
          type: 'error',
          code: 'btw_failed',
        });
        expect(f.signal()?.aborted).toBe(true);
      }
    },
  );

  it('preserves whitespace in partial snapshots and trims the final answer like legacy BTW', async () => {
    const f = fixture();
    const stream = f.open().subscribe(new AbortController().signal);
    await stream.next();
    f.push({
      type: 'delta',
      requestId: 'upstream',
      seq: 0,
      text: '  answer \n',
    });
    expect((await stream.next()).value).toMatchObject({
      type: 'answer',
      answer: '  answer \n',
    });
    f.push({
      type: 'done',
      requestId: 'upstream',
      model: 'main',
      modelSource: 'main',
    });
    expect((await stream.next()).value).toMatchObject({
      type: 'done',
      answer: 'answer',
    });
    await stream.next();
  });

  it('reports generation failure as a retained terminal snapshot', async () => {
    const f = fixture();
    f.generateSessionBtwStream.mockImplementation(() => {
      throw new Error('upstream failed');
    });
    const request = f.open();
    expect(
      (await request.subscribe(new AbortController().signal).next()).value,
    ).toMatchObject({ type: 'error', code: 'btw_failed' });
    expect(f.open(true)).toBe(request);
  });
});
