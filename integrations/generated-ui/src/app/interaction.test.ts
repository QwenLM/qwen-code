/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createShowResult } from '../contracts.js';
import { ViewController } from './controller.js';
import { UiRuntime } from './runtime.js';
import type { UiWorkerRequest } from './runtime-contract.js';
import { ViewSurface } from './surface.js';

let module: QuickJSWASMModule;
const controllers: ViewController[] = [];
beforeAll(async () => {
  module = await newQuickJSWASMModuleFromVariant(variant);
});
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.stop()),
);

async function harness(
  javascript: string,
  html = '<input id="rate" type="number" value="20"><button id="resetButton">Reset</button><button id="calculate">Calculate</button><output id="answer"></output><output id="eventValue"></output>',
) {
  const frame = document.createElement('iframe');
  document.body.replaceChildren(frame);
  const content = frame.contentDocument!;
  const runtime = new UiRuntime(module);
  const requests: UiWorkerRequest[] = [];
  const worker = {
    onmessage: null as Worker['onmessage'],
    onerror: null as Worker['onerror'],
    postMessage: (request: UiWorkerRequest) => requests.push(request),
    terminate: () => runtime.dispose(),
  };
  const surface = new ViewSurface(
    frame,
    (event) => controller.event(event),
    (error) => controller.fail(error),
  );
  surface.mount = async (html, css) => {
    surface.attach(content, html, css);
    return surface.inputs();
  };
  const controller = new ViewController(
    surface,
    async () => worker,
    () => {},
    () => {},
  );
  controllers.push(controller);
  await controller.receive(
    createShowResult({
      title: 'Input ordering',
      summary: 'Synthetic double calculation.',
      html,
      css: '',
      javascript,
    }),
  );
  const deliver = () => {
    const request = requests.shift()!;
    const patches =
      request.type === 'init'
        ? runtime.initialize(request.javascript, request.inputs)
        : runtime.dispatch(request.event, request.inputs);
    Reflect.apply(worker.onmessage!, worker, [
      { data: { sequence: request.sequence, patches } },
    ]);
  };
  deliver();
  const input = content.getElementById('rate') as HTMLInputElement;
  const click = (id: string) =>
    content
      .getElementById(id)!
      .dispatchEvent(new Event('click', { bubbles: true }));
  const enter = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { content, input, click, enter, deliver };
}

describe('interactions while a worker response is pending', () => {
  it('recalculates from a preceding reset rather than the queued stale snapshot', async () => {
    const h = await harness(`
      function calculate() { ui.text('answer', String(Number(ui.input('rate').value) * 2)); }
      ui.on('resetButton', 'click', () => { ui.value('rate', '10'); calculate(); });
      ui.on('calculate', 'click', calculate);
      calculate();
    `);
    h.click('resetButton');
    h.click('calculate');
    h.deliver();
    h.deliver();
    expect(h.input.value).toBe('10');
    expect(h.content.getElementById('answer')!.textContent).toBe('20');
  });

  it('preserves a newer user edit when an older response normalizes the input', async () => {
    const h = await harness(`
      ui.on('rate', 'input', (event) => {
        const n = Number(ui.input('rate').value);
        ui.value('rate', String(n));
        ui.text('answer', String(n * 2));
        ui.text('eventValue', event.value);
      });
    `);
    h.enter('5');
    h.enter('50');
    h.deliver();
    expect(h.input.value).toBe('50');
    h.deliver();
    expect(h.input.value).toBe('50');
    expect(h.content.getElementById('answer')!.textContent).toBe('100');
    expect(h.content.getElementById('eventValue')!.textContent).toBe('50');
  });

  it("applies a round whose only queued event is the edit's own change notification", async () => {
    const h = await harness(`
      ui.on('rate', 'input', () => {
        const n = Number(ui.input('rate').value);
        ui.value('rate', String(n));
        ui.text('answer', String(n * 2));
      });
    `);
    h.enter('5');
    h.enter('50');
    h.input.dispatchEvent(new Event('change', { bubbles: true }));
    h.deliver();
    h.deliver();
    expect(h.input.value).toBe('50');
    expect(h.content.getElementById('answer')!.textContent).toBe('100');
    h.deliver();
    expect(h.content.getElementById('answer')!.textContent).toBe('100');
  });

  it('reads back a value set on a control created earlier in the same round', async () => {
    const h = await harness(
      `
      ui.on('calculate', 'click', () => {
        ui.html('eventValue', '<input id="fresh">');
        ui.value('fresh', '9');
        ui.text('answer', ui.input('fresh').value);
      });
    `,
      '<input id="rate" type="number" value="20"><button id="resetButton">Reset</button><button id="calculate">Calculate</button><output id="answer"></output><div id="eventValue"></div>',
    );
    h.click('calculate');
    h.deliver();
    const fresh = h.content.getElementById('fresh') as HTMLInputElement;
    expect(fresh.value).toBe('9');
    expect(h.content.getElementById('answer')!.textContent).toBe('9');
  });

  it('discards all outputs derived from a value superseded by a queued edit', async () => {
    const h = await harness(`
      function calculate() { ui.text('answer', String(Number(ui.input('rate').value) * 2)); }
      ui.on('resetButton', 'click', () => {
        ui.value('rate', '10');
        calculate();
        ui.html('eventValue', '<strong>Reset to 10</strong>');
      });
      ui.on('calculate', 'click', calculate);
      calculate();
    `);
    h.click('resetButton');
    h.enter('7');
    h.deliver();
    h.deliver();
    expect(h.input.value).toBe('7');
    expect(h.content.getElementById('answer')!.textContent).toBe('40');
    expect(h.content.getElementById('eventValue')!.textContent).toBe('');
    h.click('calculate');
    h.deliver();
    expect(h.content.getElementById('answer')!.textContent).toBe('14');
  });
});
