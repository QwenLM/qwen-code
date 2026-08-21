/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend-level reachability tests for the slash gateway (R2): slash input is
 * queued until the dispatcher is ready, initialization errors are exposed
 * instead of falling through to the model, concurrent commands are rejected,
 * and Esc routes to dispatcher.cancel().
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenTuiSlashGateway } from './slash-gateway.js';
import type {
  OpenTuiDispatchOutcome,
  OpenTuiSlashDispatcher,
} from './commands-dispatch.js';

function fakeDispatcher(
  handle: () => Promise<OpenTuiDispatchOutcome | false> = async () => ({
    kind: 'handled',
  }),
): OpenTuiSlashDispatcher {
  return {
    handle: vi.fn(handle),
    cancel: vi.fn(),
    commands: [],
    setCommands: vi.fn(),
    loadCommands: vi.fn(async () => {}),
  } as unknown as OpenTuiSlashDispatcher;
}

/** Lets an already-ready dispatch reach its busy section. */
const flush = () => Promise.resolve();

describe('OpenTuiSlashGateway', () => {
  it('queues slash input until the dispatcher attaches', async () => {
    const gateway = new OpenTuiSlashGateway();
    const dispatcher = fakeDispatcher(async () => ({ kind: 'handled' }));

    // Submitted while initialization is still pending: not lost, not sent to
    // the model, and not reaching a not-yet-built dispatcher.
    const pending = gateway.dispatch('/help');
    expect(gateway.isReady()).toBe(false);

    gateway.attach(dispatcher);
    const settlement = await pending;
    expect(settlement).toEqual({
      kind: 'dispatched',
      outcome: { kind: 'handled' },
    });
    expect(dispatcher.handle).toHaveBeenCalledWith('/help');
  });

  it('rejects dispatches after the queue drains post-attach', async () => {
    const gateway = new OpenTuiSlashGateway();
    const dispatcher = fakeDispatcher(async () => false);
    gateway.attach(dispatcher);
    const settlement = await gateway.dispatch('not-a-command');
    // `false` (not a slash command) passes through to the normal prompt path.
    expect(settlement).toEqual({ kind: 'dispatched', outcome: false });
  });

  it('exposes initialization errors to every later submission', async () => {
    const gateway = new OpenTuiSlashGateway();
    const pending = gateway.dispatch('/help');
    gateway.failInit(new Error('loader exploded'));

    const first = await pending;
    expect(first.kind).toBe('rejected');
    if (first.kind === 'rejected') {
      expect(first.reason).toContain('failed to initialize');
      expect(first.reason).toContain('loader exploded');
    }

    // The gateway stays rejected — '/help' never falls through to the model.
    const second = await gateway.dispatch('/help');
    expect(second.kind).toBe('rejected');
    expect(gateway.getInitError()).toBe('loader exploded');
  });

  it('prevents concurrent command submission', async () => {
    const gateway = new OpenTuiSlashGateway();
    let release: () => void = () => {};
    const firstDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = fakeDispatcher(async () => {
      await firstDone;
      return { kind: 'handled' };
    });
    gateway.attach(dispatcher);

    const first = gateway.dispatch('/first');
    await flush(); // let the in-flight dispatch reach its busy section
    expect(gateway.isBusy()).toBe(true);

    const second = await gateway.dispatch('/second');
    expect(second).toEqual({
      kind: 'rejected',
      reason: 'A slash command is already running.',
    });
    expect(dispatcher.handle).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(gateway.isBusy()).toBe(false);

    // The gate reopens once the command finishes.
    const third = await gateway.dispatch('/third');
    expect(third.kind).toBe('dispatched');
  });

  it('releases the busy gate even when the command throws', async () => {
    const gateway = new OpenTuiSlashGateway();
    let attempt = 0;
    const dispatcher = fakeDispatcher(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('command exploded');
      return { kind: 'handled' };
    });
    gateway.attach(dispatcher);

    await expect(gateway.dispatch('/boom')).rejects.toThrow('command exploded');
    expect(gateway.isBusy()).toBe(false);

    const next = await gateway.dispatch('/after');
    expect(next.kind).toBe('dispatched');
  });

  it('routes cancel() to the attached dispatcher (Esc parity)', () => {
    const gateway = new OpenTuiSlashGateway();
    gateway.cancel(); // before attach: a safe no-op
    const dispatcher = fakeDispatcher();
    gateway.attach(dispatcher);
    gateway.cancel();
    expect(dispatcher.cancel).toHaveBeenCalledTimes(1);
  });

  it('replaces the dispatcher on re-attach after a reload', async () => {
    const gateway = new OpenTuiSlashGateway();
    const first = fakeDispatcher(async () => ({ kind: 'quit', messages: [] }));
    const second = fakeDispatcher(async () => ({ kind: 'handled' }));
    gateway.attach(first);
    gateway.attach(second);
    const settlement = await gateway.dispatch('/help');
    expect(settlement).toEqual({
      kind: 'dispatched',
      outcome: { kind: 'handled' },
    });
    expect(second.handle).toHaveBeenCalledTimes(1);
  });
});
