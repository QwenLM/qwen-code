/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShowResult } from '../contracts.js';
import { ViewController } from './controller.js';
import type { UiWorkerResponse } from './runtime-contract.js';

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
    apply: vi.fn(),
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
  const reply = (data: UiWorkerResponse) => {
    if (worker.onmessage) Reflect.apply(worker.onmessage, worker, [{ data }]);
  };
  return { controller, worker, surface, createWorker, onStatus, reply };
}

afterEach(() => vi.useRealTimers());

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
    h.reply({ sequence: 1, patches: [] });
    expect(h.worker.postMessage).toHaveBeenLastCalledWith({
      type: 'event',
      sequence: 2,
      event,
      inputs,
    });
    h.reply({ sequence: 1, patches: [] });
    expect(h.surface.apply).toHaveBeenCalledTimes(1);
    h.reply({
      sequence: 2,
      patches: [{ kind: 'text', id: 'answer', value: '14' }],
    });
    h.reply({ sequence: 2, patches: [] });
    expect(h.surface.apply).toHaveBeenCalledTimes(2);
    h.controller.stop();
  });

  it.each(['startup', 'event'])(
    'ignores queue overflow during %s without ending the activation',
    async (phase) => {
      vi.useFakeTimers();
      const h = harness();
      await h.controller.receive(createShowResult(document));
      let sequence = 1;
      if (phase === 'event') {
        h.reply({ sequence: sequence++, patches: [] });
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

      h.reply({ sequence: sequence++, patches: [] });
      for (let index = 0; index < 16; index++) {
        expect(h.worker.postMessage).toHaveBeenLastCalledWith({
          type: 'event',
          sequence,
          event: { ...event, type: types[index % types.length] },
          inputs,
        });
        h.reply({ sequence: sequence++, patches: [] });
      }
      expect(h.worker.postMessage).toHaveBeenCalledTimes(sent + 16);
      expect(h.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));

      h.controller.event(event);
      expect(h.worker.postMessage).toHaveBeenCalledTimes(sent + 17);
      h.reply({ sequence, patches: [] });
      expect(h.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
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
      'error',
      expect.stringContaining('changed'),
    );
  });

  it('does not revive after Stop before a late final', async () => {
    const h = harness();
    h.controller.stop();
    await h.controller.receive(createShowResult(document));
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.surface.mount).not.toHaveBeenCalled();
    expect(h.onStatus).toHaveBeenLastCalledWith('stopped', expect.any(String));
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
      'error',
      expect.stringContaining('time limit'),
    );
    const active = harness();
    await active.controller.receive(createShowResult(document));
    active.reply({ sequence: 1, patches: [] });
    active.controller.event(event);
    vi.advanceTimersByTime(1_000);
    expect(active.worker.terminate).toHaveBeenCalledOnce();
    active.reply({ sequence: 2, patches: [] });
    expect(active.surface.apply).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid snapshots and failed rendering without running code', async () => {
    const invalid = harness();
    await invalid.controller.receive({ content: [] });
    expect(invalid.createWorker).not.toHaveBeenCalled();
    expect(invalid.onStatus).toHaveBeenLastCalledWith(
      'error',
      expect.any(String),
    );
    const render = harness();
    render.surface.mount.mockRejectedValue(new Error('Unsupported input.'));
    await render.controller.receive(createShowResult(document));
    expect(render.worker.terminate).toHaveBeenCalledOnce();
    expect(render.worker.postMessage).not.toHaveBeenCalled();
    expect(render.onStatus).toHaveBeenLastCalledWith(
      'error',
      'Unsupported input.',
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
      'error',
      'Execution budget exceeded.',
    );
  });

  it('starts a new independent activation when a card is remounted', async () => {
    const old = harness();
    await old.controller.receive(createShowResult(document));
    old.controller.stop();
    const restored = harness();
    await restored.controller.receive(createShowResult(document));
    expect(restored.worker.postMessage).toHaveBeenCalledTimes(1);
    restored.controller.stop();
  });
});
