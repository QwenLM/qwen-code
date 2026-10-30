/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModRuntime } from './runtime.js';
import {
  MOD_MAX_BYTES,
  type ModLog,
  type ModOptions,
  type ModSessionFacts,
} from './types.js';
import type { ModToolNext } from './tool-events.js';

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

  it.each([
    'tool.call',
    'tool.check',
    'tool.*',
    '*',
    '!session.*',
    '!tool.call',
  ])(
    'dispatches terminal %s subscriptions through the real worker',
    async (pattern) => {
      const runtime = await createTerminal([
        `export function register(on) {
          on('${pattern}', ($, e, next) => {
            $.ui.log('observed:' + ('input' in e ? 'check' : 'call'));
            return next(e);
          });
        }`,
        fixture(),
      ]);
      expect(runtime.hasToolHooks).toBe(true);
      expect(logs.map((log) => log.text).join('\n')).not.toContain(
        'not supported',
      );
      logs.length = 0;
      const next = vi.fn<ModToolNext>(async (changed, active, check) => ({
        result: await check(
          {
            tool: changed.tool,
            input: { path: changed['path'] },
            tool_use_id: changed.tool_use_id,
          },
          { decision: 'allow' },
          active,
        ),
      }));
      await expect(
        runtime.runTool(
          { tool: 'write_file', tool_use_id: 'call-1', path: '/unused' },
          next,
          signal(),
        ),
      ).resolves.toEqual({ result: { decision: 'allow' } });
      expect(next).toHaveBeenCalledOnce();
      const events = logs.map((log) => log.text);
      expect(events.includes('observed:call')).toBe(
        pattern !== 'tool.check' && pattern !== '!tool.call',
      );
      // The registration handling tool.call is an ancestor of its nested check.
      expect(events.includes('observed:check')).toBe(
        pattern === 'tool.check' || pattern === '!tool.call',
      );
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

  it('skips hooks for known Claude Code events it does not run and reports them once', async () => {
    const runtime = await create(`export function register(on) {
      on('prompt.edit', ($, e, next) => next(e));
      on('prompt.edit', {key:'enter'}, ($, e, next) => next(e)).catch(() => ({}));
      on('prompt.*', ($, e, next) => next(e));
      on('!prompt.change', async ($, e, next) => {
        if (e.command === 'hello') $.ui.log('negated:' + next.event);
        return next(e);
      });
      on('classic.Stop', ($, e, next) => next(e));
      on('ui.render', {component:'Spinner'}, ($, e, next) => next(e));
      on('session.start', async ($, e, next) => {
        await $.command.register({name:'hello',description:'Hello'});
        return next(e);
      });
      on('command.run', {command:'hello'}, () => ({text:'still works'}));
    }`);
    expect(logs).toEqual([
      {
        to: 'transcript',
        text: 'Hooks for unsupported events will not run: classic.Stop, prompt.*, prompt.edit, ui.render',
      },
    ]);
    expect(await runtime.runCommand('hello', '', signal())).toBe('still works');
    expect(logs.at(-1)).toEqual({
      to: 'transcript',
      text: 'negated:command.run',
    });
  });

  it('fails initialization for skipped hooks when the plugin opts in', async () => {
    await expect(
      ModRuntime.createGroup(
        [
          {
            id: 'strict',
            name: 'strict',
            options: {},
            unsupportedEvents: 'reject',
            source: {
              root: '/fixture',
              entry: '/fixture/mod.js',
              source: `export function register(on) {
                on('turn.step', ($, e, next) => next(e));
                on('prompt.submit', ($, e, next) => next(e));
                on('session.start', ($, e, next) => next(e));
              }`,
            },
          },
        ],
        '/workspace',
        (log) => logs.push(log),
        signal(),
      ),
    ).rejects.toThrow(
      'Mod strict: Mod events not supported: prompt.submit, turn.step',
    );
    expect(logs).toEqual([]);
  });

  it('answers $.session.version through the API middleware chain', async () => {
    const versionFixture = fixture(
      'return {text: JSON.stringify(await $.session.version())};',
    );
    const runtime = await ModRuntime.createGroup(
      [
        `export function register(on) {
          on('session.version', async ($, e, next) => {
            const answer = await next(e);
            if (next.origin.plugin !== 'mod-1') throw new Error('origin');
            return {value: {...answer.value, version: answer.value.version + '+wrapped'}};
          });
        }`,
        versionFixture,
      ].map((source, index) => ({
        id: `mod-${index}`,
        name: `mod-${index}`,
        source: { root: '/fixture', entry: '/fixture/mod.js', source },
        options: {},
      })),
      '/workspace',
      (log) => logs.push(log),
      signal(),
      undefined,
      null,
      '1.2.3',
    );
    runtimes.push(runtime);
    expect(JSON.parse(await runtime.runCommand('hello', '', signal()))).toEqual(
      {
        version: '1.2.3+wrapped',
        qwen: {
          claudeCode: '2.1.310',
          events: [
            'clock.now',
            'clock.sleep',
            'command.register',
            'command.run',
            'session.cwd',
            'session.end',
            'session.id',
            'session.model',
            'session.root',
            'session.start',
            'session.surface',
            'session.surfaces',
            'session.turns',
            'session.usage',
            'session.version',
            'tool.call',
            'tool.check',
            'turn.abort',
            'turn.complete',
            'turn.start',
            'ui.invalidate',
            'ui.log',
          ],
          methods: [
            'clock.now',
            'clock.sleep',
            'command.register',
            'session.cwd',
            'session.id',
            'session.model',
            'session.root',
            'session.surface',
            'session.surfaces',
            'session.turns',
            'session.usage',
            'session.version',
            'turn.abort',
            'ui.invalidate',
            'ui.log',
            'ui.resolve',
          ],
        },
      },
    );
    const denied = await createTerminal([
      `export function register(on) {
        on('session.version', () => ({deny: 'hidden'}));
      }`,
      fixture(
        'try { await $.session.version(); return {text:"answered"}; } catch (error) { return {text:String(error)}; }',
      ),
    ]);
    expect(await denied.runCommand('hello', '', signal())).toContain('hidden');
  });

  const facts = (changes: Partial<ModSessionFacts> = {}): ModSessionFacts => ({
    id: 'session-1',
    cwd: '/workspace',
    root: '/workspace',
    model: 'qwen-max',
    turns: 2,
    usage: {
      startedAt: 1_000,
      context: { tokens: 300, window: 1_000, percent: 30 },
      rateLimits: [],
    },
    ...changes,
  });
  const createWithFacts = async (
    sources: string[],
    read: () => ModSessionFacts,
  ) => {
    const runtime = await ModRuntime.createGroup(
      sources.map((source, index) => ({
        id: `mod-${index}`,
        name: `mod-${index}`,
        source: {
          root: `/plugins/mod-${index}`,
          entry: `/plugins/mod-${index}/mod.js`,
          source,
        },
        options: {},
      })),
      '/workspace',
      (log) => logs.push(log),
      signal(),
      undefined,
      'terminal',
      '1.2.3',
      read,
    );
    runtimes.push(runtime);
    return runtime;
  };

  it('answers session facts and the plugin identity from each dispatch snapshot', async () => {
    let current = facts();
    const read = vi.fn(() => current);
    const runtime = await createWithFacts(
      [
        `export function register(on) {
          on('session.start', async ($, e, next) => {
            $.ui.log('start model:' + await $.session.model());
            return next(e);
          });
        }`,
        fixture(`return {text: JSON.stringify({
          plugin: JSON.parse(JSON.stringify($.plugin)),
          plain: [String($.plugin), (await Promise.resolve($.plugin)).name, Object.isFrozen($.plugin)],
          id: await $.session.id(),
          cwd: await $.session.cwd(),
          root: await $.session.root(),
          model: await $.session.model(),
          turns: await $.session.turns(),
          surfaces: await $.session.surfaces(),
          surface: await $.session.surface(),
          usage: await $.session.usage({breakdown: 'summary', columns: 80}),
          invalid: await $.session.usage({breakdown: 'detail'}).then(() => 'answered', String),
        })};`),
      ],
      read,
    );
    expect(logs.map((log) => log.text)).toContain('start model:qwen-max');
    expect(JSON.parse(await runtime.runCommand('hello', '', signal()))).toEqual(
      {
        plugin: { name: 'mod-1', root: '/plugins/mod-1' },
        plain: ['[object Object]', 'mod-1', true],
        id: 'session-1',
        cwd: '/workspace',
        root: '/workspace',
        model: 'qwen-max',
        turns: 2,
        surfaces: ['terminal'],
        surface: 'terminal',
        usage: current.usage,
        invalid: expect.stringContaining(
          'Invalid Mod session.usage arguments.',
        ),
      },
    );
    current = facts({ id: 'session-2', turns: 0 });
    expect(
      JSON.parse(await runtime.runCommand('hello', '', signal())),
    ).toMatchObject({ id: 'session-2', turns: 0 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('answers headless defaults when no snapshot is supplied', async () => {
    const runtime = await create(
      fixture(
        'return {text: JSON.stringify([await $.session.surfaces(), await $.session.surface(), await $.session.cwd(), (await $.session.usage()).context])};',
      ),
    );
    expect(JSON.parse(await runtime.runCommand('hello', '', signal()))).toEqual(
      [[], null, '/workspace', { tokens: 0, window: 0 }],
    );
  });

  it('lets another plugin answer, rewrite or deny the session and clock events', async () => {
    const runtime = await createWithFacts(
      [
        `export function register(on) {
          on('clock.now', () => ({value: 42}));
          on('session.model', async ($, e, next) => {
            const answer = await next(e);
            return {value: answer.value + '+seen'};
          });
          on('session.turns', () => ({deny: 'private'}));
          on('session.cwd', () => ({value: 7}));
          on('clock.sleep', ($, e, next) => next({...e, ms: 0}));
        }`,
        fixture(`const started = Date.now();
          await $.clock.sleep(5000);
          return {text: JSON.stringify({
            now: await $.clock.now(),
            model: await $.session.model(),
            turns: await $.session.turns().then(String, String),
            cwd: await $.session.cwd(),
            waited: Date.now() - started,
          })};`),
      ],
      () => facts(),
    );
    const answer = JSON.parse(await runtime.runCommand('hello', '', signal()));
    expect(answer).toMatchObject({
      now: 42,
      model: 'qwen-max+seen',
      turns: expect.stringContaining('private'),
      cwd: '/workspace',
    });
    expect(answer.waited).toBeLessThan(4000);
  });

  it('reads the clock and charges a sleep to the hook that waits', async () => {
    const runtime = await create(
      fixture(`
        if (e.args === 'now') return {text: String(await $.clock.now())};
        if (e.args === 'charge') {
          const before = next.budget.remainingMs;
          await $.clock.sleep(300);
          return {text: String(before - next.budget.remainingMs)};
        }
        if (e.args === 'invalid')
          return {text: await $.clock.sleep(-1).then(String, String) + '|' +
            await $.clock.sleep(1, {timeout: 5}).then(String, String) + '|' +
            await $.clock.sleep(1, {signal: next.signal}).then(() => 'next.signal', String)};
        if (e.args === 'detach') {
          void $.clock.sleep(5000).catch(() => {});
          return {text: 'detached'};
        }
        const listeners = [];
        const signal = {aborted: false, addEventListener: (type, fn) => listeners.push(fn), removeEventListener() {}};
        const waiting = $.clock.sleep(5000, {signal});
        signal.aborted = true;
        for (const listener of listeners) listener();
        return {text: await waiting.then(() => 'slept', () => 'aborted')};
      `),
    );
    const before = Date.now();
    const now = Number(await runtime.runCommand('hello', 'now', signal()));
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(
      Number(await runtime.runCommand('hello', 'charge', signal())),
    ).toBeGreaterThanOrEqual(250);
    expect(await runtime.runCommand('hello', 'invalid', signal())).toMatch(
      /non-negative number of milliseconds.*\|.*Invalid Mod sleep options.*\|next\.signal$/,
    );
    const started = performance.now();
    expect(await runtime.runCommand('hello', 'detach', signal())).toBe(
      'detached',
    );
    expect(await runtime.runCommand('hello', 'abort', signal())).toBe(
      'aborted',
    );
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('times a hook out when its sleep outlasts the remaining budget', async () => {
    const runtime = await create(`export function register(on) {
      on('session.start', async ($, e, next) => {
        await $.command.register({name:'hello',description:'Hello'});
        return next(e);
      });
      on('command.run', async () => { throw new Error('first'); })
        .catch(async ($, e) => {
          // A wait past the timer range would fire at once without the clamp.
          await $.clock.sleep(e.args === 'huge' ? 2 ** 32 : 5000);
          return {text: 'woke'};
        });
    }`);
    for (const args of ['', 'huge']) {
      const started = performance.now();
      await expect(runtime.runCommand('hello', args, signal())).rejects.toThrow(
        'No Mod hook answered /hello',
      );
      expect(performance.now() - started).toBeLessThan(4000);
    }
  });

  it('ends the sleep of a failed hook while its catch recovers', async () => {
    const runtime = await create(`export function register(on) {
      on('session.start', async ($, e, next) => {
        await $.command.register({name:'hello',description:'Hello'});
        return next(e);
      });
      on('command.run', async ($) => {
        globalThis.detached = 'pending';
        void $.clock.sleep(60000).then(
          () => { globalThis.detached = 'slept'; },
          () => { globalThis.detached = 'ended'; },
        );
        await $.clock.now();
        throw new Error('first');
      }).catch(async ($) => {
        await $.clock.sleep(100);
        return {text: globalThis.detached};
      });
    }`);
    expect(await runtime.runCommand('hello', '', signal())).toBe('ended');
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
    [
      'misspelled event',
      "export function register(on) { on('tool.calls', () => ({})); }",
      /event not supported: tool\.calls/,
    ],
    [
      'unknown namespace',
      "export function register(on) { on('models.*', () => ({})); }",
      /event not supported: models\.\*/,
    ],
    [
      'unknown classic event',
      "export function register(on) { on('classic.BeforeRun', () => ({})); }",
      /event not supported: classic\.BeforeRun/,
    ],
    [
      'negated unknown event',
      "export function register(on) { on('!tool.calls', () => ({})); }",
      /event not supported: !tool\.calls/,
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

  const createTurns = async (
    sources: string[],
    abortTurn?: (turnId: string) => void,
  ) => {
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
      '1.2.3',
      undefined,
      abortTurn,
      undefined,
      true,
    );
    runtimes.push(runtime);
    return runtime;
  };
  const turnEnd = {
    answer: 'Done.',
    durationMs: 12,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer' as const,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 0,
      model: 'qwen-max',
    },
  };

  it('carries a prompt and an answer as long as the session lets them be', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('turn.start', ($, e, next) => {
          $.ui.log('start ' + e.text.length + ' ' + e.isTextTruncated);
          return next(e);
        });
        on('turn.complete', ($, e, next) => {
          $.ui.log('complete ' + e.answer.length + ' ' + e.isAnswerTruncated);
          return next(e);
        });
      }`,
    ]);
    // The session fits each text into half a payload, quotes included.
    const text = 'x'.repeat(MOD_MAX_BYTES / 2 - 2);
    await runtime.startTurn(
      { text, turnId: 'turn-1', isTextTruncated: true },
      signal(),
    );
    expect(
      await runtime.completeTurn(
        { ...turnEnd, answer: text, isAnswerTruncated: true },
        signal(),
      ),
    ).toBe(text);
    expect(logs.map((log) => log.text)).toEqual([
      `start ${text.length} true`,
      `complete ${text.length} true`,
    ]);
  });

  it('names the plugins whose hooks hear the turn events', async () => {
    const runtime = await createTurns([
      `export function register(on) { on('turn.start', ($, e, next) => next(e)); }`,
      `export function register(on) { on('turn.*', ($, e, next) => next(e)); }`,
      `export function register(on) { on('!session.*', ($, e, next) => next(e)); }`,
      `export function register(on) { on('tool.call', ($, e, next) => next(e)); }`,
    ]);
    expect(runtime.turnHooks).toEqual({
      start: true,
      complete: ['mod-1', 'mod-2'],
    });
    const none = await createTurns([fixture()]);
    expect(none.turnHooks).toEqual({ start: false, complete: [] });
  });

  it('runs turn.start and turn.complete with pinned input and returns the answer or a text', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('turn.start', async ($, e, next) => {
          const echoed = await next(e);
          $.ui.log('start:' + JSON.stringify(e) + ':' + JSON.stringify(echoed));
          return {turnId: 'ignored'};
        });
        on('turn.complete', async ($, e, next) => {
          $.ui.log('complete:' + JSON.stringify(e));
          try { await next({...e, answer: 'rewritten'}); } catch (error) { $.ui.log(String(error)); }
          return next(e);
        });
      }`,
      `export function register(on) {
        on('turn.complete', {reason: 'answer'}, ($, e) => ({text: 'TL;DR ' + e.answer.length}));
      }`,
    ]);
    const { usage: _usage, ...aborted } = {
      ...turnEnd,
      reason: 'aborted' as const,
      isAborted: true,
    };
    await runtime.startTurn({ text: 'Fix it', turnId: 'turn-1' }, signal());
    expect(await runtime.completeTurn(turnEnd, signal())).toBe('TL;DR 5');
    expect(await runtime.completeTurn(aborted, signal())).toBe('Done.');
    expect(logs.map((log) => log.text)).toEqual([
      'start:{"text":"Fix it","turnId":"turn-1"}:{"turnId":"turn-1"}',
      `complete:${JSON.stringify(turnEnd)}`,
      expect.stringContaining('changed pinned event fields'),
      `complete:${JSON.stringify(aborted)}`,
      expect.stringContaining('changed pinned event fields'),
    ]);
  });

  it('refuses a turn.complete answer of the wrong shape and keeps the answer', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('turn.complete', ($, e) => e.durationMs === 1
          ? {text: 'x', usage: {...e.usage, input_tokens: 1.5}}
          : {text: 7});
      }`,
    ]);
    for (const durationMs of [1, 2])
      expect(
        await runtime.completeTurn({ ...turnEnd, durationMs }, signal()),
      ).toBe('Done.');
  });

  it('asks the host to end the running turn and rejects with its reason', async () => {
    const asked: string[] = [];
    const source = `export function register(on) {
      on('turn.start', async ($, e, next) => {
        const results = [];
        for (const input of [{turnId: e.turnId}, {turnId: 'turn-0'}, {}, 'turn-1']) {
          try { results.push(String(await $.turn.abort(input))); }
          catch (error) { results.push(String(error)); }
        }
        $.ui.log(JSON.stringify(results));
        return next(e);
      });
    }`;
    const runtime = await createTurns([source], (turnId) => {
      asked.push(turnId);
      if (turnId !== 'turn-1')
        throw new Error(`$.turn.abort: ${turnId} is not the running turn`);
    });
    await runtime.startTurn({ text: '', turnId: 'turn-1' }, signal());
    expect(asked).toEqual(['turn-1', 'turn-0']);
    expect(JSON.parse(logs.at(-1)!.text)).toEqual([
      'undefined',
      expect.stringContaining('$.turn.abort: turn-0 is not the running turn'),
      expect.stringContaining('takes { turnId } (the id turn.start carried)'),
      expect.stringContaining('Invalid Mod event input'),
    ]);
    const unhosted = await createTurns([source]);
    await unhosted.startTurn({ text: '', turnId: 'turn-1' }, signal());
    expect(JSON.parse(logs.at(-1)!.text)[0]).toContain(
      '$.turn.abort: no turn is running (asked for turn-1)',
    );
  });

  it('settles a $.turn.abort its own turn ending leaves unanswered', async () => {
    const turn = new AbortController();
    const runtime = await createTurns(
      [
        `let state = 'unasked';
        export function register(on) {
          on('turn.start', async ($, e, next) => {
            state = 'pending';
            await $.turn.abort({turnId: e.turnId}).then(
              () => { state = 'resolved'; },
              (error) => { state = String(error); });
            return next(e);
          });
          on('turn.complete', ($, e) => ({text: state}));
        }`,
      ],
      // As a session does, ending the turn ends the dispatch that asked.
      () => turn.abort(),
    );
    // The answer is lost, so only the dispatch's end can settle the call.
    const post = runtime['post'].bind(runtime);
    vi.spyOn(runtime as never, 'post').mockImplementation(((
      request: Parameters<typeof post>[0],
      root: number,
    ) => {
      if (request.type !== 'turn-abort-result') post(request, root);
    }) as never);
    await runtime
      .startTurn({ text: '', turnId: 'turn-1' }, turn.signal)
      .catch(() => {});
    // The next dispatch runs; the abandoned hook never resumed.
    expect(await runtime.completeTurn(turnEnd, signal())).toBe('pending');
  });

  it('lets another plugin deny or rewrite $.turn.abort', async () => {
    const asked: string[] = [];
    const runtime = await createTurns(
      [
        `export function register(on) {
          on('turn.abort', ($, e, next) =>
            e.turnId === 'keep' ? {deny: 'kept by mod-0'} : next({turnId: e.turnId + '!'}));
        }`,
        `export function register(on) {
          on('turn.start', async ($, e, next) => {
            const results = [];
            for (const turnId of ['keep', 'turn-1'])
              results.push(await $.turn.abort({turnId}).then(String, String));
            $.ui.log(JSON.stringify(results));
            return next(e);
          });
        }`,
      ],
      (turnId) => void asked.push(turnId),
    );
    await runtime.startTurn({ text: '', turnId: 'turn-1' }, signal());
    expect(asked).toEqual(['turn-1!']);
    expect(JSON.parse(logs.at(-1)!.text)).toEqual([
      expect.stringContaining('kept by mod-0'),
      'undefined',
    ]);
  });

  const prompt = {
    text: 'Fix it',
    wait: false,
    origin: { kind: 'composer' as const },
  };

  it('names the plugins whose hooks hear prompt.submit', async () => {
    const runtime = await createTurns([
      `export function register(on) { on('prompt.submit', ($, e, next) => next(e)); }`,
      `export function register(on) { on('turn.start', ($, e, next) => next(e)); }`,
      `export function register(on) { on('prompt.*', ($, e, next) => next(e)); }`,
    ]);
    expect(runtime.promptHooks).toEqual(['mod-0', 'mod-2']);
    expect((await createTurns([fixture()])).promptHooks).toEqual([]);
    // A host that raises no prompt.submit skips its hooks and says so.
    const terminal = await createTerminal([
      `export function register(on) { on('prompt.submit', ($, e, next) => next(e)); }`,
    ]);
    expect(terminal.promptHooks).toEqual([]);
    expect(logs.at(-1)?.text).toBe(
      'Hooks for unsupported events will not run: prompt.submit',
    );
  });

  it('enters the prompt and the context that arrive beneath the hooks', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('prompt.submit', async ($, e, next) => {
          $.ui.log('top:' + JSON.stringify(e));
          const entered = await next({...e, text: e.text + '!', context: ['a']});
          $.ui.log('entered:' + JSON.stringify(entered));
          // What a hook answers after its next resolved changes nothing.
          return {...entered, text: 'later', context: ['late']};
        });
      }`,
      `export function register(on) {
        on('prompt.submit', ($, e, next) =>
          next({...e, text: e.text.toUpperCase(), context: [...e.context, 'b']}));
      }`,
    ]);
    expect(await runtime.submitPrompt(prompt, signal())).toEqual({
      text: 'FIX IT!',
      context: ['a', 'b'],
    });
    expect(logs.map((log) => log.text)).toEqual([
      'top:{"text":"Fix it","wait":false,"origin":{"kind":"composer"}}',
      'entered:{"text":"FIX IT!","context":["a","b"],"origin":{"kind":"composer"}}',
    ]);
  });

  it('drops a prompt for a hook, and for one that does not pass it on', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('prompt.submit', async ($, e, next) => {
          if (e.text === 'answer') return {text: 'mine'};
          const below = await next(e);
          $.ui.log('below:' + JSON.stringify(below));
          return below;
        });
      }`,
      `export function register(on) {
        on('prompt.submit', ($, e, next) =>
          e.text.includes('secret') ? {drop: 'it holds a secret'} : next(e));
      }`,
    ]);
    expect(
      await runtime.submitPrompt({ ...prompt, text: 'a secret' }, signal()),
    ).toEqual({ drop: 'it holds a secret', byHook: true });
    expect(
      await runtime.submitPrompt({ ...prompt, text: 'answer' }, signal()),
    ).toEqual({
      drop: 'a hook answered without passing the prompt on',
      byHook: false,
    });
    expect(logs.map((log) => log.text)).toEqual([
      'below:{"drop":"it holds a secret"}',
    ]);
  });

  it.each([false, true])(
    'retains a downstream drop after a text answer (same plugin: %s)',
    async (samePlugin) => {
      const handlers = [
        `on('prompt.submit', async ($, e, next) => {
          await next(e);
          return {text: e.text};
        });`,
        `on('prompt.*', () => ({drop: 'secret guard'}));`,
      ];
      const runtime = await createTurns(
        (samePlugin ? [handlers.join('\n')] : handlers).map(
          (handler) => `export function register(on) { ${handler} }`,
        ),
      );

      expect(await runtime.submitPrompt(prompt, signal())).toEqual({
        drop: 'secret guard',
        byHook: true,
      });
      expect(logs).toEqual([]);
    },
  );

  it.each([false, true])(
    'retains a downstream drop after a catch answers (next already called: %s)',
    async (called) => {
      const runtime = await createTurns([
        `export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            ${called ? 'await next(e);' : ''}
            throw new Error('broken');
          }).catch(async ($, e, next) => {
            if (!next.called) await next(e);
            return {text: e.text};
          });
        }`,
        `export function register(on) {
          on('prompt.submit', () => ({drop: 'secret guard'}));
        }`,
      ]);

      expect(await runtime.submitPrompt(prompt, signal())).toEqual({
        drop: 'secret guard',
        byHook: true,
      });
      expect(logs).toEqual([]);
    },
  );

  it.each([false, true])(
    'retains the downstream outcome when rejecting a late drop (same plugin: %s)',
    async (samePlugin) => {
      const handlers = [
        `on('prompt.submit', async ($, e, next) => {
          await next(e);
          return {drop: 'too late'};
        });`,
        `on('prompt.*', ($, e) =>
          e.text === 'drop' ? {drop: 'secret guard'} : {text: 'held'});`,
      ];
      const runtime = await createTurns(
        (samePlugin ? [handlers.join('\n')] : handlers).map(
          (handler) => `export function register(on) { ${handler} }`,
        ),
      );

      expect(
        await runtime.submitPrompt({ ...prompt, text: 'drop' }, signal()),
      ).toEqual({ drop: 'secret guard', byHook: true });
      expect(
        await runtime.submitPrompt({ ...prompt, text: 'answer' }, signal()),
      ).toEqual({
        drop: 'a hook answered without passing the prompt on',
        byHook: false,
      });
      expect(logs.map((log) => log.text)).toEqual([
        expect.stringContaining('a drop after its next(e) was answered'),
        expect.stringContaining('a drop after its next(e) was answered'),
      ]);
    },
  );

  it.each([false, true])(
    'retains the latest local next after catching a late drop (first reaches host: %s)',
    async (reachesHost) => {
      const runtime = await createTurns([
        `export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            try { await next({...e, text: 'first'}); }
            catch (error) { $.ui.log(error.message); }
            return next({...e, text: 'second'});
          });
          on('prompt.*', async ($, e, next) => {
            const below = await next(e);
            return e.text === 'first' ? {drop: 'too late'} : below;
          });
          on('*', {text: /^(first|second)$/}, ($, e, next) => {
            $.ui.log('guard:' + e.text);
            ${reachesHost ? "if (e.text === 'first') return next(e);" : ''}
            return {drop: e.text + ' guard'};
          });
        }`,
      ]);

      expect(await runtime.submitPrompt(prompt, signal())).toEqual({
        drop: 'second guard',
        byHook: true,
      });
      expect(logs.map((log) => log.text)).toEqual([
        'guard:first',
        'a drop after its next(e) was answered',
        'guard:second',
      ]);
    },
  );

  it('keeps next.called false for a late drop within one plugin', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('prompt.submit', async ($, e, next) => {
          await next(e);
          return {drop: 'too late'};
        }).catch(($, e, next) => {
          $.ui.log('called:' + next.called);
          return {text: e.text};
        });
        on('prompt.*', () => ({drop: 'secret guard'}));
      }`,
    ]);

    expect(await runtime.submitPrompt(prompt, signal())).toEqual({
      drop: 'a hook answered without passing the prompt on',
      byHook: false,
    });
    expect(logs.map((log) => log.text)).toEqual(['called:false']);
  });

  it('skips a hook that fails, drops after its next or changes what is pinned', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('prompt.submit', async ($, e, next) => {
          if (e.text === 'late') { await next(e); return {drop: 'too late'}; }
          if (e.text === 'origin') return next({...e, origin: {kind: 'sdk'}});
          if (e.text === 'wait') return next({...e, wait: true});
          if (e.text === 'context') return next({...e, context: 'one'});
          if (e.text === 'answer') return {text: 'x', origin: {kind: 'sdk'}};
          throw new Error('broken');
        });
      }`,
    ]);
    const texts = ['late', 'origin', 'wait', 'context', 'answer', 'other'];
    const entered = [];
    for (const text of texts)
      entered.push(await runtime.submitPrompt({ ...prompt, text }, signal()));
    expect(entered).toEqual(texts.map((text) => ({ text })));
    expect(logs.map((log) => log.text)).toEqual([
      expect.stringContaining('a drop after its next(e) was answered'),
      ...Array.from({ length: 3 }, () =>
        expect.stringContaining('origin, wait and turnId are pinned'),
      ),
      expect.stringContaining('Unsupported prompt.submit result fields'),
      expect.stringContaining('broken'),
    ]);
  });

  it('lets a .catch drop a prompt its failed guard never passed on', async () => {
    const runtime = await createTurns([
      `export function register(on) {
        on('prompt.submit', () => { throw new Error('broken'); })
          .catch(($, e, next) => next.called ? next(e) : {drop: 'no'});
      }`,
    ]);
    expect(await runtime.submitPrompt(prompt, signal())).toEqual({
      drop: 'no',
      byHook: true,
    });
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
