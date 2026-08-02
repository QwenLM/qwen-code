/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';

describe('WorkflowDispatchScheduler', () => {
  it('settles an idle pause immediately and only resumes from paused', () => {
    const states: string[] = [];
    const scheduler = new WorkflowDispatchScheduler(1, undefined, (snapshot) =>
      states.push(snapshot.state),
    );

    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot()).toEqual({
      state: 'paused',
      queued: 0,
      inFlight: 0,
    });
    expect(states).toEqual(['pausing', 'paused']);
    expect(scheduler.resume()).toBe(true);
    expect(scheduler.resume()).toBe(false);
  });

  it('stops dequeuing and holds a completed result gate until resume', async () => {
    const states: string[] = [];
    const scheduler = new WorkflowDispatchScheduler(1, undefined, (snapshot) =>
      states.push(snapshot.state),
    );
    let finishFirst: ((value: string) => void) | undefined;
    const firstStarted = vi.fn();
    const secondStarted = vi.fn();

    const firstDispatch = scheduler.run(
      () =>
        new Promise<string>((resolve) => {
          firstStarted();
          finishFirst = resolve;
        }),
    );
    const secondDispatch = scheduler.run(async () => {
      secondStarted();
      return 'second';
    });

    await vi.waitFor(() => expect(firstStarted).toHaveBeenCalledOnce());
    expect(secondStarted).not.toHaveBeenCalled();
    expect(scheduler.pause()).toBe(true);
    expect(scheduler.snapshot()).toEqual({
      state: 'pausing',
      queued: 1,
      inFlight: 1,
    });
    expect(scheduler.resume()).toBe(false);

    finishFirst?.('first');
    const firstResult = await firstDispatch;
    const gatedResult = scheduler.waitUntilRunning().then(() => firstResult);
    let gateSettled = false;
    void gatedResult.then(() => {
      gateSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduler.snapshot()).toEqual({
      state: 'paused',
      queued: 1,
      inFlight: 0,
    });
    expect(secondStarted).not.toHaveBeenCalled();
    expect(gateSettled).toBe(false);

    expect(scheduler.resume()).toBe(true);
    await expect(gatedResult).resolves.toBe('first');
    await expect(secondDispatch).resolves.toBe('second');
    expect(states).toEqual(['pausing', 'paused', 'running']);
  });

  it('aborts queued dispatches and both fulfilled and rejected result gates', async () => {
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    let finishFirst: ((value: string) => void) | undefined;
    const firstDispatch = scheduler.run(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const queuedDispatch = scheduler.run(async () => 'queued');
    await vi.waitFor(() => expect(finishFirst).toBeDefined());

    scheduler.pause();
    finishFirst?.('fulfilled');
    const result = await firstDispatch;
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    const fulfilledGate = scheduler.waitUntilRunning().then(() => result);
    const rejectedGate = scheduler.waitUntilRunning().then(() => {
      throw new Error('dispatch failed');
    });

    controller.abort();

    await expect(queuedDispatch).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fulfilledGate).rejects.toMatchObject({ name: 'AbortError' });
    await expect(rejectedGate).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.snapshot()).toEqual({
      state: 'paused',
      queued: 0,
      inFlight: 0,
    });
  });
});
