/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { GenerationStreamQueue } from './generation-stream.js';

describe('GenerationStreamQueue', () => {
  it('delivers values in order and closes', async () => {
    const queue = new GenerationStreamQueue<number>(2);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false);
    queue.close();

    const values: number[] = [];
    for await (const value of queue) values.push(value);
    expect(values).toEqual([1, 2]);
  });

  it('rejects a pending reader on failure', async () => {
    const queue = new GenerationStreamQueue<number>(1);
    const next = queue[Symbol.asyncIterator]().next();
    queue.fail(new Error('failed'));
    await expect(next).rejects.toThrow('failed');
  });

  it('delivers undefined values', async () => {
    const queue = new GenerationStreamQueue<number | undefined>(1);
    expect(queue.push(undefined)).toBe(true);
    queue.close();

    await expect(queue[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: undefined,
      done: false,
    });
  });

  it('rejects a second concurrent reader without orphaning the first', async () => {
    const queue = new GenerationStreamQueue<number>(1);
    const iterator = queue[Symbol.asyncIterator]();
    const first = iterator.next();

    await expect(iterator.next()).rejects.toThrow(
      'supports only one pending reader',
    );
    expect(queue.push(1)).toBe(true);
    await expect(first).resolves.toEqual({ value: 1, done: false });
  });
});
