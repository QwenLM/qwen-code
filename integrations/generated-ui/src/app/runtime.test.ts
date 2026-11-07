/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UiRuntime } from './runtime.js';
import type { UiEvent } from './runtime-contract.js';

let module: QuickJSWASMModule;
const runtimes: UiRuntime[] = [];

beforeAll(async () => {
  module = await newQuickJSWASMModuleFromVariant(variant);
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function createRuntime(): UiRuntime {
  const runtime = new UiRuntime(module);
  runtimes.push(runtime);
  return runtime;
}

function event(
  id = 'run',
  value = '',
  type: UiEvent['type'] = 'click',
): UiEvent {
  return { id, type, value, checked: false };
}

describe('UiRuntime', () => {
  it('initializes a capacity simulator and computes from the latest inputs', () => {
    const runtime = createRuntime();
    expect(
      runtime.initialize(
        `function calculate() {
          const servers = Number(ui.input('servers').value);
          ui.text('capacity', String(servers * 125));
        }
        ui.on('servers', 'input', calculate);
        calculate();`,
        { servers: { value: '2', checked: false } },
      ),
    ).toEqual([{ kind: 'text', id: 'capacity', value: '250' }]);
    expect(
      runtime.dispatch(event('servers', '5', 'input'), {
        servers: { value: '5', checked: false },
      }),
    ).toEqual({
      patches: [{ kind: 'text', id: 'capacity', value: '625' }],
      handled: true,
    });
  });

  it('supports a different comparison interaction with HTML and value patches', () => {
    const runtime = createRuntime();
    runtime.initialize(
      `ui.on('compare', 'click', function(event) {
        const costWeight = Number(ui.input('weight').value);
        const choice = 80 * costWeight + 40 * (1 - costWeight) > 65 ? 'A' : 'B';
        ui.html('ranking', '<strong>' + choice + '</strong>');
        ui.value('winner', choice);
        ui.text('trigger', event.id + ':' + event.type);
      });`,
      {},
    );
    expect(
      runtime.dispatch(event('compare'), {
        weight: { value: '0.75', checked: false },
      }),
    ).toEqual({
      patches: [
        { kind: 'html', id: 'ranking', value: '<strong>A</strong>' },
        { kind: 'value', id: 'winner', value: 'A' },
        { kind: 'text', id: 'trigger', value: 'compare:click' },
      ],
      handled: true,
    });
  });

  it('lets a reset handler read its new control value in the same event', () => {
    const runtime = createRuntime();
    runtime.initialize(
      `ui.on('reset', 'click', () => {
        ui.value('rate', '10');
        const input = ui.input('rate');
        ui.text('result', String(Number(input.value) * 2));
        ui.text('checked', String(input.checked));
      });`,
      {},
    );
    expect(
      runtime.dispatch(event('reset'), {
        rate: { value: '25', checked: true },
      }),
    ).toEqual({
      patches: [
        { kind: 'value', id: 'rate', value: '10' },
        { kind: 'text', id: 'result', value: '20' },
        { kind: 'text', id: 'checked', value: 'true' },
      ],
      handled: true,
    });
  });

  it('isolates activations and replaces a handler without multiplying callbacks', () => {
    const first = createRuntime();
    const second = createRuntime();
    first.initialize(
      `let count = 0;
       ui.on('run', 'click', () => ui.text('count', 'wrong'));
       ui.on('run', 'click', () => ui.text('count', String(++count)));`,
      {},
    );
    second.initialize(
      `ui.on('run', 'click', () => ui.text('count', 'other'));`,
      {},
    );
    expect(first.dispatch(event(), {})).toEqual({
      patches: [{ kind: 'text', id: 'count', value: '1' }],
      handled: true,
    });
    expect(second.dispatch(event(), {})).toEqual({
      patches: [{ kind: 'text', id: 'count', value: 'other' }],
      handled: true,
    });
    expect(first.dispatch(event('unknown'), {})).toEqual({
      patches: [],
      handled: false,
    });
    expect(first.dispatch(event(), {})).toEqual({
      patches: [{ kind: 'text', id: 'count', value: '2' }],
      handled: true,
    });
  });

  it('distinguishes an invoked empty handler from an unmatched event', () => {
    const runtime = createRuntime();
    runtime.initialize(
      `let calls = 0;
       ui.on('run', 'click', () => { calls++; });
       ui.on('inspect', 'click', () => ui.text('calls', String(calls)));`,
      {},
    );

    expect(runtime.dispatch(event('run', '', 'input'), {})).toEqual({
      patches: [],
      handled: false,
    });
    expect(runtime.dispatch(event(), {})).toEqual({
      patches: [],
      handled: true,
    });
    expect(runtime.dispatch(event('run', '', 'change'), {})).toEqual({
      patches: [],
      handled: false,
    });
    expect(runtime.dispatch(event(), {})).toEqual({
      patches: [],
      handled: true,
    });
    expect(runtime.dispatch(event('inspect'), {})).toEqual({
      patches: [{ kind: 'text', id: 'calls', value: '2' }],
      handled: true,
    });
  });

  it('does not accept guest objects or globals as execution metadata', () => {
    const runtime = createRuntime();
    runtime.initialize(
      `Object.prototype.handled = true;
       Object.prototype.execution = 'handled';
       Object.prototype.toJSON = () => ({handled: true, patches: []});
       Boolean.prototype.valueOf = () => { while (true) {} };
       Boolean.prototype.toJSON = () => false;
       JSON.parse = () => ({handled: true});
       JSON.stringify = () => 'forged';
       globalThis.handled = true;
       globalThis.execution = 'handled';
       globalThis.handlers = {'unknown:click': () => {}};
       ui.on('run', 'click', () => ({
         handled: false,
         execution: 'unhandled',
         patches: [{kind: 'text', id: 'forged', value: 'attack'}],
         toJSON() { while (true) {} },
         valueOf() { while (true) {} }
       }));`,
      {},
    );

    expect(runtime.dispatch(event('unknown'), {})).toEqual({
      patches: [],
      handled: false,
    });
    expect(runtime.dispatch(event(), {})).toEqual({
      patches: [],
      handled: true,
    });
    expect(runtime.dispatch(event('unknown'), {})).toEqual({
      patches: [],
      handled: false,
    });
  });

  it('has no browser, network, timer, process, filesystem or host messaging globals', () => {
    expect(
      createRuntime().initialize(
        `ui.text('globals', JSON.stringify([
          typeof document, typeof window, typeof fetch, typeof XMLHttpRequest,
          typeof WebSocket, typeof Worker, typeof setTimeout, typeof process,
          typeof require, typeof tools, typeof postMessage, typeof WebAssembly
        ]));`,
        {},
      ),
    ).toEqual([
      {
        kind: 'text',
        id: 'globals',
        value: JSON.stringify(Array(12).fill('undefined')),
      },
    ]);
  });

  it('drains finite microtasks during initialization and events', () => {
    const runtime = createRuntime();
    expect(
      runtime.initialize(
        `Promise.resolve().then(() => ui.text('status', 'ready'));
         ui.on('run', 'click', async () => {
           await Promise.resolve();
           ui.text('status', 'done');
         });`,
        {},
      ),
    ).toEqual([{ kind: 'text', id: 'status', value: 'ready' }]);
    expect(runtime.dispatch(event(), {})).toEqual({
      patches: [{ kind: 'text', id: 'status', value: 'done' }],
      handled: true,
    });
  });

  it.each([
    ['loop', 'while (true) {}', /time limit/],
    [
      'microtask loop',
      'function spin() { Promise.resolve().then(spin); } spin();',
      /microtask limit/,
    ],
    ['allocation', 'new ArrayBuffer(64 * 1024 * 1024);', /runtime limit/],
    ['recursion', '(function recur() { recur(); })();', /runtime limit/],
    [
      'patch flood',
      "for (let i = 0; i < 65; i++) ui.text('out', 'x');",
      /limit/,
    ],
    ['large text', "ui.text('out', 'x'.repeat(16000));", /limit/],
    ['UTF-8 text', "ui.text('out', '界'.repeat(6000));", /limit/],
    ['escaping text', "ui.text('out', '\\n'.repeat(8000));", /limit/],
    ['invalid ID', "ui.text('__proto__', 'x');", /limit/],
    ['invalid event type', "ui.on('out', 'message', () => {});", /limit/],
    [
      'non-string patch',
      "ui.text('out', {toString() { while (true) {} }});",
      /limit/,
    ],
    ['oversized control value', "ui.value('out', 'x'.repeat(2049));", /limit/],
  ])('stops %s and refuses subsequent execution', (_name, source, error) => {
    const runtime = createRuntime();
    expect(() => runtime.initialize(source, {})).toThrow(error);
    expect(() => runtime.dispatch(event(), {})).toThrow(/stopped/);
  });

  it('allows 256 microtask jobs and terminates a round needing one more', () => {
    const script = (count: number) => `
      let jobs = 0;
      function next() {
        if (++jobs < ${count}) Promise.resolve().then(next);
        else ui.text('out', String(jobs));
      }
      Promise.resolve().then(next);
    `;
    expect(createRuntime().initialize(script(256), {})).toEqual([
      { kind: 'text', id: 'out', value: '256' },
    ]);
    const exceeded = createRuntime();
    expect(() => exceeded.initialize(script(257), {})).toThrow(
      /microtask limit/,
    );
    expect(() => exceeded.dispatch(event(), {})).toThrow(/stopped/);
  });

  it('cannot catch and hide an output limit violation', () => {
    const runtime = createRuntime();
    expect(() =>
      runtime.initialize(
        `try { ui.text('out', 'x'.repeat(17000)); } catch {}
         try { ui.text('out', 'recovered'); } catch {}`,
        {},
      ),
    ).toThrow(/limit/);
    expect(() => runtime.dispatch(event(), {})).toThrow(/stopped/);
  });

  it('does not trust guest prototypes, JSON methods or conversion hooks', () => {
    const runtime = createRuntime();
    runtime.initialize(
      `Object.prototype.toJSON = () => ({kind: 'html', id: 'forged', value: 'attack'});
       String.prototype.toJSON = () => 'attack';
       Array.prototype.toJSON = () => [{kind: 'html', id: 'forged', value: 'attack'}];
       Object.prototype.fake = {value: 'forged', checked: true};
       String.prototype.charCodeAt = () => 0;
       JSON.stringify = () => 'attack';
       JSON.parse = () => ({run: {value: 'attack', checked: true}});
       Reflect.apply = () => 'attack';
       Object.create = () => globalThis;
       Object.prototype.hasOwnProperty = () => true;
       ui.on('run', 'click', () => {
         ui.text('out', ui.input('input').value);
         ui.text('missing', ui.input('fake').value);
       });`,
      {},
    );
    expect(
      runtime.dispatch(event(), { input: { value: 'safe', checked: false } }),
    ).toEqual({
      patches: [
        { kind: 'text', id: 'out', value: 'safe' },
        { kind: 'text', id: 'missing', value: '' },
      ],
      handled: true,
    });
    const attack = createRuntime();
    expect(() =>
      attack.initialize(
        `JSON.stringify = () => '';
         String.prototype.charCodeAt = () => 0;
         ui.text('out', '界'.repeat(6000));`,
        {},
      ),
    ).toThrow(/limit/);
  });

  it('does not dump or stringify a thrown guest object', () => {
    const runtime = createRuntime();
    expect(() =>
      runtime.initialize(
        `throw {
          get name() { while (true) {} },
          get message() { while (true) {} },
          toString() { return 'x'.repeat(1000000); },
          toJSON() { while (true) {} }
        };`,
        {},
      ),
    ).toThrow('Generated JavaScript failed or exceeded a runtime limit.');
  });

  it.each([
    `async () => { throw new Error('failure'); }`,
    `() => Promise.resolve().then(() => { throw new Error('failure'); })`,
    `() => Promise.reject({ get message() { while (true) {} } })`,
  ])(
    'stops when an event callback returns a rejected promise: %s',
    (handler) => {
      const runtime = createRuntime();
      runtime.initialize(`ui.on('run', 'click', ${handler});`, {});
      expect(() => runtime.dispatch(event(), {})).toThrow(
        /^Script error: Invalid UI operation or output limit exceeded/,
      );
      expect(() => runtime.dispatch(event(), {})).toThrow(/stopped/);
    },
  );

  it('lets promise handlers recover from ordinary errors', () => {
    const runtime = createRuntime();
    expect(
      runtime.initialize(
        `Promise.resolve().then(() => { throw new Error('failure'); })
           .catch(() => ui.text('out', 'recovered'));
         ui.on('run', 'click', () => Promise.reject(new Error('failure'))
           .catch(() => ui.text('out', 'handled')));`,
        {},
      ),
    ).toEqual([{ kind: 'text', id: 'out', value: 'recovered' }]);
    expect(runtime.dispatch(event(), {})).toEqual({
      patches: [{ kind: 'text', id: 'out', value: 'handled' }],
      handled: true,
    });
  });

  it('cannot hide a UI limit violation with a promise rejection handler', () => {
    const runtime = createRuntime();
    expect(() =>
      runtime.initialize(
        `Promise.resolve().then(() => ui.text('out', 'x'.repeat(17000)))
           .catch(() => {});`,
        {},
      ),
    ).toThrow(/^Script error: Invalid UI operation or output limit exceeded/);
    expect(() => runtime.dispatch(event(), {})).toThrow(/stopped/);
  });

  it.each([
    `Promise.resolve().then(() => { throw new Error('failure'); });`,
    `Promise.resolve().then(() => {}).then(() => null.x);`,
    `Promise.reject(new Error('failure'));`,
    `new Promise((_, reject) => reject(new Error('failure')));`,
    `(async () => { await 0; throw new Error('failure'); })();`,
  ])(
    'does not globally monitor independent promise rejections: %s',
    (source) => {
      const runtime = createRuntime();
      expect(
        runtime.initialize(
          `${source}
         ui.text('out', 'initial');
         ui.on('run', 'click', () => {
           ${source}
           ui.text('out', 'interactive');
         });`,
          {},
        ),
      ).toEqual([{ kind: 'text', id: 'out', value: 'initial' }]);
      for (let i = 0; i < 2; i++) {
        expect(runtime.dispatch(event(), {})).toEqual({
          patches: [{ kind: 'text', id: 'out', value: 'interactive' }],
          handled: true,
        });
      }
    },
  );

  it('validates input limits before copying data into the guest', () => {
    for (const inputs of [
      { bad: { value: 'x'.repeat(2049), checked: false } },
      Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [
          `input${i}`,
          { value: '', checked: false },
        ]),
      ),
      Object.fromEntries(
        Array.from({ length: 4 }, (_, i) => [
          `input${i}`,
          { value: '界'.repeat(2000), checked: false },
        ]),
      ),
    ]) {
      expect(() => createRuntime().initialize('', inputs)).toThrow(/input/i);
    }
  });

  it('requires exactly one initialization and makes disposal terminal', () => {
    const runtime = createRuntime();
    runtime.initialize('', {});
    expect(() => runtime.initialize('', {})).toThrow(/already initialized/);
    const stopped = createRuntime();
    stopped.dispose();
    stopped.dispose();
    expect(() => stopped.initialize('', {})).toThrow(/stopped/);
    expect(() => createRuntime().dispatch(event(), {})).toThrow(
      /not initialized/,
    );
  });
});
