/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Stream } from './stream.js';

describe('Stream', () => {
  it('delivers enqueued values in order', async () => {
    const stream = new Stream<number>();
    stream.enqueue(1);
    stream.enqueue(2);
    stream.enqueue(3);
    stream.done();

    const results: number[] = [];
    for await (const v of stream) {
      results.push(v);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it('delivers values pushed after iteration begins', async () => {
    const stream = new Stream<string>();

    // Push asynchronously
    setTimeout(() => {
      stream.enqueue('a');
      stream.enqueue('b');
      stream.done();
    }, 10);

    const results: string[] = [];
    for await (const v of stream) {
      results.push(v);
    }
    expect(results).toEqual(['a', 'b']);
  });

  it('returns done when stream is completed before iteration', async () => {
    const stream = new Stream<number>();
    stream.done();

    const result = await stream.next();
    expect(result).toEqual({ done: true, value: undefined });
  });

  it('propagates error to consumer', async () => {
    const stream = new Stream<number>();
    const err = new Error('test error');

    setTimeout(() => {
      stream.error(err);
    }, 10);

    await expect(async () => {
      for await (const _v of stream) {
        // should not reach here
      }
    }).rejects.toThrow('test error');
  });

  it('propagates error set before iteration', async () => {
    const stream = new Stream<number>();
    const err = new Error('pre-set error');
    stream.error(err);

    await expect(stream.next()).rejects.toThrow('pre-set error');
  });

  it('prevents double iteration', () => {
    const stream = new Stream<number>();
    stream[Symbol.asyncIterator](); // first call

    expect(() => stream[Symbol.asyncIterator]()).toThrow(
      'Stream can only be iterated once',
    );
  });

  it('calls returned callback on early return', async () => {
    let returnedCalled = false;
    const stream = new Stream<number>(() => {
      returnedCalled = true;
    });

    stream.enqueue(1);
    stream.enqueue(2);
    stream.enqueue(3);

    // Iterate and break after first value
    for await (const _v of stream) {
      break;
    }

    expect(returnedCalled).toBe(true);
  });

  it('handles rapid enqueue/dequeue cycles', async () => {
    const stream = new Stream<number>();
    const count = 100;

    // Producer: enqueue values with microtask delays
    void (async () => {
      for (let i = 0; i < count; i++) {
        stream.enqueue(i);
        await Promise.resolve(); // yield to microtask queue
      }
      stream.done();
    })();

    const results: number[] = [];
    for await (const v of stream) {
      results.push(v);
    }
    expect(results).toHaveLength(count);
    expect(results).toEqual(Array.from({ length: count }, (_, i) => i));
  });

  it('return() marks stream as done', async () => {
    const stream = new Stream<number>();
    stream.enqueue(1);

    // Consume one value
    const first = await stream.next();
    expect(first).toEqual({ done: false, value: 1 });

    // Manually return
    const ret = await stream.return();
    expect(ret).toEqual({ done: true, value: undefined });

    // Subsequent next() should return done
    const after = await stream.next();
    expect(after).toEqual({ done: true, value: undefined });
  });

  it('wakes parked reader when enqueue is called', async () => {
    const stream = new Stream<string>();

    // Start reading before any enqueue — reader parks
    const readPromise = stream.next();

    // Now enqueue
    stream.enqueue('wakeup');

    const result = await readPromise;
    expect(result).toEqual({ done: false, value: 'wakeup' });
  });

  it('wakes parked reader on done()', async () => {
    const stream = new Stream<string>();

    const readPromise = stream.next();
    stream.done();

    const result = await readPromise;
    expect(result).toEqual({ done: true, value: undefined });
  });

  it('wakes parked reader on error()', async () => {
    const stream = new Stream<string>();

    const readPromise = stream.next();
    stream.error(new Error('async error'));

    await expect(readPromise).rejects.toThrow('async error');
  });
});
