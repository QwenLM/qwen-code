/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it, vi } from 'vitest';
import { sampleScreen } from './screen-feed-sampler';

afterEach(() => vi.useRealTimers());

it('sends static screens every second and never queues behind a busy socket', async () => {
  vi.useFakeTimers();
  const grab = vi.fn(async () => ({ image: 'jpeg', width: 1, height: 1 }));
  const send = vi.fn();
  let ready = true;
  const cancel = sampleScreen({
    grab,
    send,
    canSend: () => ready,
    onError: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(4000);
  expect(send).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(6);
  ready = false;
  const captures = grab.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(grab).toHaveBeenCalledTimes(captures);
  cancel();
});

it('does not overlap captures or deliver an asynchronous frame after cancellation', async () => {
  vi.useFakeTimers();
  let resolve!: (frame: {
    image: string;
    width: number;
    height: number;
  }) => void;
  const grab = vi.fn(
    () =>
      new Promise<{ image: string; width: number; height: number }>((done) => {
        resolve = done;
      }),
  );
  const send = vi.fn();
  const cancel = sampleScreen({
    grab,
    send,
    canSend: () => true,
    onError: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(grab).toHaveBeenCalledTimes(1);
  cancel();
  resolve({ image: 'jpeg', width: 1, height: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).not.toHaveBeenCalled();
});
