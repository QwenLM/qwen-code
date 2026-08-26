/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DwsEventProcessError,
  startDwsEventProcess,
} from './dws-event-stream.js';

describe('DWS event process', () => {
  it('becomes ready, forwards NDJSON lines, and stops by closing stdin', async () => {
    let resolveLine!: (line: string) => void;
    const line = new Promise<string>((resolve) => {
      resolveLine = resolve;
    });
    const onError = vi.fn();
    const fixture = fileURLToPath(
      new URL('./fixtures/dws-event-source.mjs', import.meta.url),
    );

    const subscription = await startDwsEventProcess(
      process.execPath,
      [fixture],
      resolveLine,
      onError,
    );

    await expect(line).resolves.toBe('{"type":"fixture"}');
    subscription.stop();
    await expect(subscription.closed).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('preserves structured retry guidance from a stopped consumer', async () => {
    const onError = vi.fn();
    const fixture = fileURLToPath(
      new URL('./fixtures/dws-event-error-source.mjs', import.meta.url),
    );
    const subscription = await startDwsEventProcess(
      process.execPath,
      [fixture],
      vi.fn(),
      onError,
    );

    await subscription.closed;

    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(DwsEventProcessError);
    expect(error).toMatchObject({
      message: 'subscription denied',
      retryable: false,
      retryAfterMs: 3_000,
    });
  });

  it('clears stale process errors after a healthy event', async () => {
    const onLine = vi.fn();
    const onError = vi.fn();
    const fixture = fileURLToPath(
      new URL('./fixtures/dws-event-recovered-source.mjs', import.meta.url),
    );
    const subscription = await startDwsEventProcess(
      process.execPath,
      [fixture],
      onLine,
      onError,
    );

    await subscription.closed;

    expect(onLine).toHaveBeenCalledWith('{"type":"recovered"}');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: 'DWS event consumer stopped (0).',
      retryable: undefined,
    });
  });

  it('preserves a terminal error across stdout buffered after exit', async () => {
    let releaseFirstLine!: () => void;
    const firstLineBlocked = new Promise<void>((resolve) => {
      releaseFirstLine = resolve;
    });
    let markFirstLineStarted!: () => void;
    const firstLineStarted = new Promise<void>((resolve) => {
      markFirstLineStarted = resolve;
    });
    const onError = vi.fn();
    const fixture = fileURLToPath(
      new URL('./fixtures/dws-event-postmortem-source.mjs', import.meta.url),
    );
    const subscription = await startDwsEventProcess(
      process.execPath,
      [fixture],
      async (line) => {
        if (line === '{"sequence":1}') {
          markFirstLineStarted();
          await firstLineBlocked;
        }
      },
      onError,
    );

    await firstLineStarted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFirstLine();
    await subscription.closed;

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: 'subscription denied',
      retryable: false,
    });
  });

  it('serializes a burst of inbound event lines', async () => {
    let active = 0;
    let maxActive = 0;
    const handled: string[] = [];
    const fixture = fileURLToPath(
      new URL('./fixtures/dws-event-burst-source.mjs', import.meta.url),
    );
    const subscription = await startDwsEventProcess(
      process.execPath,
      [fixture],
      async (line) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        handled.push(line);
        active -= 1;
      },
      vi.fn(),
    );

    await vi.waitFor(() => expect(handled).toHaveLength(3));
    subscription.stop();
    await subscription.closed;

    expect(maxActive).toBe(1);
    expect(handled).toEqual([
      '{"sequence":1}',
      '{"sequence":2}',
      '{"sequence":3}',
    ]);
  });

  it('contains errors thrown by both the line and error handlers', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const fixture = fileURLToPath(
        new URL('./fixtures/dws-event-source.mjs', import.meta.url),
      );
      const subscription = await startDwsEventProcess(
        process.execPath,
        [fixture],
        async () => {
          throw new Error('line failed');
        },
        () => {
          throw new Error('error handler failed');
        },
      );

      subscription.stop();
      await subscription.closed;
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
