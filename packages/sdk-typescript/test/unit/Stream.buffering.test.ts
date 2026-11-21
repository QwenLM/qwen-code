import { describe, expect, it } from 'vitest';
import { Stream } from '../../src/utils/Stream.js';

describe('Stream buffered bursts', () => {
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
