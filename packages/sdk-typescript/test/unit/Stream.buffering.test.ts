import { describe, expect, it } from 'vitest';
import { Stream } from '../../src/utils/Stream.js';

describe('Stream buffered bursts', () => {
  it('bounds element work while draining through compaction', async () => {
    const stream = new Stream<number>();
    const produced = 8192;
    for (let i = 0; i < produced; i++) stream.enqueue(i);
    const storage = stream as unknown as { queue: unknown[] };
    let elementAccesses = 0;
    const trackElements = (queue: unknown[]) =>
      new Proxy(queue, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
            elementAccesses++;
          }
          return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
            elementAccesses++;
          }
          return Reflect.set(target, property, value, receiver);
        },
      });
    let buffer = (storage.queue = trackElements(storage.queue));
    for (let i = 0; i < produced; i++) {
      expect(await stream.next()).toEqual({ done: false, value: i });
      expect(elementAccesses).toBeLessThanOrEqual(4 * (i + 1));
      if (storage.queue !== buffer) {
        buffer = storage.queue = trackElements(storage.queue);
      }
    }
  });

  it('releases a consumed payload before compacting the buffer', async () => {
    const consumed = { message: 'already read' };
    const waiting = { message: 'still waiting' };
    const stream = new Stream<typeof consumed>();
    stream.enqueue(consumed);
    stream.enqueue(waiting);

    expect((await stream.next()).value).toBe(consumed);
    const storage = stream as unknown as { queue: unknown[] };
    expect(storage.queue).not.toContain(consumed);
    expect(storage.queue).toContain(waiting);
  });

  it.each([
    { produced: 2000, consumed: 1500 },
    { produced: 20_000, consumed: 15_000 },
  ])(
    'bounds retained storage for $produced buffered messages',
    async ({ produced, consumed }) => {
      const stream = new Stream<number>();
      const compactionFloor = 1024;
      for (let i = 0; i < produced; i++) stream.enqueue(i);
      const storage = stream as unknown as { queue: unknown[] };
      for (let i = 0; i < consumed; i++) {
        await stream.next();
        const pending = produced - (i + 1);
        expect(storage.queue.length).toBeLessThanOrEqual(
          pending + Math.max(pending, compactionFloor),
        );
      }
    },
  );

  it('keeps FIFO order across a partial drain and a second producer burst', async () => {
    const stream = new Stream<number>();
    for (let i = 0; i < 20_000; i++) stream.enqueue(i);
    for (let i = 0; i < 15_000; i++) {
      expect(await stream.next()).toEqual({ done: false, value: i });
    }
    for (let i = 20_000; i < 40_000; i++) stream.enqueue(i);
    stream.done();
    for (let i = 15_000; i < 40_000; i++) {
      expect(await stream.next()).toEqual({ done: false, value: i });
    }
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it('delivers undefined values and preserves the buffered error boundary', async () => {
    const stream = new Stream<number | undefined>();
    for (let i = 0; i < 3000; i++) {
      stream.enqueue(i % 2 === 0 ? undefined : i);
    }
    stream.error(new Error('producer failed'));
    for (let i = 0; i < 3000; i++) {
      expect(await stream.next()).toEqual({
        done: false,
        value: i % 2 === 0 ? undefined : i,
      });
    }
    await expect(stream.next()).rejects.toThrow('producer failed');
  });

  it('can buffer again after every previously queued value has been read', async () => {
    const stream = new Stream<number>();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 2000; i++) stream.enqueue(round * 2000 + i);
      for (let i = 0; i < 2000; i++) {
        expect(await stream.next()).toEqual({
          done: false,
          value: round * 2000 + i,
        });
      }
    }
    stream.done();
    expect((await stream.next()).done).toBe(true);
  });
});
