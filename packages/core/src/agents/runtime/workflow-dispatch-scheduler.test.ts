/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';

describe('WorkflowDispatchScheduler', () => {
  it.each([0, -1, 1.5, NaN])(
    'rejects a non-positive-integer limit (%s)',
    (limit) => {
      expect(() => new WorkflowDispatchScheduler(limit)).toThrow(
        /positive integer/,
      );
    },
  );

  it('enforces the concurrency window across multiple slots', async () => {
    const scheduler = new WorkflowDispatchScheduler(3);
    let active = 0;
    let peak = 0;
    const thunks = Array.from({ length: 12 }, () =>
      scheduler.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active--;
      }),
    );
    await Promise.all(thunks);
    expect(peak).toBe(3);
  });

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

  it('aborts queued dispatches while an in-flight thunk never settles', async () => {
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    void scheduler.run(() => new Promise<never>(() => {}));
    const queuedDispatch = scheduler.run(async () => 'queued');
    await vi.waitFor(() => expect(scheduler.snapshot().inFlight).toBe(1));
    expect(scheduler.snapshot().queued).toBe(1);

    controller.abort();

    await expect(queuedDispatch).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.snapshot().queued).toBe(0);
  });

  it('notifies onStateChange subscribers and honors unsubscribe', () => {
    const states: string[] = [];
    const scheduler = new WorkflowDispatchScheduler(1);
    const unsubscribe = scheduler.onStateChange((snapshot) =>
      states.push(snapshot.state),
    );

    expect(scheduler.pause()).toBe(true);
    expect(states).toEqual(['pausing', 'paused']);

    unsubscribe();
    expect(scheduler.resume()).toBe(true);
    expect(states).toEqual(['pausing', 'paused']);
  });

  it('rejects run() immediately after pause + abort', async () => {
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    scheduler.pause();
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

    controller.abort();

    const thunk = vi.fn(async () => 'should not run');
    await expect(scheduler.run(thunk)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(thunk).not.toHaveBeenCalled();
  });

  it('refuses resume() after the abort signal fired on a paused scheduler', async () => {
    // R11-13: a user-paused run whose enclosing turn is then cancelled
    // keeps status 'paused' on an aborted scheduler (abortPending emits
    // no state transition). Without the signal guard, resume() would
    // flip the dead, draining run's registry entry back to 'running'.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    expect(scheduler.pause()).toBe(true);
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));

    controller.abort();

    expect(scheduler.resume()).toBe(false);
    expect(scheduler.snapshot().state).toBe('paused');
  });

  it('refuses pause() after the abort signal fired on a running scheduler', async () => {
    // Symmetric guard: an aborted running run must not transition into
    // pausing/paused.
    const controller = new AbortController();
    const scheduler = new WorkflowDispatchScheduler(1, controller.signal);
    expect(scheduler.snapshot().state).toBe('running');

    controller.abort();

    expect(scheduler.pause()).toBe(false);
    expect(scheduler.snapshot().state).toBe('running');
  });
});
