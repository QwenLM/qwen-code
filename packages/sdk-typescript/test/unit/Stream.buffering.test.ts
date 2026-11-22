import { describe, expect, it, vi } from 'vitest';
import { Stream } from '../../src/utils/Stream.js';

describe('Stream buffered bursts', () => {
  it('drains without shifting or copying a mostly live buffer', async () => {
    const stream = new Stream<number>();
    for (let i = 0; i < 8192; i++) stream.enqueue(i);
    const storage = stream as unknown as { queue: unknown[] };
    const buffer = storage.queue;
    const spies = (['shift', 'splice', 'copyWithin', 'unshift'] as const).map(
      (method) => vi.spyOn(buffer, method),
    );
    try {
      for (let i = 0; i < 2048; i++) await stream.next();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(storage.queue).toBe(buffer);
    } finally {
      for (const spy of spies) spy.mockRestore();
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

  it('bounds retained storage while a large burst is partly consumed', async () => {
    const stream = new Stream<number>();
    const produced = 20_000;
    const consumed = 15_000;
    for (let i = 0; i < produced; i++) stream.enqueue(i);
    const storage = stream as unknown as { queue: unknown[] };
    for (let i = 0; i < consumed; i++) {
      await stream.next();
      expect(storage.queue.length).toBeLessThanOrEqual(
        2 * (produced - (i + 1)),
      );
    }
  });

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
