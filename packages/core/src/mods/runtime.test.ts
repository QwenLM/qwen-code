/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ModRuntime } from './runtime.js';
import type { ModLog } from './types.js';

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
  const create = async (source = fixture(), abort = signal()) => {
    const runtime = await ModRuntime.create(
      source,
      '/workspace',
      (log) => logs.push(log),
      abort,
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
      /imports are not supported/,
    ],
    [
      'unknown event',
      "export function register(on) { on('tool.call', () => ({})); }",
      /event not supported/,
    ],
    [
      'unsupported catch',
      "export function register(on) { on('session.start',($,e,next)=>next(e)).catch(()=>({})); }",
      /registration.catch is not supported/,
    ],
    [
      'unknown API',
      fixture('return await $.process.run({command:"echo no"});'),
      /API not supported/,
    ],
    [
      'invalid result',
      fixture('return undefined;'),
      /Unsupported command.run result/,
    ],
    [
      'unsupported context',
      fixture('return {text:"a",context:["hidden"]};'),
      /Unsupported command.run result/,
    ],
    [
      'event mutation',
      fixture('e.origin.kind = "composer"; return {text:"bad"};'),
      /read.only|not.*writable|not configurable/i,
    ],
    ['undefined next', fixture('return next();'), /pinned event fields/],
    [
      'foreign command',
      fixture().replace("{command:'hello'}", "{command:'status'}"),
      /own registered commands/,
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
      const runtime = await create(fixture(body));
      const started = Date.now();
      await expect(
        runtime.runCommand('hello', '', AbortSignal.timeout(100)),
      ).rejects.toThrow(/cancelled/);
      expect(Date.now() - started).toBeLessThan(3000);
      await expect(runtime.runCommand('hello', '', signal())).rejects.toThrow(
        /cancelled/,
      );
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

  it('bounds logs and applies a whole session.end timeout', async () => {
    const noisy = await create(
      fixture(
        "for (let i=0;i<1000;i++) $.ui.log('x'.repeat(1000)); return {};",
      ),
    );
    await expect(noisy.runCommand('hello', '', signal())).rejects.toThrow(
      /log budget/,
    );
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
