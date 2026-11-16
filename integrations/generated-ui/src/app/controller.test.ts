/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShowResult } from '../contracts.js';
import { ViewController, type ViewState } from './controller.js';
import type { UiWorkerResponse } from './runtime-contract.js';
import type { ApplyOutcome } from './surface.js';

const document = {
  title: 'Capacity',
  summary: 'Synthetic capacity estimate.',
  html: '<input id="rate" value="5"><output id="answer"></output>',
  css: '',
  javascript: 'ui.text("answer", String(Number(ui.input("rate").value) * 2));',
};
const event = {
  id: 'rate',
  type: 'input' as const,
  value: '7',
  checked: false,
};
const inputs = { rate: { value: '7', checked: false } };
const controllers: ViewController[] = [];

function harness() {
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null as Worker['onmessage'],
    onerror: null as Worker['onerror'],
  };
  const surface = {
    mount: vi.fn().mockResolvedValue(inputs),
    inputs: vi.fn().mockReturnValue(inputs),
    apply: vi.fn(
      (): ApplyOutcome => ({
        kind: 'applied' as const,
        inputs: surface.inputs(),
      }),
    ),
    stop: vi.fn(),
  };
  const createWorker = vi.fn().mockResolvedValue(worker);
  const onStatus = vi.fn();
  const controller = new ViewController(
    surface,
    createWorker,
    vi.fn(),
    onStatus,
  );
  controllers.push(controller);
  const reply = (data: UiWorkerResponse) => {
    if (worker.onmessage) Reflect.apply(worker.onmessage, worker, [{ data }]);
  };
  const complete = (
    sequence = worker.postMessage.mock.lastCall![0].sequence as number,
    execution: 'initialized' | 'handled' | 'unhandled' = sequence === 1
      ? 'initialized'
      : 'handled',
  ) => reply({ sequence, patches: [], execution });
  const state = () => onStatus.mock.lastCall![0] as ViewState;
  return {
    controller,
    worker,
    surface,
    createWorker,
    onStatus,
    reply,
    complete,
    state,
  };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.stop());
  vi.useRealTimers();
});

describe('one generated view activation', () => {
  it('executes only the first final, keeps event order and ignores duplicate replies', async () => {
    const h = harness();
    const result = createShowResult(document);
    await h.controller.receive(result);
    await h.controller.receive(result);
    expect(h.createWorker).toHaveBeenCalledTimes(1);
    expect(h.worker.postMessage).toHaveBeenCalledTimes(1);
    h.controller.event(event);
    expect(h.worker.postMessage).toHaveBeenCalledTimes(1);
    h.complete(1);
    expect(h.worker.postMessage).toHaveBeenLastCalledWith({
      type: 'event',
      sequence: 2,
      event,
      inputs,
    });
    h.complete(1);
    expect(h.surface.apply).toHaveBeenCalledTimes(1);
    h.reply({
      sequence: 2,
      execution: 'handled',
      patches: [{ kind: 'text', id: 'answer', value: '14' }],
    });
    h.complete(2);
    expect(h.surface.apply).toHaveBeenCalledTimes(2);
    h.controller.stop();
  });

  it.each(['startup', 'event'])(
    'reports queue overflow during %s without ending the activation',
    async (phase) => {
      vi.useFakeTimers();
      const h = harness();
      await h.controller.receive(createShowResult(document));
      let sequence = 1;
      if (phase === 'event') {
        h.complete(sequence++);
        h.controller.event(event);
      }
      const sent = h.worker.postMessage.mock.calls.length;
      const types = ['click', 'input', 'change'] as const;
      for (let click = 0; click < 6; click++) {
        for (const type of types) h.controller.event({ ...event, type });
      }
      expect(h.worker.postMessage).toHaveBeenCalledTimes(sent);
      expect(h.worker.terminate).not.toHaveBeenCalled();
      expect(h.surface.stop).not.toHaveBeenCalled();

      h.complete(sequence++);
      for (let index = 0; index < 16; index++) {
        expect(h.worker.postMessage).toHaveBeenLastCalledWith({
          type: 'event',
          sequence,
          event: { ...event, type: types[index % types.length] },
          inputs,
        });
        h.complete(sequence++);
      }
      expect(h.worker.postMessage).toHaveBeenCalledTimes(sent + 16);
      expect(h.state()).toMatchObject({ phase: 'ready', rejectedEvents: 2 });

      h.controller.event(event);
      expect(h.worker.postMessage).toHaveBeenCalledTimes(sent + 17);
      h.complete(sequence);
      expect(h.state()).toMatchObject({ phase: 'ready', rejectedEvents: 2 });
      expect(h.worker.terminate).not.toHaveBeenCalled();
      h.controller.stop();
    },
  );

  it('rejects a different document within one activation', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    await h.controller.receive(
      createShowResult({ ...document, title: 'Other' }),
    );
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    expect(h.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'error',
        error: expect.stringContaining('changed'),
      }),
    );
  });

  it('does not revive after Stop before a late final', async () => {
    const h = harness();
    h.controller.stop();
    await h.controller.receive(createShowResult(document));
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.surface.mount).not.toHaveBeenCalled();
    expect(h.state().phase).toBe('stopped');
  });

  it('terminates a worker that finishes creation after cancellation', async () => {
    const h = harness();
    let resolve!: (worker: typeof h.worker) => void;
    h.createWorker.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = h.controller.receive(createShowResult(document));
    h.controller.stop();
    resolve(h.worker);
    await pending;
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    expect(h.worker.postMessage).not.toHaveBeenCalled();
  });

  it('terminates startup or a stuck event, leaving an observable failure', async () => {
    vi.useFakeTimers();
    const initial = harness();
    await initial.controller.receive(createShowResult(document));
    vi.advanceTimersByTime(5_000);
    expect(initial.worker.terminate).toHaveBeenCalledOnce();
    expect(initial.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'error',
        error: expect.stringContaining('time limit'),
      }),
    );
    const active = harness();
    await active.controller.receive(createShowResult(document));
    active.complete(1);
    active.controller.event(event);
    vi.advanceTimersByTime(1_000);
    expect(active.worker.terminate).toHaveBeenCalledOnce();
    active.complete(2);
    expect(active.surface.apply).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid snapshots and failed rendering without running code', async () => {
    const invalid = harness();
    await invalid.controller.receive({ content: [] });
    expect(invalid.createWorker).not.toHaveBeenCalled();
    expect(invalid.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'error', error: expect.any(String) }),
    );
    const render = harness();
    render.surface.mount.mockRejectedValue(new Error('Unsupported input.'));
    await render.controller.receive(createShowResult(document));
    expect(render.worker.terminate).toHaveBeenCalledOnce();
    expect(render.worker.postMessage).not.toHaveBeenCalled();
    expect(render.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'error', error: 'Unsupported input.' }),
    );
  });

  it('drops queued events and stale callbacks after a runtime error', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    const stale = h.worker.onmessage!;
    h.controller.event(event);
    h.reply({ sequence: 1, error: 'Execution budget exceeded.' });
    Reflect.apply(stale, h.worker, [{ data: { sequence: 1, patches: [] } }]);
    expect(h.surface.apply).not.toHaveBeenCalled();
    expect(h.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    expect(h.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'error',
        error: 'Execution budget exceeded.',
      }),
    );
  });

  it('starts a new independent activation when a card is remounted', async () => {
    const old = harness();
    await old.controller.receive(createShowResult(document));
    old.complete();
    const previous = old.controller.captureSnapshot();
    old.controller.stop();
    const restored = harness();
    await restored.controller.receive(createShowResult(document));
    expect(restored.worker.postMessage).toHaveBeenCalledTimes(1);
    restored.complete();
    const current = restored.controller.captureSnapshot();
    expect(previous.ok && current.ok).toBe(true);
    if (previous.ok && current.ok) {
      expect(current.snapshot.documentId).toBe(previous.snapshot.documentId);
      expect(current.snapshot.activationId).not.toBe(
        previous.snapshot.activationId,
      );
    }
    expect(old.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'stopped',
    });
    expect(restored.controller.captureSnapshot().ok).toBe(true);
    restored.controller.stop();
  });
});

describe('current applied parameter snapshots', () => {
  it('returns not-ready before initialization without reading an unavailable surface', async () => {
    const h = harness();
    expect(h.controller.event(event)).toBe('ignored-not-ready');
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'not-ready',
    });
    expect(h.surface.inputs).not.toHaveBeenCalled();
    const receiving = h.controller.receive(createShowResult(document));
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'not-ready',
    });
    expect(h.surface.inputs).not.toHaveBeenCalled();
    await receiving;
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'not-ready',
    });
    h.complete();
    expect(h.controller.captureSnapshot().ok).toBe(true);
  });

  it('freezes a detached snapshot and observes edits even without an input event', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete();
    const result = h.controller.captureSnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a current snapshot.');
    expect(result.snapshot).toMatchObject({
      schemaVersion: 1,
      appliedSequence: 1,
      baseInputRevision: 0,
      inputRevision: 0,
      inputs,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.inputs)).toBe(true);
    expect(
      Reflect.set(result.snapshot.inputs['rate'], 'value', 'altered'),
    ).toBe(false);
    h.surface.inputs.mockReturnValue({ rate: { value: '8', checked: false } });
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'dirty',
    });
    expect(h.state().phase).toBe('dirty');
    expect(result.snapshot.inputs['rate'].value).toBe('7');
  });

  it('keeps button-only edits dirty until a current handler completes', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete();
    h.surface.inputs.mockReturnValue({ rate: { value: '8', checked: false } });
    expect(h.controller.event(event)).toBe('accepted');
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'busy',
    });
    h.complete(2, 'unhandled');
    expect(h.state().phase).toBe('dirty');
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'dirty',
    });
    h.controller.event({ ...event, type: 'click' });
    h.complete();
    expect(h.controller.captureSnapshot()).toMatchObject({
      ok: true,
      snapshot: {
        appliedSequence: 3,
        inputRevision: 1,
        inputs: { rate: { value: '8' } },
      },
    });
  });

  it('retains a valid candidate across same-value unhandled change notifications', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete();
    const previous = h.controller.captureSnapshot();
    h.controller.event({ ...event, type: 'change' });
    h.complete(2, 'unhandled');
    expect(h.controller.captureSnapshot()).toEqual(previous);
    expect(h.state()).toMatchObject({ phase: 'ready', lastUpdate: 'applied' });
  });

  it.each(['applied', 'superseded'] as const)(
    'does not promote a stale %s round or clear its notice on an unhandled reply',
    async (kind) => {
      const h = harness();
      await h.controller.receive(createShowResult(document));
      h.complete();
      h.controller.event({ ...event, type: 'click' });
      const newer = { rate: { value: '8', checked: false } };
      h.surface.inputs.mockReturnValue(newer);
      h.controller.event(event);
      h.surface.apply.mockReturnValueOnce({ kind, inputs: newer });
      h.onStatus.mockClear();
      h.complete(2);
      expect(h.onStatus.mock.calls.map(([state]) => state.phase)).toEqual([
        'running',
      ]);
      const lastUpdate = kind === 'applied' ? 'outdated' : 'superseded';
      expect(h.state()).toMatchObject({ lastUpdate, viewAvailable: true });
      h.complete(3, 'unhandled');
      expect(h.state()).toMatchObject({ phase: 'dirty', lastUpdate });
      expect(h.controller.captureSnapshot()).toEqual({
        ok: false,
        reason: 'dirty',
      });
      h.controller.event({ ...event, type: 'click' });
      h.complete();
      expect(h.state()).toMatchObject({
        phase: 'ready',
        lastUpdate: 'applied',
      });
    },
  );

  it('distinguishes ABA edits from a same-value trailing notification', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete();
    h.controller.event({ ...event, type: 'click' });
    h.surface.inputs.mockReturnValue({ rate: { value: '8', checked: false } });
    h.controller.event(event);
    h.surface.inputs.mockReturnValue(inputs);
    expect(h.controller.event(event)).toBe('coalesced');
    h.complete(2);
    h.complete(3, 'unhandled');
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'dirty',
    });
    h.controller.event({ ...event, type: 'click' });
    h.complete();
    expect(h.controller.captureSnapshot()).toMatchObject({
      ok: true,
      snapshot: { baseInputRevision: 2, inputRevision: 2, inputs },
    });
  });

  it('captures the normalized post-apply values rather than dispatch values', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete();
    h.controller.event(event);
    const normalized = { rate: { value: '100', checked: false } };
    h.surface.apply.mockImplementationOnce(() => {
      h.surface.inputs.mockReturnValue(normalized);
      return { kind: 'applied', inputs: normalized };
    });
    h.complete();
    expect(h.controller.captureSnapshot()).toMatchObject({
      ok: true,
      snapshot: { baseInputRevision: 0, inputRevision: 1, inputs: normalized },
    });
    expect(h.worker.postMessage.mock.lastCall![0].inputs).toEqual(inputs);
  });

  it('compares checked values and control membership without relying on property order', async () => {
    const h = harness();
    const controls = {
      rate: inputs.rate,
      selected: { value: 'A', checked: true },
    };
    h.surface.mount.mockResolvedValue(controls);
    h.surface.inputs.mockReturnValue(controls);
    await h.controller.receive(createShowResult(document));
    h.complete();
    h.surface.inputs.mockReturnValue({
      selected: controls.selected,
      rate: inputs.rate,
    });
    expect(h.controller.captureSnapshot()).toMatchObject({
      ok: true,
      snapshot: { inputRevision: 0 },
    });
    h.surface.inputs.mockReturnValue({
      ...controls,
      selected: { value: 'A', checked: false },
    });
    h.controller.event(event);
    h.complete();
    expect(h.controller.captureSnapshot()).toMatchObject({
      ok: true,
      snapshot: { inputRevision: 1 },
    });
    h.surface.inputs.mockReturnValue(inputs);
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'dirty',
    });
  });

  it('observes rejected edits, still coalesces a full queue, and retains its rejection count', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete();
    h.controller.event({ ...event, type: 'click' });
    for (let index = 0; index < 15; index++)
      expect(h.controller.event({ ...event, type: 'click' })).toBe('accepted');
    expect(h.controller.event(event)).toBe('accepted');
    h.surface.inputs.mockReturnValue({ rate: { value: '8', checked: false } });
    expect(h.controller.event(event)).toBe('coalesced');
    h.surface.inputs.mockReturnValue({ rate: { value: '9', checked: false } });
    expect(h.controller.event({ ...event, type: 'change' })).toBe(
      'rejected-full',
    );
    expect(h.state()).toMatchObject({ phase: 'running', rejectedEvents: 1 });
    h.complete(2);
    for (let sequence = 3; sequence <= 18; sequence++)
      h.complete(sequence, 'unhandled');
    expect(h.worker.postMessage).toHaveBeenCalledTimes(18);
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'dirty',
    });
    h.controller.event({ ...event, type: 'click' });
    h.complete();
    expect(h.controller.captureSnapshot()).toMatchObject({
      ok: true,
      rejectedEvents: 1,
    });
    expect(h.state()).toMatchObject({ phase: 'ready', rejectedEvents: 1 });
  });

  it('makes a validated but superseded initialization visible without a current candidate', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    const newer = { rate: { value: '8', checked: false } };
    h.surface.inputs.mockReturnValue(newer);
    h.surface.apply.mockReturnValueOnce({ kind: 'superseded', inputs: newer });
    h.complete();
    expect(h.state()).toMatchObject({
      phase: 'dirty',
      viewAvailable: true,
      lastUpdate: 'superseded',
    });
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'dirty',
    });
  });

  it('does not extend a watchdog when events arrive or an unrelated response is received', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete();
    h.controller.event(event);
    vi.advanceTimersByTime(500);
    h.controller.event(event);
    h.complete(99);
    vi.advanceTimersByTime(500);
    expect(h.state().phase).toBe('error');
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'error',
    });
    expect(h.worker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects malformed execution metadata before applying it', async () => {
    const h = harness();
    await h.controller.receive(createShowResult(document));
    h.complete(1, 'unhandled');
    expect(h.surface.apply).not.toHaveBeenCalled();
    expect(h.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  it('does not offer an active snapshot when the surface stopped or cannot be read', async () => {
    const stopped = harness();
    await stopped.controller.receive(createShowResult(document));
    stopped.surface.apply.mockReturnValueOnce({ kind: 'stopped' });
    stopped.complete();
    expect(stopped.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'stopped',
    });
    expect(stopped.controller.event(event)).toBe('ignored-terminal');
    const unreadable = harness();
    await unreadable.controller.receive(createShowResult(document));
    unreadable.complete();
    unreadable.surface.inputs.mockImplementationOnce(() => {
      throw new Error('Input limit');
    });
    expect(unreadable.controller.captureSnapshot()).toEqual({
      ok: false,
      reason: 'error',
    });
    expect(unreadable.worker.terminate).toHaveBeenCalledOnce();
  });
});
