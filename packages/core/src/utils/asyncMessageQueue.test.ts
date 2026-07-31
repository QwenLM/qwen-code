/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AsyncMessageQueue } from './asyncMessageQueue.js';

describe('AsyncMessageQueue', () => {
  it('should dequeue items in FIFO order', () => {
    const queue = new AsyncMessageQueue<string>();
    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');

    expect(queue.dequeue()).toBe('a');
    expect(queue.dequeue()).toBe('b');
    expect(queue.dequeue()).toBe('c');
  });

  it('should return null when empty', () => {
    const queue = new AsyncMessageQueue<string>();
    expect(queue.dequeue()).toBeNull();
  });

  it('should return remaining items then null after drain()', () => {
    const queue = new AsyncMessageQueue<string>();
    queue.enqueue('x');
    queue.enqueue('y');

    queue.drain();

    expect(queue.dequeue()).toBe('x');
    expect(queue.dequeue()).toBe('y');
    expect(queue.dequeue()).toBeNull();
  });

  it('should silently drop items enqueued after drain()', () => {
    const queue = new AsyncMessageQueue<string>();
    queue.drain();
    queue.enqueue('dropped');

    expect(queue.size).toBe(0);
  });

  it('should track size accurately', () => {
    const queue = new AsyncMessageQueue<number>();
    expect(queue.size).toBe(0);

    queue.enqueue(1);
    queue.enqueue(2);
    expect(queue.size).toBe(2);

    queue.dequeue();
    expect(queue.size).toBe(1);
  });

  it('should report isDrained correctly', () => {
    const queue = new AsyncMessageQueue<string>();
    expect(queue.isDrained).toBe(false);

    queue.drain();
    expect(queue.isDrained).toBe(true);
  });

  it('should handle multiple sequential enqueue-dequeue cycles', () => {
    const queue = new AsyncMessageQueue<number>();

    for (let i = 0; i < 5; i++) {
      queue.enqueue(i);
      expect(queue.dequeue()).toBe(i);
    }
  });
});
