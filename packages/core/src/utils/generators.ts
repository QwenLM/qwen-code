/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Async generator utilities for controlled concurrency and collection helpers.
 */

const NO_VALUE = Symbol('NO_VALUE');

/**
 * Consume an async generator and return its last yielded value.
 * Throws if the generator yields no values.
 */
export async function lastX<A>(as: AsyncGenerator<A>): Promise<A> {
  let lastValue: A | typeof NO_VALUE = NO_VALUE;
  for await (const a of as) {
    lastValue = a;
  }
  if (lastValue === NO_VALUE) {
    throw new Error('No items in generator');
  }
  return lastValue;
}

/**
 * Consume an async generator and return its return value (the value
 * passed to `return` in the generator function, not its yielded values).
 */
export async function returnValue<A>(
  as: AsyncGenerator<unknown, A>,
): Promise<A> {
  let e: IteratorResult<unknown, A>;
  do {
    e = await as.next();
  } while (!e.done);
  return e.value;
}

/** Internal bookkeeping for a generator inside {@link all}. */
type QueuedGenerator<A> = {
  done: boolean | undefined;
  value: A | void;
  generator: AsyncGenerator<A, void>;
  promise: Promise<QueuedGenerator<A>>;
};

/**
 * Run multiple async generators concurrently up to a concurrency cap,
 * yielding their values in the order they become available (fair scheduling
 * via `Promise.race`).
 *
 * When a generator completes, the next waiting generator (if any) is started
 * in its place — a sliding window of at most `concurrencyCap` active generators.
 *
 * @param generators - The generators to run concurrently.
 * @param concurrencyCap - Maximum number of generators executing simultaneously.
 *                         Defaults to `Infinity` (all generators start immediately).
 *
 * @example
 * ```ts
 * const gens = urls.map(url => fetchPages(url)); // each is an AsyncGenerator
 * for await (const page of all(gens, 5)) {
 *   process(page);
 * }
 * ```
 */
export async function* all<A>(
  generators: Array<AsyncGenerator<A, void>>,
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  const next = (
    generator: AsyncGenerator<A, void>,
  ): Promise<QueuedGenerator<A>> => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value,
        generator,
        promise,
      }));
    return promise;
  };

  const waiting = [...generators];
  const promises = new Set<Promise<QueuedGenerator<A>>>();

  // Start initial batch up to concurrency cap
  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!;
    promises.add(next(gen));
  }

  try {
    while (promises.size > 0) {
      const { done, value, generator, promise } = await Promise.race(promises);
      promises.delete(promise);

      if (!done) {
        // Generator produced a value — re-enqueue it for the next iteration
        promises.add(next(generator));
        if (value !== undefined) {
          // Safe type assertion: value is A when not undefined
          yield value as unknown as A;
        }
      } else if (waiting.length > 0) {
        // Generator exhausted — start the next waiting generator in its slot
        const nextGen = waiting.shift()!;
        promises.add(next(nextGen));
      }
    }
  } catch (err) {
    // On error, clean up all remaining active generators to prevent leaks
    const cleanups: Array<Promise<unknown>> = [];
    for (const p of promises) {
      // Each promise references a generator — we can't access it directly
      // from the promise, so we let them settle and return() them.
      cleanups.push(p.then((q) => q.generator.return()).catch(() => {}));
    }
    for (const gen of waiting) {
      cleanups.push(gen.return().catch(() => {}));
    }
    await Promise.allSettled(cleanups);
    throw err;
  }
}

/**
 * Collect all values from an async generator into an array.
 */
export async function toArray<A>(
  generator: AsyncGenerator<A, void>,
): Promise<A[]> {
  const result: A[] = [];
  for await (const a of generator) {
    result.push(a);
  }
  return result;
}

/**
 * Create an async generator that yields each value from the given array.
 */
export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void> {
  for (const value of values) {
    yield value;
  }
}

/**
 * Map an array through an async transform with bounded concurrency.
 * Preserves input order in the output array.
 */
export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}
