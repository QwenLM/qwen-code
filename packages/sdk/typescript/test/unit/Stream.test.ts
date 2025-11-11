/**
 * Unit tests for Stream class
 * Tests producer-consumer patterns and async iteration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Stream } from '../../src/utils/Stream.js';

describe('Stream', () => {
  let stream: Stream<string>;

  beforeEach(() => {
    stream = new Stream<string>();
  });

  describe('Producer-Consumer Patterns', () => {
    it('should deliver enqueued value immediately to waiting consumer', async () => {
      // Start consumer (waits for value)
      const consumerPromise = stream.next();

      // Producer enqueues value
      stream.enqueue('hello');

      // Consumer should receive value immediately
      const result = await consumerPromise;
      expect(result).toEqual({ value: 'hello', done: false });
    });

    it('should buffer values when consumer is slow', async () => {
      // Producer enqueues multiple values
      stream.enqueue('first');
      stream.enqueue('second');
      stream.enqueue('third');

      // Consumer reads buffered values
      expect(await stream.next()).toEqual({ value: 'first', done: false });
      expect(await stream.next()).toEqual({ value: 'second', done: false });
      expect(await stream.next()).toEqual({ value: 'third', done: false });
    });

    it('should handle fast producer and fast consumer', async () => {
      const values: string[] = [];

      // Produce and consume simultaneously
      const consumerPromise = (async () => {
        for (let i = 0; i < 3; i++) {
          const result = await stream.next();
          if (!result.done) {
            values.push(result.value);
          }
        }
      })();

      stream.enqueue('a');
      stream.enqueue('b');
      stream.enqueue('c');

      await consumerPromise;
      expect(values).toEqual(['a', 'b', 'c']);
    });

    it('should handle async iteration with for await loop', async () => {
      const values: string[] = [];

      // Start consumer
      const consumerPromise = (async () => {
        for await (const value of stream) {
          values.push(value);
        }
      })();

      // Producer enqueues and completes
      stream.enqueue('x');
      stream.enqueue('y');
      stream.enqueue('z');
      stream.done();

      await consumerPromise;
      expect(values).toEqual(['x', 'y', 'z']);
    });
  });

  describe('Stream Completion', () => {
    it('should signal completion when done() is called', async () => {
      stream.done();
      const result = await stream.next();
      expect(result).toEqual({ done: true, value: undefined });
    });

    it('should complete waiting consumer immediately', async () => {
      const consumerPromise = stream.next();
      stream.done();
      const result = await consumerPromise;
      expect(result).toEqual({ done: true, value: undefined });
    });

    it('should allow done() to be called multiple times', async () => {
      stream.done();
      stream.done();
      stream.done();

      const result = await stream.next();
      expect(result).toEqual({ done: true, value: undefined });
    });

    it('should allow enqueuing to completed stream (no check in reference)', async () => {
      stream.done();
      // Reference version doesn't check for done in enqueue
      stream.enqueue('value');
      // Verify value was enqueued by reading it
      expect(await stream.next()).toEqual({ value: 'value', done: false });
    });

    it('should deliver buffered values before completion', async () => {
      stream.enqueue('first');
      stream.enqueue('second');
      stream.done();

      expect(await stream.next()).toEqual({ value: 'first', done: false });
      expect(await stream.next()).toEqual({ value: 'second', done: false });
      expect(await stream.next()).toEqual({ done: true, value: undefined });
    });
  });

  describe('Error Handling', () => {
    it('should propagate error to waiting consumer', async () => {
      const consumerPromise = stream.next();
      const error = new Error('Stream error');
      stream.error(error);

      await expect(consumerPromise).rejects.toThrow('Stream error');
    });

    it('should throw error on next read after error is set', async () => {
      const error = new Error('Test error');
      stream.error(error);

      await expect(stream.next()).rejects.toThrow('Test error');
    });

    it('should allow enqueuing to stream with error (no check in reference)', async () => {
      stream.error(new Error('Error'));
      // Reference version doesn't check for error in enqueue
      stream.enqueue('value');
      // Verify value was enqueued by reading it
      expect(await stream.next()).toEqual({ value: 'value', done: false });
    });

    it('should store last error (reference overwrites)', async () => {
      const firstError = new Error('First');
      const secondError = new Error('Second');

      stream.error(firstError);
      stream.error(secondError);

      await expect(stream.next()).rejects.toThrow('Second');
    });

    it('should deliver buffered values before throwing error', async () => {
      stream.enqueue('buffered');
      stream.error(new Error('Stream error'));

      expect(await stream.next()).toEqual({ value: 'buffered', done: false });
      await expect(stream.next()).rejects.toThrow('Stream error');
    });
  });

  describe('State Properties', () => {
    it('should track error state', () => {
      expect(stream.hasError).toBeUndefined();
      stream.error(new Error('Test'));
      expect(stream.hasError).toBeInstanceOf(Error);
      expect(stream.hasError?.message).toBe('Test');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty stream', async () => {
      stream.done();
      const result = await stream.next();
      expect(result.done).toBe(true);
    });

    it('should handle single value', async () => {
      stream.enqueue('only');
      stream.done();

      expect(await stream.next()).toEqual({ value: 'only', done: false });
      expect(await stream.next()).toEqual({ done: true, value: undefined });
    });

    it('should handle rapid enqueue-dequeue cycles', async () => {
      const numberStream = new Stream<number>();
      const iterations = 100;
      const values: number[] = [];

      const producer = async (): Promise<void> => {
        for (let i = 0; i < iterations; i++) {
          numberStream.enqueue(i);
          await new Promise((resolve) => setImmediate(resolve));
        }
        numberStream.done();
      };

      const consumer = async (): Promise<void> => {
        for await (const value of numberStream) {
          values.push(value);
        }
      };

      await Promise.all([producer(), consumer()]);
      expect(values).toHaveLength(iterations);
      expect(values[0]).toBe(0);
      expect(values[iterations - 1]).toBe(iterations - 1);
    });
  });

  describe('TypeScript Types', () => {
    it('should handle different value types', async () => {
      const numberStream = new Stream<number>();
      numberStream.enqueue(42);
      numberStream.done();

      const result = await numberStream.next();
      expect(result.value).toBe(42);

      const objectStream = new Stream<{ id: number; name: string }>();
      objectStream.enqueue({ id: 1, name: 'test' });
      objectStream.done();

      const objectResult = await objectStream.next();
      expect(objectResult.value).toEqual({ id: 1, name: 'test' });
    });
  });

  describe('Iteration Restrictions', () => {
    it('should only allow iteration once', async () => {
      const stream = new Stream<string>();
      stream.enqueue('test');
      stream.done();

      // First iteration should work
      const iterator1 = stream[Symbol.asyncIterator]();
      expect(await iterator1.next()).toEqual({
        value: 'test',
        done: false,
      });

      // Second iteration should throw
      expect(() => stream[Symbol.asyncIterator]()).toThrow(
        'Stream can only be iterated once',
      );
    });
  });
});
