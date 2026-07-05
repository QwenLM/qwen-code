/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PathMutexRegistry } from './path-mutex-registry.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('PathMutexRegistry', () => {
  it('serializes work for the same key and cleans up the tail', async () => {
    const registry = new PathMutexRegistry();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = registry.runExclusive('file.txt', async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    const second = registry.runExclusive('file.txt', async () => {
      events.push('second:start');
    });

    await tick();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(
      (registry as unknown as { tails: Map<string, Promise<void>> }).tails.size,
    ).toBe(0);
  });

  it('runs the next callback after a rejected predecessor', async () => {
    const registry = new PathMutexRegistry();

    await expect(
      registry.runExclusive('file.txt', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(
      registry.runExclusive('file.txt', async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('allows different keys to run concurrently', async () => {
    const registry = new PathMutexRegistry();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = registry.runExclusive('a.txt', async () => {
      events.push('a:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('a:end');
    });
    const second = registry.runExclusive('b.txt', async () => {
      events.push('b:start');
    });

    await tick();
    expect(events).toEqual(['a:start', 'b:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['a:start', 'b:start', 'a:end']);
  });
});
