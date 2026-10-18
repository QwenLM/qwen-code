/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModRuntime } from './runtime.js';
import type { ModLog, ModOptions } from './types.js';

const signal = () => new AbortController().signal;
const fixture = (
  handler = "return { text: String(++count) + ':' + e.args };",
) => `
  let count = 0;
  export async function register(on) {
    await Promise.resolve();
    on('session.start', async ($, e, next) => {
      const registration = await $.command.register({name:'hello',description:'Hello'});
      $.ui.log('start:' + registration.command + ':' + e.surface + ':' + e.isInteractive);
      return next(e);
    });
    on('command.run', {command:'hello'}, async ($, e, next) => { ${handler} });
    on('session.end', ($, e, next) => {
      $.ui.log('end:' + e.reason + ':' + e.sessionId + ':' + e.resume.id);
      return next(e);
    });
  }
`;

describe('ModRuntime with the real QuickJS worker', () => {
  const runtimes: ModRuntime[] = [];
  const logs: ModLog[] = [];
  const create = async (
    source = fixture(),
    abort = signal(),
    options: ModOptions = {},
  ) => {
    const runtime = await ModRuntime.create(
      { root: '/fixture', entry: '/fixture/mod.js', source },
      '/workspace',
      (log) => logs.push(log),
      abort,
      options,
    );
    runtimes.push(runtime);
    return runtime;
  };
  const createTerminal = async (sources = [fixture()]) => {
    const runtime = await ModRuntime.createGroup(
      sources.map((source, index) => ({
        id: `mod-${index}`,
        name: `mod-${index}`,
        source: { root: '/fixture', entry: '/fixture/mod.js', source },
        options: {},
      })),
      '/workspace',
      (log) => logs.push(log),
      signal(),
      undefined,
      'terminal',
    );
    runtimes.push(runtime);
    return runtime;
  };

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    logs.length = 0;
  });

  it('awaits register/start, retains closure state, and ends without reloading', async () => {
    const runtime = await create();
    expect(runtime.getCommands()).toEqual([
      { name: 'hello', description: 'Hello' },
    ]);
    expect(logs).toEqual([
      { to: 'transcript', text: 'start:hello:null:false' },
    ]);
    expect(await runtime.runCommand('hello', 'one', signal())).toBe('1:one');
    await runtime.end('old', 'clear', signal());
    expect(await runtime.runCommand('hello', 'two', signal())).toBe('2:two');
    await runtime.end('new', 'other', signal());
    expect(logs.map((log) => log.text)).toEqual([
      'start:hello:null:false',
      'end:clear:old:old',
      'end:other:new:new',
    ]);
  });

  it('uses terminal identity and current presentation while allowing argument middleware', async () => {
    const runtime = await createTerminal([
      `export function register(on) {
        on('command.run', ($, e, next) => next({...e, args:'changed:' + e.args}));
      }`,
      fixture('return {text: JSON.stringify(e)};'),
    ]);
    expect(logs).toEqual([
      { to: 'transcript', text: 'start:hello:terminal:true' },
    ]);
    for (const presentation of [
      { isFullscreen: false, columns: 81 },
      { isFullscreen: true, columns: 144 },
    ]) {
      expect(
        JSON.parse(
          await runtime.runCommand('hello', 'input', signal(), presentation),
        ),
      ).toEqual({
        command: 'hello',
        args: 'changed:input',
        origin: { kind: 'composer' },
        presentation,
      });
    }
    await runtime.end('old', 'clear', signal());
    expect(
      await runtime.runCommand('hello', 'after-clear', signal()),
    ).toContain('changed:after-clear');
    expect(logs.filter((log) => log.text.startsWith('start:'))).toHaveLength(1);
  });

  it('preserves headless identity and presentation defaults', async () => {
    const runtime = await create(fixture('return {text: JSON.stringify(e)};'));
    expect(
      JSON.parse(
        await runtime.runCommand('hello', 'headless', signal(), {
          isFullscreen: true,
          columns: 144,
        }),
      ),
    ).toEqual({
      command: 'hello',
      args: 'headless',
      origin: { kind: 'sdk' },
      presentation: { isFullscreen: false, columns: 80 },
    });
    expect(logs).toEqual([
      { to: 'transcript', text: 'start:hello:null:false' },
    ]);
  });

  it.each(['surface:null', 'isInteractive:false'])(
    'pins terminal startup identity: %s',
    async (change) => {
      const runtime = await createTerminal([
        `export function register(on) {
          on('session.start', ($, e, next) => next({...e, ${change}}));
        }`,
        fixture(),
      ]);
      expect(logs).toContainEqual({
        to: 'debug',
        text: expect.stringContaining('pinned event fields'),
      });
      expect(logs).toContainEqual({
        to: 'transcript',
        text: 'start:hello:terminal:true',
      });
      expect(await runtime.runCommand('hello', '', signal())).toBe('1:');
    },
  );

  it.each([
    "origin:{kind:'sdk'}",
    'presentation:{isFullscreen:false,columns:80}',
  ])('pins terminal command identity and presentation: %s', async (change) => {
    const runtime = await createTerminal([
      `export function register(on) {
        on('command.run', ($, e, next) => next({...e, ${change}}));
      }`,
      fixture('return {text: JSON.stringify(e)};'),
    ]);
    expect(
      JSON.parse(
        await runtime.runCommand('hello', '', signal(), {
          isFullscreen: true,
          columns: 144,
        }),
      ),
    ).toEqual({
      command: 'hello',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 144 },
    });
    expect(logs).toContainEqual({
      to: 'debug',
      text: expect.stringContaining('pinned event fields'),
    });
  });

  it.each(['tool.call', 'tool.check', 'tool.*'])(
    'rejects terminal %s registrations before any plugin starts',
    async (event) => {
      await expect(
        createTerminal([
          fixture(),
          `export function register(on) {
            on('${event}', ($, e, next) => next(e));
          }`,
        ]),
      ).rejects.toThrow(`${event} is not supported in terminal sessions`);
      expect(logs).toEqual([]);
    },
  );

  it.each(['*', '!session.*', '!tool.call'])(
    'limits terminal %s subscriptions with a visible diagnostic',
    async (pattern) => {
      const runtime = await createTerminal([
        `export function register(on) {
          on('${pattern}', ($, e, next) => next(
            typeof e.args === 'string' ? {...e, args:'observed:' + e.args} : e
          ));
        }`,
        fixture(),
      ]);
      expect(runtime.hasToolHooks).toBe(false);
      expect(logs).toEqual([
        {
          to: 'transcript',
          text: expect.stringContaining(
            'tool.call and tool.check are not supported',
          ),
        },
        { to: 'transcript', text: 'start:hello:terminal:true' },
      ]);
      expect(await runtime.runCommand('hello', 'input', signal())).toBe(
        '1:observed:input',
      );
      const next = vi.fn(async () => ({ result: 'unexpected' }));
      await expect(
        runtime.runTool(
          { tool: 'write_file', tool_use_id: 'call-1', path: '/unused' },
          next,
          signal(),
        ),
      ).rejects.toThrow(/not supported in terminal sessions/);
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('does not warn for terminal patterns that exclude tool events', async () => {
    const runtime = await createTerminal([
      `export function register(on) {
        on('!tool.*', ($, e, next) => next(e));
      }`,
      fixture(),
    ]);
    expect(runtime.hasToolHooks).toBe(false);
    expect(logs).toEqual([
      { to: 'transcript', text: 'start:hello:terminal:true' },
    ]);
    expect(await runtime.runCommand('hello', '', signal())).toBe('1:');
  });

  it('isolates globals and state between plugins without Node capabilities', async () => {
    const one = await create(
      fixture(
        `globalThis.secret = 'one'; return {text: [typeof process, typeof require, typeof fetch, new Function('return typeof process')()].join(',')};`,
      ),
    );
    const two = await create(
      fixture(`return { text: typeof globalThis.secret };`),
    );
    expect(await one.runCommand('hello', '', signal())).toBe(
      'undefined,undefined,undefined,undefined',
    );
    expect(await two.runCommand('hello', '', signal())).toBe('undefined');
  });

  it('ignores a registration object returned from register', async () => {
    const runtime = await create(`export function register(on) {
      return on('session.start', ($, e, next) => next(e));
    }`);
    expect(runtime.getCommands()).toEqual([]);
  });

  it('suspends detached guest jobs between requests without losing logs or state', async () => {
    const runtime = await create(
      fixture(`
        if (e.args === 'start') {
          void (async () => { for (;;) { await null; count++; } })();
          $.ui.log('queued'); return {text:'started'};
        }
        return {text:String(count)};
      `),
    );
    expect(await runtime.runCommand('hello', 'start', signal())).toBe(
      'started',
    );
    expect(logs.some((log) => log.text === 'queued')).toBe(true);
    let previous = Number(
      await runtime.runCommand('hello', 'inspect', signal()),
    );
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const current = Number(
        await runtime.runCommand('hello', 'inspect', signal()),
      );
      expect(current - previous).toBeLessThan(1000);
      previous = current;
    }
  });

  it('allows repeated next calls with equivalent frozen lifecycle input', async () => {
    const runtime = await create(`export function register(on) {
      on('session.start', async ($, e, next) => {
        if (!Object.isFrozen(e)) throw new Error('not frozen');
        const a = await next(e); const b = await next({...e});
        if (a.cwd !== b.cwd) throw new Error('repeat failed');
        await $.command.register({name:'hello',description:'ok'});
        return b;
      });
      on('command.run',{command:'hello'},() => ({}));
    }`);
    expect(await runtime.runCommand('hello', '', signal())).toBe('');
  });

  it.each([
    ['missing export', 'export const other = 1;', /export register/],
    [
      'imports',
      "import fs from 'node:fs'; export function register() {}",
      /relative static/,
    ],
    [
      'unknown event',
      "export function register(on) { on('model.request', () => ({})); }",
      /event not supported/,
    ],
  ])(
    'rejects %s without leaving a usable failed runtime',
    async (_name, source, error) => {
      let runtime: ModRuntime | undefined;
      await expect(
        (async () => {
          runtime = await create(source);
          await runtime.runCommand('hello', '', signal());
        })(),
      ).rejects.toThrow(error);
      if (runtime)
        await expect(
          runtime.runCommand('hello', '', signal()),
        ).rejects.toThrow();
    },
  );

  it.each(['while (true) {}', 'await new Promise(() => {});'])(
    'cancels a worker executing %s',
    async (body) => {
      const runtime = await create(
        fixture(`if (e.args === 'ok') return {text:'alive'}; ${body}`),
      );
      const started = Date.now();
      await expect(
        runtime.runCommand('hello', '', AbortSignal.timeout(100)),
      ).rejects.toThrow(/cancelled/);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await runtime.runCommand('hello', 'ok', signal())).toBe('alive');
    },
  );

  it('bounds registration even if it never resolves', async () => {
    await expect(
      create(
        'export async function register() { await new Promise(() => {}); }',
        AbortSignal.timeout(1500),
      ),
    ).rejects.toThrow(/cancelled/);
  });

  it('passes a frozen JSON copy of options into register', async () => {
    const options = { label: 'original', tags: ['one'] };
    const runtime = await create(
      `export function register(on, options) {
      if (!Object.isFrozen(options) || !Object.isFrozen(options.tags)) throw new Error('unfrozen');
      on('session.start', async ($, e, next) => { await $.command.register({name:'hello',description:'options'}); return next(e); });
      on('command.run', {command:'hello'}, () => ({ text: options.label + ':' + options.tags.join(',') }));
    }`,
      signal(),
      options,
    );
    options.label = 'changed';
    options.tags.push('two');
    expect(await runtime.runCommand('hello', '', signal())).toBe(
      'original:one',
    );
  });

  it('bounds logs and applies a whole session.end timeout', async () => {
    const noisy = await create(
      fixture(
        "for (let i=0;i<1000;i++) $.ui.log('x'.repeat(1000)); return {};",
      ),
    );
    expect(await noisy.runCommand('hello', '', signal())).toBe('');
    expect(logs.length).toBeLessThan(105);
    const hanging = await create(`export function register(on) {
      on('session.end', async () => { await new Promise(() => {}); });
    }`);
    const started = Date.now();
    await expect(hanging.end('session', 'other', signal())).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
